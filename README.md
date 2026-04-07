# P2P Chat & File Share
No servers. No signaling. Just direct P2P over Yggdrasil.


## What
Android app for chat + file sharing. Connects directly to peers using Yggdrasil IPv6 addresses. No central anything.

Yes, Android hates P2P. No, I didn't care.

## How
Install Yggdrasil from F-Droid

Turn on "Block connections without VPN"

Share your 200: address

Paste a peer's address. Connect. Done.

(Your normal internet dies while using this. You're in **__the mesh__**.)

## Build It Yourself

```
git clone Bhoopesh/p2p-sovereign-nexus
npm install 
eas build --platform android
```

EAS configs included for GitHub Actions. APK release soon.


## Quirks (Not Bugs, Just Vibes)

- **Keyboard covers IP input field** - The React Native keyboard module fought me and won. Use floating keyboard or add your peer addresses before typing your novel.

- **Requires Yggdrasil with "Block connections without VPN" enabled** - Your normal internet will stop working while using the app. This is a feature (digital minimalist mode).

- **Manual peer entry only** - No phone book. No central server. Exchange Yggdrasil addresses like secret agents.

- **File sharing works but don't send a 4K movie** - I haven't tested the limits. This is for fun, not for replacing your cloud storage.
