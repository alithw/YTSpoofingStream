## Description

Briefly describe the intent and technical details of this pull request.

Fixes #(issue)

---

## Type of Change

Please mark the option that applies:

- [ ] 🐛 Bug fix (non-breaking change fixing an issue)
- [ ] ✨ New feature (non-breaking change adding functionality)
- [ ] 🚀 Performance / Synchronization improvement
- [ ] 📝 Documentation update (README, Guides, etc.)
- [ ] 🧹 Code refactoring / Cleanup (no behavioral changes)
- [ ] 🔒 Security fix

---

## Technical Details & Architecture Impact

- **Components Modified**: `inject.js`, `background.js`, `bridge.js`, `ytm_harvester_cs.js`, `popup.*`, `manifest.json`
- **Audio Routing Check**: Does this change preserve `HTMLMediaElement.prototype.volume` descriptor-level routing?
- **Master Clock Sync Check**: Does this change maintain bit-perfect 1.0x master clock alignment on `<audio>`?

---

## Verification Checklist

Please verify that your changes pass the following manual checks:

- [ ] Extension loads without warnings in `chrome://extensions/` (Manifest V3).
- [ ] Tested audio playback on standard YouTube (`www.youtube.com`).
- [ ] Verified unthrottled ITAG 774 playback on supported tracks (`★ 774` badge visible in player controls).
- [ ] Tested video seeking/scrubbing to ensure no audio buffer stalls or stutters.
- [ ] Tested background tab switching (Alt+Tab) to verify audio-video sync (<15ms drift).
- [ ] Tested non-774 tracks to confirm graceful fallback to native 251 without `s:80` or `s:49` player errors.
- [ ] No extraneous `console.log` statements left behind.
- [ ] Updated `README.md` or `README-vi.md` if user-facing behavior changed.
