# Contributing to YTSpoofingStream

Thank you for your interest in contributing to **YTSpoofingStream**! We welcome bug reports, feature requests, documentation improvements, and code contributions from developers of all skill levels.

Please take a moment to review this document before submitting contributions.

---

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior via [GitHub Security Advisories](https://github.com/alithw/YTSpoofingStream/security/advisories) or directly to the project maintainer.

---

## Getting Started

### Prerequisites
- Google Chrome, Microsoft Edge, Brave, or any Chromium-based browser supporting **Manifest V3**.
- Basic understanding of JavaScript (ES6+), Chrome Extension APIs (Manifest V3, Declarative Net Request), and HTML5 Media Elements.
- Git installed on your system.

### Local Development Setup

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/<your-username>/YTSpoofingStream.git
   cd YTSpoofingStream
   ```

2. **Load the Unpacked Extension in Chrome**:
   - Open your Chromium browser and navigate to `chrome://extensions/`.
   - Enable **Developer mode** via the toggle in the top-right corner.
   - Click **Load unpacked** and select the root directory of this repository (`YTSpoofingStream`).

3. **Reloading After Code Changes**:
   - For changes to `popup.html`, `popup.js`: Close and reopen the popup.
   - For changes to `inject.js`, `bridge.js`: Refresh the YouTube page (`Ctrl+F5` or `Cmd+Shift+R`).
   - For changes to `background.js`, `manifest.json`: Click the refresh/reload icon on the extension card in `chrome://extensions/`.

---

## Project Architecture & Codebase Map

YTSpoofingStream is built using **pure vanilla JavaScript (ES6+)** without bundlers or external dependencies, ensuring maximum performance, transparency, and auditability.

```
YTSpoofingStream/
├── manifest.json          # Extension manifest (MV3), host permissions & DNR declarations
├── background.js          # MV3 Service Worker: InnerTube resolver & DNR ruleset manager
├── inject.js              # MAIN world script: Dual-stream player engine & clock sync
├── bridge.js              # ISOLATED world bridge: Relays messages between inject.js & background
├── ytm_harvester_cs.js    # MAIN world script inside harvester iframe: Extracts 774 streams
├── harvester.html/.js     # Headless harvester frame container
├── popup.html/.js         # Popup configuration UI & status monitor
└── logo.svg, icon*.png    # Extension branding assets
```

### Core Components
- **`background.js`**: Manages client profiles (`ANDROID_MUSIC`, `TVHTML5`, `WEB_REMIX`), dynamically updates `chrome.declarativeNetRequest` session rules to bypass CORS/origin checks, and processes stream decipher requests.
- **`inject.js`**: Injected into the page's MAIN execution world. Implements the **Studio 774 Dual-Stream Engine**, silences the native video player using descriptor routing (`HTMLMediaElement.prototype.volume`), creates the parallel `<audio>` engine, and maintains bit-perfect 1.0x master clock alignment.
- **`ytm_harvester_cs.js`**: Operates in an isolated background subframe pointing to YouTube Music, intercepting `ytInitialPlayerResponse` and `/player` API calls under an active Premium session to extract unthrottled ITAG 774 Opus URLs.

---

## Coding Guidelines

1. **Zero External Dependencies**: Keep the codebase pure vanilla ES6+. Do not introduce npm packages, bundlers (Webpack, Vite, Rollup), or framework bloat unless explicitly discussed in an issue first.
2. **Preserve Descriptor Volume Routing**: Do not set `video.muted = true` directly on native video elements. Native video silencing must strictly go through `HTMLMediaElement.prototype.volume` descriptor calls to avoid breaking YouTube's volume UI and localStorage preferences.
3. **Master Clock Integrity**: The `<audio>` engine serves as the master clock. Never modify its playback rate away from 1.0x or introduce resampling filters. Video must always synchronize to audio, not vice-versa.
4. **Safety & Fallback**: If an authentic ITAG 774 stream is unavailable for a given video, the extension must gracefully cancel spoofing and allow native playback (ITAG 251) without crashing the player.

---

## Reporting Issues

Before opening a new issue:
- Check existing [GitHub Issues](https://github.com/alithw/YTSpoofingStream/issues) to see if the problem or feature has already been discussed.
- Make sure you are running the latest release.
- Test with other extensions (especially adblockers or user-script managers) temporarily disabled to rule out third-party script conflicts.

When reporting a bug, please use our **[Bug Report Template](https://github.com/alithw/YTSpoofingStream/issues/new?template=bug_report.yml)** and include:
- The YouTube video URL / ID where the problem occurred.
- The active operation mode (`HYBRID_HQ`, `YTM_HARVESTER`, `TV_HEADLESS`).
- HUD badge status (`★ 774`, `251`, or missing).
- Browser name and version.
- Any relevant errors from the DevTools Console (`F12` -> Console tab).

---

## Submitting Pull Requests

1. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Commit Conventions**:
   Follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` A new feature or capability
   - `fix:` A bug fix
   - `docs:` Documentation changes only
   - `refactor:` Code restructuring without behavioral changes
   - `chore:` Maintenance tasks or repo configuration

3. **Verify Your Changes**:
   - [ ] Verified video plays cleanly with audio on standard YouTube (`www.youtube.com`).
   - [ ] Verified no fatal player errors (`s:80` or `s:49`).
   - [ ] Tested seeking and fast-forwarding to ensure no audio buffer stutter.
   - [ ] Tested switching tabs (Alt+Tab / background tab) to ensure audio-video synchronization remains tight (<15ms).
   - [ ] Verified non-774 videos fall back safely to 251 without errors.

4. **Submit the PR**:
   - Push your branch to GitHub and open a Pull Request targeting `main`.
   - Fill out the provided [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).
