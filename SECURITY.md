# Security Policy

## Supported Versions

Only the latest release of YTSpoofingStream receives security updates and patches.

| Version | Supported |
|---|---|
| >= 0.1.5 | :white_check_mark: |
| < 0.1.5 | :x: |

---

## Security Model & Privacy Guarantee

YTSpoofingStream operates under strict security and privacy standards:

1. **Zero External Telemetry**: The extension does **not** collect, store, or transmit any personal data, usage statistics, analytics, or browsing history to any external server.
2. **Local Credential Handling**: All authentication tokens, cookies, and session headers remain strictly within your local browser storage (`chrome.storage.local`) and native browser cookie jars. No credentials are ever sent to third-party domains.
3. **Declarative Net Request (DNR) Isolation**: Network modifications are scoped exclusively to official YouTube domains (`*.youtube.com`, `*.googlevideo.com`). No rules apply to any other websites or web traffic.
4. **Manifest V3 Architecture**: Built entirely on Chrome's Manifest V3 platform with no arbitrary remote code execution (`unsafe-eval` is never used).

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in YTSpoofingStream, please report it responsibly rather than opening a public issue.

### Preferred Method
Please report security vulnerabilities confidentially through **[GitHub Private Vulnerability Reporting](https://github.com/alithw/YTSpoofingStream/security/advisories/new)**. This ensures that sensitive details are shared directly with the project maintainer in an encrypted, private channel without exposing personal contact details.

### What to Include
Please provide as much information as possible to help us reproduce and address the issue:
- Type of vulnerability (e.g. cross-site scripting, privilege escalation, credential leakage).
- Detailed steps to reproduce the issue.
- Proof of Concept (PoC) code or demonstration, if available.
- Affected browser versions and operating systems.

### Response Timeline
- **Initial Acknowledgement**: Within 48 hours of receiving the report.
- **Triage & Status Update**: Within 5 business days.
- **Fix & Public Release**: As promptly as possible depending on the severity of the issue.

Thank you for helping keep YTSpoofingStream and its users secure!
