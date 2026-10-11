<div align="center">
  <img src="assets/logo.svg" alt="YTSpoofingStream Logo" width="128" height="128">
  <h1>YTSpoofingStream</h1>
  <p><b>Kích Hoạt 100% Luồng Âm Thanh Studio Opus 774 Chuẩn Phòng Thu Trên Trình Duyệt YouTube</b></p>

  <p>
    <a href="https://github.com/alithw/YTSpoofingStream/releases"><img src="https://img.shields.io/badge/release-v0.2.2-blue.svg?style=flat-square" alt="Phiên bản Mới nhất"></a>
    <img src="https://img.shields.io/badge/manifest-v3-green.svg?style=flat-square" alt="Manifest V3">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square" alt="Giấy phép Apache 2.0">
    <img src="https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-lightgrey?style=flat-square" alt="Nền tảng hỗ trợ">
    <a href=".github/CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="Đóng góp vào dự án"></a>
    <a href=".github/CODE_OF_CONDUCT.md"><img src="https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg?style=flat-square" alt="Quy tắc ứng xử"></a>
    <a href=".github/SECURITY.md"><img src="https://img.shields.io/badge/security-policy-blueviolet.svg?style=flat-square" alt="Chính sách bảo mật"></a>
    <a href="https://github.com/sponsors/alithw"><img src="https://img.shields.io/badge/T%C3%A0i%20tr%E1%BB%A3-GitHub%20Sponsors-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors"></a>
    <a href="https://ko-fi.com/alithw"><img src="https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  </p>
</div>

> [!TIP]
> **Trải nghiệm âm nhạc tốt hơn?** Nếu tiện ích giúp bạn có trải nghiệm nghe nhạc tuyệt vời hơn trên YouTube, hãy cho mình xin 1 sao (⭐ **Star**) trên [GitHub](https://github.com/alithw/YTSpoofingStream) để ủng hộ dự án nhé!

> [!IMPORTANT]
> **KHUYẾN NGHỊ: CẬP NHẬT LÊN PHIÊN BẢN [v0.2.2](https://github.com/alithw/YTSpoofingStream/releases/tag/v0.2.2)**  
> **v0.2.2** hiện là phiên bản ổn định chính thức với bộ giải mã trực tiếp **Direct TV UMP-to-MSE Demuxer (`UmpMseController774`)**, cơ chế tự động chuyển luồng dự phòng thông minh ở chế độ Hybrid, và khóa chống tự tắt tiếng / chống nhảy ngược nhạc. Vui lòng xem [**Ghi chú Phát hành (Release Notes)**](https://github.com/alithw/YTSpoofingStream/releases/tag/v0.2.2) hoặc [**xem nhanh các điểm mới nổi bật bên dưới**](#recent-updates).

> [!WARNING]
> **Yêu cầu: Tài khoản YouTube Premium đang hoạt động**
> Tiện ích mở rộng này được thiết kế chuyên biệt cho người dùng sở hữu tài khoản **YouTube Premium**. Các máy chủ nội bộ của YouTube chỉ cung cấp luồng Opus bitrate cao chuẩn phòng thu (`ITAG 774`, ~256k–301kbps, dải tần >20.000 Hz) cho các phiên đăng nhập Premium đã xác thực.

> [!IMPORTANT]
> **Xác thực Smart TV (TVHTML5)**:
> Để mở khóa luồng Direct TV UMP-to-MSE Opus 774 với độ trễ bằng không và tốn 0MB RAM iframe trên mọi thể loại video (bao gồm cả nhạc cover, live session và video UGC không có trên YouTube Music), hãy đăng nhập tại mục **TVHTML5** trong popup:
> 1. Mở popup extension và nhấn nút đăng nhập **TVHTML5**.
> 2. Đảm bảo đăng nhập đúng tài khoản Google có YouTube Premium.
> 3. Sau khi xác thực, chế độ `HYBRID_HQ` và `TV_HEADLESS` sẽ tự động ưu tiên giải mã trực tiếp luồng TV UMP 774!

*Đọc bằng ngôn ngữ khác: [English](README.md).*

---

## 📑 Mục lục
- [✨ Điểm nổi bật trong bản cập nhật gần đây (v0.2.2)](#recent-updates)
- [🌟 Tại sao bạn cần YTSpoofingStream?](#-tại-sao-bạn-cần-ytspoofingstream)
- [🧠 Kiến trúc Hệ thống (v0.2.2)](#-kiến-trúc-hệ-thống-v022)
  - [1. Cấu trúc Thư mục & Mã nguồn](#1-cấu-trúc-thư-mục--mã-nguồn)
  - [2. Nền tảng SABR / UMP của YouTube & Vì sao phương pháp cũ thất bại](#2-nền-tảng-sabr--ump-của-youtube--vì-sao-phương-pháp-cũ-thất-bại)
  - [3. Quy trình Thu hoạch & Giải mã Luồng Kép 774 (`UmpMseController774` + `YTM_HARVESTER`)](#3-quy-trình-thu-hoạch--giải-mã-luồng-kép-774-umpmsecontroller774--ytm_harvester)
  - [4. Tắt tiếng Tầng Descriptor Phần cứng & Cơ chế Chống Tự Tắt Tiếng (Anti-Mute Guard)](#4-tắt-tiếng-tầng-descriptor-phần-cứng--cơ-chế-chống-tự-tắt-tiếng-anti-mute-guard)
  - [5. Đồng bộ Chuẩn Master Clock 1.0x & Chống Nhảy Nhạc Khi Trình Duyệt Lag](#5-đồng-bộ-chuẩn-master-clock-10x--chống-nhảy-nhạc-khi-trình-duyệt-lag)
- [🎛️ 3 Chế độ Hoạt động](#️-3-chế-độ-hoạt-động)
- [📊 Kết quả Đo lường Phổ âm Toàn bài hát (FFT Spectrum)](#-kết-quả-đo-lường-phổ-âm-toàn-bài-hát-fft-spectrum)
- [🚀 Hướng dẫn Cài đặt](#-hướng-dẫn-cài-đặt)
- [🌐 Hỗ trợ Đa Ngôn Ngữ & Hướng dẫn Đóng góp Bản dịch](#-hỗ-trợ-đa-ngôn-ngữ--hướng-dẫn-đóng-góp-bản-dịch)
- [⚙️ Cấu hình & Điều khiển](#️-cấu-hình--điều-khiển)
- [🐞 Xử lý Sự cố & Câu hỏi Thường gặp](#-xử-lý-sự-cố--câu-hỏi-thường-gặp)
- [💖 Ủng Hộ & Tài Trợ Dự Án](#-ủng-hộ--tài-trợ-dự-án)
- [🤝 Đóng góp & Cộng đồng (Contributing)](#-đóng-góp--cộng-đồng-contributing)
- [⚠️ Tuyên bố Từ chối Trách nhiệm (Disclaimer)](#️-tuyên-bố-từ-chối-trách-nhiệm-disclaimer)
- [📄 Giấy phép (License)](#-giấy-phép-license)

---

<a id="recent-updates"></a>
## ✨ Điểm nổi bật trong bản cập nhật gần đây (v0.2.2)

Bản cập nhật **v0.2.2** nâng cấp toàn diện kiến trúc giải mã luồng TV và Hybrid, đồng thời xử lý triệt để các lỗi chuyển bài trong danh sách phát:

- ⚡ **Bộ Giải mã Trực tiếp TV UMP-to-MSE (`UmpMseController774`)**: Thay thế hoàn toàn cơ chế iframe TV ngầm cũ bằng bộ bóc tách luồng nhị phân UMP/SABR trực tiếp ngay trên trang (`Part 20 MEDIA_HEADER`, `Part 21 MEDIA`, `Part 22 MEDIA_END`), đẩy thẳng các phân đoạn `audio/webm; codecs="opus"` vào `MediaSource` (`SourceBuffer`) với **0 MB RAM iframe phụ** và tốc độ khởi chạy dưới 1 giây.
- 🧠 **Ưu tiên Thông minh & Tự động Dự phòng ở Chế độ Hybrid (`HYBRID_HQ`)**: Tự động ưu tiên luồng **Direct TV UMP MSE 774** khi đã liên kết tài khoản `TVHTML5`, đồng thời tự động chuyển tiếp (failover) mượt mà sang **YTM Harvester** nếu bài hát không có luồng 774 trên TV hoặc bị giới hạn client.
- 🔇 **Khóa Chống Tự Tắt Tiếng (UI Anti-Mute Guard khi chuyển `774` ↔ `251`)**: Khắc phục triệt để lỗi khi chuyển từ bài hát hỗ trợ `★ 774` sang video không có 774 (`251`) khiến nút loa trên giao diện YouTube tự động bị khóa Mute cho đến khi F5. Sự kiện `volumechange` nội bộ khi đóng/ngắt phần cứng nay được cách ly hoàn toàn khỏi `yt-player-volume` của YouTube.
- ⏱️ **Đồng bộ Master Clock Chống Lag & Chống Tự Tua Lại**: Ngăn chặn hành vi tự nhảy lùi thời gian (`timeJump < -0.25s`) của trình phát YouTube SPA khi mới chuyển bài, đồng thời bổ sung bộ lọc độ trễ (`video.readyState` + kiểm tra vùng đệm) giúp âm thanh phát liền mạch không bao giờ bị vấp hay nhảy ngược khi trình duyệt/thiết bị lag.
- 🗂️ **Chuẩn hóa Cấu trúc Mã nguồn**: Tổ chức lại cây thư mục gọn gàng theo chuẩn (`src/`, `assets/`, `locales/`, `.github/`) và dọn sạch toàn bộ cảnh báo runtime của tiện ích.

---

## 🌟 Tại sao bạn cần YTSpoofingStream?

Trên hệ sinh thái YouTube hiện nay, chất lượng âm thanh bị phân tầng nghiêm ngặt:
- **YouTube Web thông thường (`www.youtube.com`)**: Giới hạn âm thanh ở mức bitrate thấp (**ITAG 251** Opus ~145–160kbps bị cắt phẳng dải tần cao ở 15–16kHz, hoặc **ITAG 140** AAC ~128kbps), **kể cả đối với tài khoản trả phí YouTube Premium**.
- **YouTube Music Bản Web (`music.youtube.com`)**: Dù là dịch vụ âm nhạc chuyên dụng, **phiên bản Web của YouTube Music chỉ hỗ trợ tối đa luồng AAC 141 (~256kbps)** và **hoàn toàn không phân phối luồng Opus 774 trên trình duyệt máy tính**.
- **Nơi duy nhất YouTube phân phối luồng Opus 774**: Luồng âm thanh chuẩn phòng thu cao cấp nhất (**ITAG 774** Opus ~256k–301kbps với phổ âm đầy đủ vượt 20.000 Hz) chỉ được cấp độc quyền cho ứng dụng YouTube Music di động (Android/iOS) và thiết bị Smart TV Living Room (`TVHTML5`).

### ❓ Làm thế nào YTSpoofingStream mở khóa luồng ITAG 774 trên trình duyệt máy tính?
1. **Giải mã trực tiếp luồng TVHTML5 UMP/SABR**: Truy vấn trực tiếp máy chủ InnerTube `TVHTML5` bằng token OAuth2 TV Premium của bạn, đàm phán luồng `ITAG 774` qua giao thức nhị phân SABR/UMP của Google Video, và bóc tách trực tiếp các gói Opus vào bộ đệm `MediaSource` ngay trên trang.
2. **Thu hoạch Phiên Xác thực YouTube Music (YTM Harvester)**: Khi người dùng chưa đăng nhập TVHTML5 hoặc với các bản thu độc quyền trên YTM, khung offscreen cô lập sẽ truy vấn endpoint nội bộ của YouTube Music kèm bộ quy tắc DNR giả lập thiết bị để trích xuất URL HTTPS **Opus 774** trực tiếp.
3. **Động cơ Đồng bộ Luồng Kép (`StudioEngine774`)**: Phát luồng âm thanh Opus 774 chuẩn phòng thu qua kênh âm thanh độc lập trong khi ngắt tiếng của video gốc ở tầng descriptor phần cứng trình duyệt, giữ nguyên chất lượng hình ảnh 4K/1080p và mọi nút điều khiển trên giao diện YouTube.

---

## 🧠 Kiến trúc Hệ thống (v0.2.2)

### 1. Cấu trúc Thư mục & Mã nguồn
YTSpoofingStream được xây dựng bằng **100% JavaScript thuần (Vanilla ES6+)**—không dùng bundler, không thư viện ngoài hay mã thực thi từ xa—đảm bảo hiệu năng tối đa, minh bạch và dễ kiểm toán:

```text
YTSpoofingStream/
├── manifest.json               # Cấu hình Manifest V3, quyền hạn & khai báo content scripts
├── src/
│   ├── background.js           # MV3 Service Worker: Bộ phân giải InnerTube TV/YTM, OAuth2 & DNR
│   ├── inject.js               # Nhân MAIN world: StudioEngine774, UmpMseController774, HUD & đồng bộ
│   ├── bridge.js               # Cầu nối ISOLATED world: Chuyển tiếp thông điệp (MAIN <-> SW)
│   ├── ytm_harvester_cs.js     # Script MAIN world bên trong khung offscreen YTM Harvester
│   ├── harvester.html / .js    # Khung tài liệu Offscreen phục vụ YTM Harvester
│   └── popup.html / .js        # Giao diện cấu hình Popup, bảng đo trạng thái & bộ điều khiển đa ngôn ngữ
├── assets/
│   └── logo.svg, icon*.png     # Bộ nhận diện thương hiệu & biểu tượng thanh công cụ
├── locales/
│   └── en, vi, ja, ru, zh-cn, zh-tw  # Từ điển đa ngôn ngữ tích hợp & file mẫu dịch thuật (template.json)
└── .github/
    └── CONTRIBUTING.md, ...    # Hướng dẫn đóng góp, chính sách bảo mật & mẫu báo lỗi
```

### 2. Nền tảng SABR / UMP của YouTube & Vì sao phương pháp cũ thất bại
Trình phát YouTube máy tính hiện đại đã chuyển hoàn toàn sang giao thức truyền phát nhị phân **SABR (Server-side Adaptive Bitrate) / UMP (Unified Media Protocol)** của Google:
- Phản hồi `/youtubei/v1/player` trên trình duyệt không còn trả về đường link trực tiếp trong `adaptiveFormats`. Thay vào đó, dữ liệu video và audio được đóng gói nhị phân và đẩy qua `serverAbrStreamingUrl`, bị khóa cứng ở chuẩn `ITAG 251` (~160kbps Opus) trên web.
- **Vì sao cách ghi đè format cũ thất bại**:
  1. Xóa bỏ `serverAbrStreamingUrl` sẽ kích hoạt lỗi trình phát nghiêm trọng mã `s:80` (`HTML5_NO_AVAILABLE_FORMATS_FALLBACK`).
  2. Tiêm trực tiếp URL của TV/Android vào trình phát mặc định sẽ gây lỗi bảo mật CORS và lệch chữ ký token mã `s:49` (`poToken` / `cplatform`).

### 3. Quy trình Thu hoạch & Giải mã Luồng Kép 774 (`UmpMseController774` + `YTM_HARVESTER`)
Để đạt độ ổn định tuyệt đối không bao giờ gây lỗi trình phát mà vẫn phát đúng luồng `ITAG 774` nguyên bản, **YTSpoofingStream v0.2.2** tách biệt hoàn toàn luồng hiển thị hình ảnh và luồng thu nhận âm thanh phòng thu thông qua 2 động cơ chuyên biệt:

```mermaid
flowchart TD
    A["Mở Video / Chuyển bài YouTube SPA"] --> B["Nhân MAIN World (src/inject.js)"]
    B -->|"Giữ nguyên luồng hình ảnh"| C["Trình phát YouTube Gốc (Video: 4K/1080p)"]
    B -->|"RESOLVE_VIDEO (src/bridge.js)"| D["Service Worker (src/background.js)"]

    D -->|"Động cơ A: Đã liên kết TV (100ms Cache / 1.5s Live)"| E["TVHTML5 InnerTube (/player)"]
    E -->|"SABR URL + Cấu hình UMP"| F["UmpMseController774 (Giải mã UMP Trực tiếp)"]
    F -->|"Part 20/21/22 WebM Opus"| G["MediaSource SourceBuffer (0MB RAM Iframe)"]

    D -->|"Động cơ B: YTM Harvester (Dự phòng hoặc Chế độ YTM)"| H["Khung Offscreen YTM (src/ytm_harvester_cs.js)"]
    H -->|"URL HTTPS ITAG 774 Trực tiếp"| I["Luồng HTML5 Trực tiếp"]

    G --> J["StudioEngine774 (Master Clock <audio>)"]
    I --> J
    J -->|"HTMLMediaElement.prototype.volume = 0"| K["Tắt tiếng Video Gốc ở Tầng Phần cứng"]
    J -->|"Bit-Perfect 1.0x Studio Opus 774 (>20kHz)"| L["Đầu ra Loa / Tai nghe / DAC"]
    C -.->|"Đồng bộ Khung hình Chống Lag"| J
```

1. **Động cơ A — Bộ Giải mã Trực tiếp TV UMP-to-MSE (`UmpMseController774`)**:
   - Sử dụng token OAuth2 `TVHTML5` trong [`src/background.js`](file:///c:/Code/Personal/YTSpoofingStream/src/background.js) để lấy cấu hình `/player` của Smart TV (`100ms` nếu đã có cache làm nóng trước, tối đa `1500ms` cho truy vấn mạng trực tiếp).
   - Đóng gói payload nhị phân Protobuf `VideoPlaybackAbrRequest` ghim cố định vào `ITAG 774` (`rn`, `rbuf`, `ClientAbrState`, `FormatId`) và nhận luồng phản hồi từ Google Video CDN.
   - Phân tích cấu trúc khung nhị phân UMP theo thời gian thực ngay trong [`src/inject.js`](file:///c:/Code/Personal/YTSpoofingStream/src/inject.js) (`Part 20 MEDIA_HEADER`, `Part 21 MEDIA`, `Part 22 MEDIA_END`, `Part 35 NEXT_REQUEST_POLICY`, `Part 43 SABR_REDIRECT`, `Part 58 STREAM_PROTECTION_STATUS`) và nạp trực tiếp các phân đoạn WebM/Opus vào `MediaSource` `SourceBuffer` kèm cơ chế tự động giải phóng bộ nhớ đệm (sliding-window eviction).
2. **Động cơ B — Bộ Thu hoạch Offscreen YouTube Music (`YTM_HARVESTER`)**:
   - Hoạt động trong tài liệu offscreen nhẹ ([`src/harvester.html`](file:///c:/Code/Personal/YTSpoofingStream/src/harvester.html) + [`src/ytm_harvester_cs.js`](file:///c:/Code/Personal/YTSpoofingStream/src/ytm_harvester_cs.js)) kết hợp quy tắc mạng Declarative Net Request (DNR) để trích xuất URL HTTPS `ITAG 774` trực tiếp từ phiên YouTube Music Premium.
   - Đóng vai trò là động cơ chính trong chế độ `YTM_HARVESTER`, đồng thời là động cơ dự phòng tự động tức thì cho chế độ `HYBRID_HQ`.

### 4. Tắt tiếng Tầng Descriptor Phần cứng & Cơ chế Chống Tự Tắt Tiếng (Anti-Mute Guard)
Nếu gán trực tiếp `video.muted = true` hoặc `video.volume = 0` qua thuộc tính DOM thông thường, trình duyệt sẽ bắn sự kiện `volumechange`, khiến trình phát YouTube hiểu nhầm là người dùng vừa tắt tiếng, hiển thị biểu tượng loa gạch chéo và lưu trạng thái `"muted": true` vào `localStorage['yt-player-volume']`.

**YTSpoofingStream v0.2.2** giải quyết triệt để thông qua cơ chế bảo vệ 2 lớp trong [`src/inject.js`](file:///c:/Code/Personal/YTSpoofingStream/src/inject.js):
1. **Định tuyến Descriptor Nguyên mẫu**: Gọi trực tiếp setter gốc `HTMLMediaElement.prototype.volume` (`descVolume.set.call(video, 0)`) để hạ âm lượng phần cứng của thẻ `<video>` về `0`, trong khi ghi đè getter để giao diện YouTube luôn đọc đúng mức âm lượng mà người dùng thiết lập.
2. **Lá chắn Chống Tự Tắt Tiếng Khi Chuyển Bài**: Chặn toàn bộ các sự kiện `volumechange` nội bộ phát sinh trong quá trình đóng/mở âm lượng phần cứng (`_suppressNextVolumeEvent`) và chủ động khôi phục trạng thái unmute khi chuyển từ bài hát `★ 774` sang các video `251` không có 774 (`fallbackTo251()`), đảm bảo giao diện không bao giờ bị kẹt nút Mute.

### 5. Đồng bộ Chuẩn Master Clock 1.0x & Chống Nhảy Nhạc Khi Trình Duyệt Lag
`StudioEngine774` lấy luồng âm thanh `<audio>` làm đồng hồ chuẩn (Master Clock) xuyên suốt quá trình phát:
- **Giữ nguyên bản 100% tốc độ 1.0x**: `audio.playbackRate` khóa cứng theo `video.playbackRate` (`1.0x`), tuyệt đối không dùng thuật toán co giãn tốc độ `0.99x`/`1.01x` gây méo tiếng hay biến dạng cao độ.
- **Khóa Chống Tự Tua Ngược Khi Chuyển Bài SPA**: Bỏ qua các lệnh tự seek lùi nội bộ của YouTube (`timeJump < -0.25s`) trong `1500ms` đầu tiên khi mới chuyển bài hoặc khi `video.currentTime < 1.5s`, chấm dứt hiện tượng nhạc đang phát giây đầu bị khựng và nhảy lại từ đầu.
- **Căn chỉnh Khung hình Chống Lag**: Khi chuyển tab hoặc khi trình duyệt/GPU bị lag làm rớt khung hình video, luồng âm thanh 774 vẫn tiếp tục phát mượt mà không bị ngắt quãng. Chỉ khi bộ giải mã video đã nạp đủ bộ đệm (`video.readyState >= 3`), đồng hồ hình ảnh mới nhẹ nhàng nhảy tiến lên khớp với `audio.currentTime` (ngưỡng lệch `> 0.35s` kèm chu kỳ nghỉ `2.5s`).

---

## 🎛️ 3 Chế độ Hoạt động

| Chế độ | Tên hiển thị | Động cơ thu nhận chính | Cơ chế Dự phòng / Fallback | Phù hợp nhất |
|---|---|---|---|---|
| **`HYBRID_HQ`** *(Khuyên dùng)* | **Chế độ: Hỗn hợp Hybrid (774 Opus ★)** | **Direct TV UMP-to-MSE 774** (khi đã liên kết TV) + **YTM Harvester** | Tự động chuyển sang YTM Harvester nếu TV không có 774; về luồng gốc `251` nếu cả hai đều không có 774 | Nghe nhạc & xem YouTube hàng ngày, danh sách phát, MV & nhạc cover |
| **`YTM_HARVESTER`** | **Chỉ YTM Harvester (774 Opus ★)** | Luồng HTTPS 774 trực tiếp từ YouTube Music Offscreen Harvester | Tự động về luồng gốc `251` nếu bài hát không có trên YTM | Các bài hát chính thức trên YouTube Music (không cần đăng nhập TV) |
| **`TV_HEADLESS`** | **Chỉ Smart TV UMP (774 Opus ★)** | Giải mã trực tiếp luồng `TVHTML5` UMP/SABR 774 qua `MediaSource` (0MB RAM iframe) | Tự động về luồng gốc `251` nếu chưa đăng nhập TV hoặc video không có 774 | Phát nhạc độ trễ bằng 0, tốn ít RAM nhất, bản cover, live session & video UGC |

> [!NOTE]
> **Đặc tính mức âm lượng (YouTube Music vs YouTube thông thường)**:  
> Các luồng âm thanh được thu hoạch từ **YouTube Music (`YTM_HARVESTER`)** thường có mức âm lượng cảm nhận (perceived loudness) lớn hơn so với âm thanh video YouTube thông thường khoảng **+3dB đến +6dB** do các bản thu trên YouTube Music áp dụng tiêu chuẩn mastering và chuẩn hóa âm lượng riêng cho dịch vụ stream nhạc.

---

## 📊 Kết quả Đo lường Phổ âm Toàn bài hát (FFT Spectrum)

Kết quả kiểm thử thực tế thời gian thực 100% thời lượng trên 4 bài hát tiêu chuẩn: khi **Bật extension (Studio 774)** so với khi **Tắt cứng extension trong Cài đặt Chrome (Luồng Gốc)**:

| Bài hát | Video ID | Thời lượng đo | Khi Tắt Extension (Luồng Gốc) | Khi Bật YTSpoofingStream v0.2.2 (774) | Dải tần cao (>16kHz - 22kHz) |
|---|---|---|---|---|---|
| **Track 1 (Song to the Mirrored Moon)** | `MI4I7v-0tnc` | 211.7s (100%) | ITAG 251 (~155kbps) | **ITAG 774 (301kbps)** | **Hoạt động mạnh (>20.000 Hz)** |
| **Track 2 (Kirara Magic - Sunny Rain)** | `Xy6sPZc0CKA` | 184.2s (100%) | ITAG 251 (~160kbps) | **ITAG 774 (280kbps)** | **Hoạt động mạnh (>20.500 Hz)** |
| **Track 3 (Fontaine)** | `tiulg9ySfR8` | 185.0s (100%) | ITAG 251 (~160kbps) | **ITAG 774 (280kbps)** | **Hoạt động mạnh (>21.000 Hz)** |
| **Track 4 (Dazbee - Chidori Cover)** | `fs_pEYuMZio` | 224.5s (100%) | ITAG 251 (~155kbps) | **ITAG 774 (280kbps)** | **Hoạt động mạnh (>20.000 Hz)** |

*Nhận xét*: Luồng ITAG 251 tiêu chuẩn bị cắt phẳng dải tần (brickwall filter) ở 15.5kHz–16kHz. Luồng 774 trên YTSpoofingStream v0.2.2 duy trì mật độ phổ âm thanh liên tục lên tới trên 21kHz, mang lại âm trường rộng và chi tiết tiếng treble/cymbal/vocal sắc nét vượt trội.

---

## 🚀 Hướng dẫn Cài đặt
 
### Trình duyệt Chromium (Google Chrome, Brave, Edge, Cốc Cốc, Opera)
1. Tải hoặc clone mã nguồn về máy tính:
   - **Dành cho người dùng phổ thông (không cần dùng Git)**:  
     Nhấn vào nút **Code** màu xanh lá ở phía trên trang GitHub này rồi chọn **Download ZIP** (hoặc truy cập mục [Releases](https://github.com/alithw/YTSpoofingStream/releases), kéo xuống dưới cùng của bản phát hành mới nhất tại mục *Assets* và tải file `Source code (zip)`). Sau đó, giải nén file ZIP vào một thư mục trên máy tính.
   - **Dành cho nhà phát triển (sử dụng Git)**:
     ```bash
     git clone https://github.com/alithw/YTSpoofingStream.git
     ```
2. Mở trình duyệt và truy cập `chrome://extensions/`.
3. Bật **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
4. Nhấn nút **Tải tiện ích đã giải nén (Load unpacked)** và chọn thư mục gốc `YTSpoofingStream` (thư mục chứa file `manifest.json`).
5. Mở YouTube, đảm bảo đã đăng nhập tài khoản có Premium, và thưởng thức âm thanh chuẩn phòng thu với huy hiệu `★ 774` trên thanh điều khiển!

### Trình duyệt Mozilla Firefox / Firefox ESR
> [!WARNING]
> Phiên bản Mozilla Firefox đã chính thức **ngừng hỗ trợ** kể từ [commit 63ff08d](https://github.com/alithw/YTSpoofingStream/commit/63ff08dc622278be8c58eb7db5513c1cb170b100) do các giới hạn kỹ thuật của nền tảng Gecko (CORS khắt khe, chặn iframe ngầm `X-Frame-Options` và giới hạn luồng của WebExtensions MV3). Vui lòng sử dụng các trình duyệt nhân Chromium (Google Chrome, Microsoft Edge, Brave, Cốc Cốc, Opera,...).

---

## 🌐 Hỗ trợ Đa Ngôn Ngữ & Hướng dẫn Đóng góp Bản dịch

YTSpoofingStream hỗ trợ sẵn 6 ngôn ngữ ngay khi cài đặt (**English**, **Tiếng Việt**, **日本語**, **Русский**, **简体中文**, và **繁體中文**) cùng tính năng tự động nhận diện ngôn ngữ trình duyệt.

### Bạn muốn bổ sung ngôn ngữ của mình?
Chúng tôi rất hoan nghênh các bản dịch từ cộng đồng! Bạn có thể đóng góp ngôn ngữ mới chỉ với 3 bước đơn giản:

1. **Sao chép file mẫu (Template)**:  
   Nhân bản file [`locales/template.json`](locales/template.json) và đổi tên thành mã ngôn ngữ chuẩn ISO 639-1 của bạn (ví dụ: `ko.json` cho tiếng Hàn, `fr.json` cho tiếng Pháp, `de.json` cho tiếng Đức, `es.json` cho tiếng Tây Ban Nha...) đặt trong thư mục `locales/`.
2. **Dịch các chuỗi văn bản**:  
   - Điền thông tin vào trường `_meta` (tên ngôn ngữ, tên bản địa, mã ngôn ngữ, tác giả/GitHub handle).
   - Dịch chính xác từng giá trị tương ứng sang ngôn ngữ của bạn, giữ nguyên các biến placeholder (`{version}`, `{method}`, `{label}`, `{error}`, `{url}`) và các ký hiệu đặc biệt (`★`, `•`, `↻`, `⟳`).
3. **Khai báo & Tạo Pull Request**:  
   - Thêm thẻ `<option value="mã_ngôn_ngữ">Tên ngôn ngữ</option>` vào menu dropdown `#langSelect` trong [`src/popup.html`](src/popup.html).
   - Gửi Pull Request (PR) lên repository!

---

## ⚙️ Cấu hình & Điều khiển

- **Bật tiện ích (Enable Extension)**: Công tắc tổng tắt toàn bộ can thiệp mạng và đưa trình duyệt về chế độ phát YouTube nguyên bản.
- **Chế độ hoạt động (Operation Mode)**: Lựa chọn giữa `HYBRID_HQ` (Khuyên dùng), `YTM_HARVESTER`, hoặc `TV_HEADLESS`.
- **Chế độ Chỉ Âm thanh (Audio-Only Mode)**: Tạm dừng kết xuất hình ảnh video (có thể bật nhanh bằng biểu tượng tai nghe nằm ngay cạnh huy hiệu `★ 774` trên thanh điều khiển video) giúp tiết kiệm tối đa RAM & CPU/GPU khi chỉ nghe nhạc.
- **Tự động tải lại trang khi đổi thiết lập**: Tự động tải lại tab YouTube khi bạn đổi chế độ hoạt động.
- **Ghi đè Thống kê chi tiết (Stats for Nerds Override)**: Hiển thị thông số codec Opus 774 và bitrate thời gian thực ngay trong bảng *Stats for Nerds* của YouTube.
- **Đăng nhập TVHTML5 (TVHTML5 Login)**: Cổng xác thực OAuth2 giúp liên kết tài khoản YouTube Premium của bạn với động cơ `TVHTML5`.

---

## 🐞 Xử lý Sự cố & Câu hỏi Thường gặp

**Hỏi: Vì sao có video chỉ hiện `251` thay vì `★ 774`?**  
Đáp: Một số video (như vlog trò chuyện, tin tức hoặc video đời cũ) chỉ được máy chủ YouTube mã hóa tối đa ở chuẩn ITAG 251. Tiện ích kiểm tra nghiêm ngặt tính xác thực của luồng âm thanh: nếu video không có luồng 774 thực sự, tiện ích sẽ tự động chuyển về phát luồng gốc `251` để đảm bảo âm thanh liền mạch không lỗi.

**Hỏi: Extension có ảnh hưởng đến trang web YouTube Music (`music.youtube.com`) không?**  
Đáp: Các content script của tiện ích đã được loại trừ khỏi giao diện `music.youtube.com`, **tuy nhiên**, nếu bạn mở trực tiếp trang `music.youtube.com` để nghe nhạc, chúng tôi khuyên bạn nên gạt công tắc **`Bật tiện ích: OFF`** trong popup để các quy tắc mạng Declarative Net Request (DNR) chạy ngầm của YTM Harvester không làm ảnh hưởng tới hàng đợi phát của `music.youtube.com`. Lưu ý rằng bản thân trang web `music.youtube.com` trên máy tính chỉ hỗ trợ tối đa luồng `AAC 141` (~256kbps)—để thưởng thức chất âm **Opus 774** chuẩn phòng thu, hãy mở nhạc trực tiếp trên **YouTube thường (`www.youtube.com`)** cùng YTSpoofingStream!

---

## 💖 Ủng Hộ & Tài Trợ Dự Án

Nếu **YTSpoofingStream** mang lại trải nghiệm nghe nhạc tuyệt vời hơn cho bạn trên YouTube, bạn có thể ủng hộ và đồng hành cùng tác giả để tiếp thêm động lực nghiên cứu và duy trì tiện ích:

<p align="center">
  <a href="https://github.com/sponsors/alithw" target="_blank">
    <img src="https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Tài trợ qua GitHub Sponsors" height="38" />
  </a>
  &nbsp;&nbsp;
  <a href="https://ko-fi.com/alithw" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" height="38" alt="Buy Me a Coffee at ko-fi.com" />
  </a>
</p>

Bạn có thể tài trợ trực tiếp qua **[GitHub Sponsors (github.com/sponsors/alithw)](https://github.com/sponsors/alithw)** hoặc mời một ly cà phê qua **[Ko-fi (ko-fi.com/alithw)](https://ko-fi.com/alithw)**. Mọi sự ủng hộ và đồng hành của bạn đều là nguồn động lực rất lớn! ☕✨

---

## 🤝 Đóng góp & Cộng đồng (Contributing)

Dự án luôn hoan nghênh mọi sự đóng góp từ cộng đồng! Dù bạn muốn báo lỗi, đóng góp ý tưởng khai thác luồng hay tối ưu hóa mã nguồn, vui lòng tham khảo các tài liệu chỉ dẫn:

- 📘 **[Cẩm nang Đóng góp (CONTRIBUTING.md)](.github/CONTRIBUTING.md)**: Hướng dẫn cài đặt môi trường lập trình, cấu trúc thư mục dự án, tiêu chuẩn code vanilla ES6+ và checklist kiểm tra trước khi gửi PR.
- 📜 **[Quy tắc Ứng xử (CODE_OF_CONDUCT.md)](.github/CODE_OF_CONDUCT.md)**: Tiêu chuẩn ứng xử văn minh, tôn trọng và hỗ trợ lẫn nhau trong cộng đồng theo chuẩn Contributor Covenant 2.1.
- 🔒 **[Chính sách Bảo mật (SECURITY.md)](.github/SECURITY.md)**: Quy trình báo cáo lỗ hổng bảo mật có trách nhiệm.
- 🐛 **[Báo cáo Sự cố (Bug Report)](https://github.com/alithw/YTSpoofingStream/issues/new?template=bug_report.yml)**: Mẫu báo cáo lỗi chi tiết kèm URL video và log console.
- 💡 **[Đề xuất Tính năng (Feature Request)](https://github.com/alithw/YTSpoofingStream/issues/new?template=feature_request.yml)**: Nơi chia sẻ ý tưởng cải tiến thuật toán và chất lượng âm thanh.

---

## ⚠️ Tuyên bố Từ chối Trách nhiệm (Disclaimer)

- **Dự án Độc lập**: YTSpoofingStream là một dự án mã nguồn mở độc lập và **không** có bất kỳ liên kết, ủy quyền, chứng thực hay liên hệ chính thức nào với YouTube, Google LLC hay Alphabet Inc. Trang web chính thức của YouTube tại [https://www.youtube.com](https://www.youtube.com). "YouTube" và "YouTube Music" là các nhãn hiệu đã được đăng ký của Google LLC.
- **Không Phá khóa DRM**: Tiện ích mở rộng này **hoàn toàn không** bẻ khóa DRM Widevine, không can thiệp nội dung bản quyền được mã hóa và không hỗ trợ tải lậu video/nhạc. Tiện ích chỉ hoạt động trong phạm vi phiên duyệt web hợp lệ của người dùng nhằm định tuyến các luồng phát đã được cấp phép.
- **Mục đích Nghiên cứu & Cá nhân**: Phần mềm được phát triển phục vụ mục đích nghiên cứu học thuật và trải nghiệm cá nhân. Người dùng tự chịu trách nhiệm khi sử dụng tiện ích theo Điều khoản Dịch vụ của YouTube. Phần mềm được cung cấp dưới dạng "nguyên trạng" (as-is) và không đi kèm bất kỳ cam kết hay bảo đảm nào.

---

## 📄 Giấy phép (License)

Dự án được phân phối dưới **Giấy phép Apache 2.0 (Apache License 2.0)**. Xem chi tiết tại file [`LICENSE`](LICENSE).
