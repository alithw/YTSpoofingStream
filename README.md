<div align="center">
  <img src="logo.svg" alt="YTSpoofingStream Logo" width="128" height="128">
  <h1>YTSpoofingStream</h1>
</div>

> **Warning for Non-Premium Users**
> This extension is designed **exclusively for users who already have an active YouTube Premium subscription**. If you do not have YouTube Premium, the internal API requests will likely be rejected or rate-limited by YouTube, resulting in significant playback slowdowns, endless buffering, or "Video unavailable" errors. **Please do not use this extension if you are not a Premium member.**

*Read this in other languages: [Tiếng Việt](README-vi.md).*

---

## 📑 Table of Contents
- [Why this extension?](#-why-this-extension)
- [Key Features](#-key-features)
- [Technical Architecture & Deep Dive](#-technical-architecture--deep-dive)
- [Installation](#-installation)
- [⚠️ Known Limitations](#️-known-limitations)
- [Reporting Issues & Troubleshooting](#-reporting-issues--troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

A powerful and lightweight Chrome extension that forces YouTube's web player to serve high-fidelity Premium audio streams (like 256kbps AAC or 300+ kbps Opus) by spoofing client requests to YouTube's internal APIs (Android, iOS, TVHTML5, and Web Remix).

## 🌟 Why this extension?

Recently, YouTube has restricted high-quality audio streams (like ITAG 141 for 256kbps AAC and ITAG 774 for high-bitrate Opus) to Premium users on specific clients only. The standard web player often falls back to lower quality audio (ITAG 251 at 160kbps or ITAG 140 at 128kbps) even if you are a paying Premium member. 

YTSpoofingStream acts as a transparent bridge. It securely requests the premium formats using spoofed user agents in the background, bypassing the web player's artificial limitations, and injects the high-fidelity audio streams directly into your current video session.

## ✨ Key Features

- **Unlock Premium Audio**: Enjoy crystal-clear audio by forcing YouTube to serve high-bitrate audio formats (ITAG 141, 774) normally hidden from the web player.
- **Multi-Client Spoofing Engine**: Seamlessly switches between various YouTube internal clients (WEB_REMIX, ANDROID, IOS, TVHTML5) to hunt down the best available audio format for every video.
- **BotGuard & poToken Bypass**: Automatically extracts and injects `poToken` and `visitorData` from the live webpage to pass YouTube's strict anti-bot mechanisms, eliminating "Video unavailable" errors on modern clients.
- **Vevo & Official Music Video Support**: Seamlessly processes encrypted `signatureCipher` streams. Premium audio works perfectly even on copyrighted music videos.
- **Manifest V3 Native**: Built entirely on Manifest V3. Intercepts API requests and modifies headers (`Origin`, `User-Agent`) silently using Chrome's native `declarativeNetRequest` API. Zero performance penalty.
- **Intelligent Pre-warm & Sync**: Caches HQ formats asynchronously during Single Page Application (SPA) navigation (like clicking a video in the sidebar) and auto-reloads the player precisely when ready. Zero network delays.
- **Stats for Nerds Dashboard**: A live, beautiful popup dashboard displaying detailed logs, injected streams, active audio methods, and real-time spoofing status.

## 🧠 Technical Architecture & Deep Dive

Building this extension required bypassing several complex security and state-management mechanisms within YouTube's modern Single Page Application (SPA).

### 1. The Interception Layer
YouTube delivers its video data (`streamingData`) through three different avenues depending on the navigation state:
- `window.ytInitialPlayerResponse` (embedded in HTML for direct visits).
- `window.ytplayer.config.args.raw_player_response` (legacy/fallback configuration).
- `window.fetch` (used by the SPA router when navigating between videos).

This extension injects a content script (`inject.js`) at `document_start` to intercept all three. We use `Object.defineProperty` to hook into global variables before YouTube's own scripts even boot up. When the SPA router fetches data, we intercept the Promise, parse the JSON, inject our custom formats, and repackage it into a `new Response()`.

### 2. Multi-Client Spoofing & BotGuard Bypass
To get the high-quality formats, the Content Script delegates network requests to the Background Service Worker via Message Passing. The SW then queries the `/youtubei/v1/player` endpoint using multiple custom payloads representing different clients.
- **BotGuard Bypass:** YouTube recently enforced `poToken` (Proof of Origin) verification for API requests. We actively intercept the web player's outgoing requests to extract the live `poToken`, `signatureTimestamp`, and `visitorData`, and tunnel them into our SW payload to perfectly mimic the authorized session.
- **Header Spoofing:** We dynamically register `declarativeNetRequest` session rules to spoof `User-Agent`, `Origin`, and `Referer` headers for background requests.

### 3. Overcoming "The Stubborn Player" (State Corruption & Auto-play policies)
One of the biggest challenges was making the YouTube HTML5 player accept the injected formats smoothly:
- **ITAG Disguise (Format Spoofing):** The standard web player will crash ("Format Error") if it receives an unknown ITAG like `774`. To bypass this, we "disguise" the 774 stream's ITAG to `251` (and adjust its `mimeType`), tricking the player into thinking it's playing standard Opus, while actually streaming the 300+ kbps Premium source.
- **Vevo & signatureCipher:** Copyrighted music videos don't use direct URLs; they use a heavily encrypted `signatureCipher`. Our injection logic deliberately preserves the cipher intact, allowing the web player's native `base.js` to automatically decrypt our injected premium formats alongside original ones.
- **SPA Autoplay Freezes & Pre-warming:** Instead of blindly reloading the player on SPA navigation (which triggers Chrome's strict Autoplay block policies), we listen to `yt-navigate-start` to "pre-warm" the HQ formats in the background. Once the formats are secured, we trigger an immediate targeted player upgrade (`loadVideoById` / `updateVideoData`), completely avoiding page reloads and ensuring seamless playback.

## 🚀 Installation

Since this extension interacts with internal YouTube APIs, it is currently not available on the Chrome Web Store. You can install it easily via Developer Mode:

1. Download the latest release from the repository or clone it using `git clone`.
2. Extract the files to a folder on your computer.
3. Open Google Chrome and navigate to `chrome://extensions/`.
4. Enable **Developer mode** using the toggle in the top right corner.
5. Click **Load unpacked** and select the folder containing this extension's files (where `manifest.json` is located).
6. Open YouTube, ensure you are logged into your Premium account, and enjoy the high-fidelity sound!

## ⚠️ Known Limitations

> [!CAUTION]
> **YouTube Music (`music.youtube.com`) is not supported.**
> When this extension is active, `music.youtube.com` may behave erratically — songs in the playback queue can skip or jump unexpectedly due to the extension intercepting background pre-fetch requests. If you want to use YouTube Music normally, **please disable the extension first**.

| Platform | Status |
|---|---|
| `youtube.com` | ✅ Fully supported |
| `music.youtube.com` | ❌ Disable the extension before use |

---

## 🐞 Reporting Issues & Troubleshooting

If you encounter any bugs, such as "Video unavailable" errors, infinite buffering, or missing audio, please open an issue in the GitHub repository. To help us debug faster, please provide:
- The Video URL.
- A screenshot of the extension's Popup (showing the `Active Audio` and `Client Stats` logs).
- Confirmation that you are logged into an active YouTube Premium account.

## 🤝 Contributing

We welcome contributions from the community! If you have ideas to improve spoofing methods, bypass new restrictions, or optimize the caching engine:

1. Fork the project.
2. Create a new branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
