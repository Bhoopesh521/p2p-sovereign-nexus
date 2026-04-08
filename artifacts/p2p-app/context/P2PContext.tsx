import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import TcpSocket from "react-native-tcp-socket";

export type ConnectionStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "error";

export interface Peer {
  id: string;
  label: string;
  host: string;
  port: number;
  status: ConnectionStatus;
  lastSeen?: number;
}

export type MessageType = "text" | "file" | "file_chunk" | "file_end" | "ping" | "pong";

export interface P2PMessage {
  id: string;
  type: MessageType;
  from: string;
  fromPort?: number;
  to?: string;
  text?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  chunkIndex?: number;
  totalChunks?: number;
  data?: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  peerId: string;
  direction: "in" | "out";
  type: "text" | "file";
  text?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  fileData?: string;
  timestamp: number;
  status: "sending" | "sent" | "received";
}

export interface FileTransfer {
  id: string;
  peerId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  direction: "in" | "out";
  progress: number;
  status: "transferring" | "done" | "error";
  fileData?: string;
  chunks: string[];
  totalChunks: number;
  receivedChunks: number;
}

interface P2PContextValue {
  myPort: number;
  setMyPort: (port: number) => void;
  peers: Peer[];
  addPeer: (label: string, host: string, port: number) => void;
  removePeer: (id: string) => void;
  connectToPeer: (peerId: string) => void;
  disconnectPeer: (peerId: string) => void;
  sendTextMessage: (peerId: string, text: string) => void;
  sendFile: (peerId: string, fileName: string, fileSize: number, fileType: string, fileData: string) => void;
  messages: Record<string, ChatMessage[]>;
  transfers: FileTransfer[];
  serverRunning: boolean;
}

const P2PContext = createContext<P2PContextValue | null>(null);

const STORAGE_KEY_PEERS = "p2p_peers";
const STORAGE_KEY_PORT = "p2p_my_port";
const STORAGE_KEY_MY_ID = "p2p_my_id";
const DEFAULT_PORT = 9876;
const CHUNK_SIZE = 32768;

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

function normalizeHost(host: string): string {
  let h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase().trim();
  // Unwrap IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.1 → 192.168.1.1)
  // so that a peer added as an IPv4 address matches correctly when the OS
  // reports the remote address in IPv4-mapped form after binding to ::
  const ipv4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4mapped) h = ipv4mapped[1];
  return h;
}

type AnySocket = ReturnType<typeof TcpSocket.createConnection>;

export function P2PProvider({ children }: { children: React.ReactNode }) {
  const [myPort, setMyPortState] = useState<number>(DEFAULT_PORT);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [serverRunning, setServerRunning] = useState(false);

  const serverRef = useRef<ReturnType<typeof TcpSocket.createServer> | null>(null);

  // Outbound sockets (connections we initiated), keyed by peerId
  const socketsRef = useRef<Record<string, AnySocket>>({});
  // Inbound sockets (connections they initiated), keyed by peerId once identified,
  // or by a temporary socketKey while still unidentified
  const inboundSocketsRef = useRef<Record<string, AnySocket>>({});

  const bufferRef = useRef<Record<string, string>>({});
  const pendingTransfersRef = useRef<Record<string, FileTransfer>>({});

  // Refs that mirror state so callbacks don't go stale
  const myPortRef = useRef<number>(DEFAULT_PORT);
  const myIdRef = useRef<string>("");
  const peersRef = useRef<Peer[]>([]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    myPortRef.current = myPort;
  }, [myPort]);

  useEffect(() => {
    loadStoredData();
    return () => {
      stopServer();
      Object.values(socketsRef.current).forEach((s) => {
        try { s.destroy(); } catch (_) {}
      });
      Object.values(inboundSocketsRef.current).forEach((s) => {
        try { s.destroy(); } catch (_) {}
      });
    };
  }, []);

  const loadStoredData = async () => {
    try {
      const [peersStr, portStr, myIdStr] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_PEERS),
        AsyncStorage.getItem(STORAGE_KEY_PORT),
        AsyncStorage.getItem(STORAGE_KEY_MY_ID),
      ]);
      if (peersStr) {
        const stored: Peer[] = JSON.parse(peersStr);
        const reset = stored.map((p) => ({ ...p, status: "offline" as const }));
        setPeers(reset);
        peersRef.current = reset;
      }
      if (portStr) {
        const port = parseInt(portStr, 10);
        setMyPortState(port);
        myPortRef.current = port;
      }
      let id = myIdStr;
      if (!id) {
        id = makeId();
        await AsyncStorage.setItem(STORAGE_KEY_MY_ID, id);
      }
      myIdRef.current = id;
    } catch (_) {}
  };

  const savePeers = useCallback(async (updated: Peer[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY_PEERS, JSON.stringify(updated));
    } catch (_) {}
  }, []);

  const stopServer = () => {
    if (serverRef.current) {
      try { serverRef.current.close(); } catch (_) {}
      serverRef.current = null;
      setServerRunning(false);
    }
  };

  // Returns the socket for a peer regardless of whether the connection is
  // outbound (we called them) or inbound (they called us).
  const getSocket = useCallback((peerId: string): AnySocket | null => {
    return socketsRef.current[peerId] || inboundSocketsRef.current[peerId] || null;
  }, []);

  const processMessage = useCallback((msg: P2PMessage, resolvedPeerId: string) => {
    if (msg.type === "ping") {
      const replySocket = socketsRef.current[resolvedPeerId] || inboundSocketsRef.current[resolvedPeerId];
      if (replySocket) {
        const pong: P2PMessage = {
          id: makeId(),
          type: "pong",
          from: myIdRef.current,
          fromPort: myPortRef.current,
          timestamp: Date.now(),
        };
        try { replySocket.write(JSON.stringify(pong) + "\n"); } catch (_) {}
      }
      setPeers((prev) =>
        prev.map((p) =>
          p.id === resolvedPeerId ? { ...p, status: "connected", lastSeen: Date.now() } : p
        )
      );
      return;
    }

    if (msg.type === "pong") {
      setPeers((prev) =>
        prev.map((p) =>
          p.id === resolvedPeerId ? { ...p, status: "connected", lastSeen: Date.now() } : p
        )
      );
      return;
    }

    if (msg.type === "text") {
      const chatMsg: ChatMessage = {
        id: msg.id,
        peerId: resolvedPeerId,
        direction: "in",
        type: "text",
        text: msg.text,
        timestamp: msg.timestamp,
        status: "received",
      };
      setMessages((prev) => ({
        ...prev,
        [resolvedPeerId]: [...(prev[resolvedPeerId] || []), chatMsg],
      }));
      return;
    }

    if (msg.type === "file") {
      const transfer: FileTransfer = {
        id: msg.id,
        peerId: resolvedPeerId,
        fileName: msg.fileName!,
        fileSize: msg.fileSize!,
        fileType: msg.fileType!,
        direction: "in",
        progress: 0,
        status: "transferring",
        chunks: [],
        totalChunks: msg.totalChunks!,
        receivedChunks: 0,
      };
      pendingTransfersRef.current[msg.id] = transfer;
      setTransfers((prev) => [...prev, transfer]);
      return;
    }

    if (msg.type === "file_chunk") {
      const t = pendingTransfersRef.current[msg.id];
      if (!t) return;
      t.chunks[msg.chunkIndex!] = msg.data!;
      t.receivedChunks += 1;
      t.progress = t.receivedChunks / t.totalChunks;
      setTransfers((prev) =>
        prev.map((x) => (x.id === msg.id ? { ...x, progress: t.progress, receivedChunks: t.receivedChunks } : x))
      );
      return;
    }

    if (msg.type === "file_end") {
      const t = pendingTransfersRef.current[msg.id];
      if (!t) return;
      const fileData = t.chunks.join("");
      t.status = "done";
      t.progress = 1;
      t.fileData = fileData;
      delete pendingTransfersRef.current[msg.id];
      setTransfers((prev) =>
        prev.map((x) => (x.id === msg.id ? { ...t, fileData } : x))
      );
      const chatMsg: ChatMessage = {
        id: makeId(),
        peerId: resolvedPeerId,
        direction: "in",
        type: "file",
        fileName: t.fileName,
        fileSize: t.fileSize,
        fileType: t.fileType,
        fileData,
        timestamp: msg.timestamp,
        status: "received",
      };
      setMessages((prev) => ({
        ...prev,
        [resolvedPeerId]: [...(prev[resolvedPeerId] || []), chatMsg],
      }));
    }
  }, []);

  const startServer = useCallback((port: number) => {
    if (serverRef.current) return;
    try {
      const server = TcpSocket.createServer((socket) => {
        const socketKey = `inbound_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        inboundSocketsRef.current[socketKey] = socket as any;

        // Starts as a temporary key, gets replaced with peerId once the remote
        // identifies themselves via a ping containing their listening port.
        let resolvedKey = socketKey;

        socket.on("data", (data) => {
          const str = typeof data === "string" ? data : (data as Buffer).toString("utf8");
          bufferRef.current[resolvedKey] = (bufferRef.current[resolvedKey] || "") + str;
          const lines = bufferRef.current[resolvedKey].split("\n");
          bufferRef.current[resolvedKey] = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg: P2PMessage = JSON.parse(line);

              // If still unidentified and the message carries fromPort, try to
              // match against known peers by host + listening port.
              if (resolvedKey === socketKey && msg.fromPort != null) {
                const remoteAddr = (socket as any).remoteAddress as string | undefined;
                const matched = peersRef.current.find((p) => {
                  if (p.port !== msg.fromPort) return false;
                  if (!remoteAddr) return true;
                  return normalizeHost(p.host) === normalizeHost(remoteAddr);
                });
                if (matched) {
                  // Migrate buffer and socket reference to the real peer ID
                  bufferRef.current[matched.id] = bufferRef.current[resolvedKey] || "";
                  delete bufferRef.current[resolvedKey];
                  inboundSocketsRef.current[matched.id] = inboundSocketsRef.current[socketKey];
                  delete inboundSocketsRef.current[socketKey];
                  resolvedKey = matched.id;
                }
              }

              processMessage(msg, resolvedKey);
            } catch (_) {}
          }
        });

        socket.on("close", () => {
          delete inboundSocketsRef.current[resolvedKey];
          delete bufferRef.current[resolvedKey];
          // If we identified the peer, mark them offline
          const isRealPeer = peersRef.current.some((p) => p.id === resolvedKey);
          if (isRealPeer) {
            setPeers((prev) =>
              prev.map((p) =>
                p.id === resolvedKey && p.status === "connected"
                  ? { ...p, status: "offline" }
                  : p
              )
            );
          }
        });

        socket.on("error", () => {
          delete inboundSocketsRef.current[resolvedKey];
          delete bufferRef.current[resolvedKey];
        });
      });

      // Bind to :: (all interfaces, IPv4 + IPv6) so Yggdrasil TUN connections
      // and regular LAN/WiFi connections are both accepted on the same socket.
      // When bound to ::, the OS reports IPv4 peers as ::ffff:x.x.x.x which
      // normalizeHost() unwraps back to plain IPv4 for peer matching.
      server.listen({ port, host: "::" }, () => {
        setServerRunning(true);
      });

      server.on("error", () => {
        setServerRunning(false);
        serverRef.current = null;
      });

      serverRef.current = server;
    } catch (_) {
      setServerRunning(false);
    }
  }, [processMessage]);

  useEffect(() => {
    startServer(myPort);
  }, []);

  const setMyPort = useCallback((port: number) => {
    setMyPortState(port);
    myPortRef.current = port;
    AsyncStorage.setItem(STORAGE_KEY_PORT, port.toString());
    stopServer();
    // Give the OS time to fully release the port before rebinding
    setTimeout(() => startServer(port), 800);
  }, [startServer]);

  const addPeer = useCallback(
    (label: string, host: string, port: number) => {
      const id = makeId();
      const peer: Peer = { id, label, host, port, status: "offline" };
      setPeers((prev) => {
        const updated = [...prev, peer];
        savePeers(updated);
        return updated;
      });
    },
    [savePeers]
  );

  const removePeer = useCallback(
    (id: string) => {
      try {
        socketsRef.current[id]?.destroy();
        delete socketsRef.current[id];
      } catch (_) {}
      try {
        inboundSocketsRef.current[id]?.destroy();
        delete inboundSocketsRef.current[id];
      } catch (_) {}
      delete bufferRef.current[id];
      setPeers((prev) => {
        const updated = prev.filter((p) => p.id !== id);
        savePeers(updated);
        return updated;
      });
    },
    [savePeers]
  );

  const connectToPeer = useCallback(
    (peerId: string) => {
      const peer = peersRef.current.find((p) => p.id === peerId);
      if (!peer) return;

      if (socketsRef.current[peerId]) {
        try { socketsRef.current[peerId].destroy(); } catch (_) {}
        delete socketsRef.current[peerId];
      }

      setPeers((prev) =>
        prev.map((p) => (p.id === peerId ? { ...p, status: "connecting" } : p))
      );

      const isIPv6 = peer.host.includes(":");
      const options: any = {
        port: peer.port,
        host: peer.host,
        // Use the correct wildcard address for the IP family we're dialing
        localAddress: isIPv6 ? "::" : "0.0.0.0",
      };

      try {
        const socket = TcpSocket.createConnection(options, () => {
          setPeers((prev) =>
            prev.map((p) =>
              p.id === peerId
                ? { ...p, status: "connected", lastSeen: Date.now() }
                : p
            )
          );
          // Identify ourselves to the remote side by sending our stable device ID
          // and our listening port so they can match us to their peer list.
          const ping: P2PMessage = {
            id: makeId(),
            type: "ping",
            from: myIdRef.current,
            fromPort: myPortRef.current,
            timestamp: Date.now(),
          };
          try { socket.write(JSON.stringify(ping) + "\n"); } catch (_) {}
        });

        socket.on("data", (data) => {
          const str = typeof data === "string" ? data : (data as Buffer).toString("utf8");
          bufferRef.current[peerId] = (bufferRef.current[peerId] || "") + str;
          const lines = bufferRef.current[peerId].split("\n");
          bufferRef.current[peerId] = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg: P2PMessage = JSON.parse(line);
              processMessage(msg, peerId);
            } catch (_) {}
          }
        });

        socket.on("error", () => {
          setPeers((prev) =>
            prev.map((p) => (p.id === peerId ? { ...p, status: "error" } : p))
          );
          delete socketsRef.current[peerId];
        });

        socket.on("close", () => {
          setPeers((prev) =>
            prev.map((p) =>
              p.id === peerId && p.status === "connected"
                ? { ...p, status: "offline" }
                : p
            )
          );
          delete socketsRef.current[peerId];
        });

        socketsRef.current[peerId] = socket;
      } catch (_) {
        setPeers((prev) =>
          prev.map((p) => (p.id === peerId ? { ...p, status: "error" } : p))
        );
      }
    },
    [processMessage]
  );

  const disconnectPeer = useCallback((peerId: string) => {
    try {
      socketsRef.current[peerId]?.destroy();
      delete socketsRef.current[peerId];
    } catch (_) {}
    try {
      inboundSocketsRef.current[peerId]?.destroy();
      delete inboundSocketsRef.current[peerId];
    } catch (_) {}
    setPeers((prev) =>
      prev.map((p) => (p.id === peerId ? { ...p, status: "offline" } : p))
    );
  }, []);

  const sendTextMessage = useCallback(
    (peerId: string, text: string) => {
      const socket = getSocket(peerId);
      if (!socket) return;
      const id = makeId();
      const msg: P2PMessage = {
        id,
        type: "text",
        from: myIdRef.current,
        text,
        timestamp: Date.now(),
      };
      try {
        socket.write(JSON.stringify(msg) + "\n");
        const chatMsg: ChatMessage = {
          id,
          peerId,
          direction: "out",
          type: "text",
          text,
          timestamp: msg.timestamp,
          status: "sent",
        };
        setMessages((prev) => ({
          ...prev,
          [peerId]: [...(prev[peerId] || []), chatMsg],
        }));
      } catch (_) {}
    },
    [getSocket]
  );

  const sendFile = useCallback(
    (
      peerId: string,
      fileName: string,
      fileSize: number,
      fileType: string,
      fileData: string
    ) => {
      const socket = getSocket(peerId);
      if (!socket) return;

      const id = makeId();
      const totalChunks = Math.ceil(fileData.length / CHUNK_SIZE);

      const header: P2PMessage = {
        id,
        type: "file",
        from: myIdRef.current,
        fileName,
        fileSize,
        fileType,
        totalChunks,
        timestamp: Date.now(),
      };

      const transfer: FileTransfer = {
        id,
        peerId,
        fileName,
        fileSize,
        fileType,
        direction: "out",
        progress: 0,
        status: "transferring",
        chunks: [],
        totalChunks,
        receivedChunks: 0,
      };
      setTransfers((prev) => [...prev, transfer]);

      try {
        socket.write(JSON.stringify(header) + "\n");

        let index = 0;
        const sendNextChunk = () => {
          if (index >= totalChunks) {
            const end: P2PMessage = {
              id,
              type: "file_end",
              from: myIdRef.current,
              timestamp: Date.now(),
            };
            socket.write(JSON.stringify(end) + "\n");
            setTransfers((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, status: "done", progress: 1 } : t
              )
            );
            const chatMsg: ChatMessage = {
              id: makeId(),
              peerId,
              direction: "out",
              type: "file",
              fileName,
              fileSize,
              fileType,
              fileData,
              timestamp: Date.now(),
              status: "sent",
            };
            setMessages((prev) => ({
              ...prev,
              [peerId]: [...(prev[peerId] || []), chatMsg],
            }));
            return;
          }

          const chunk = fileData.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
          const chunkMsg: P2PMessage = {
            id,
            type: "file_chunk",
            from: myIdRef.current,
            chunkIndex: index,
            totalChunks,
            data: chunk,
            timestamp: Date.now(),
          };
          socket.write(JSON.stringify(chunkMsg) + "\n");
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, progress: (index + 1) / totalChunks }
                : t
            )
          );
          index++;
          setTimeout(sendNextChunk, 0);
        };

        sendNextChunk();
      } catch (_) {
        setTransfers((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "error" } : t))
        );
      }
    },
    [getSocket]
  );

  return (
    <P2PContext.Provider
      value={{
        myPort,
        setMyPort,
        peers,
        addPeer,
        removePeer,
        connectToPeer,
        disconnectPeer,
        sendTextMessage,
        sendFile,
        messages,
        transfers,
        serverRunning,
      }}
    >
      {children}
    </P2PContext.Provider>
  );
}

export function useP2P() {
  const ctx = useContext(P2PContext);
  if (!ctx) throw new Error("useP2P must be used within P2PProvider");
  return ctx;
}
