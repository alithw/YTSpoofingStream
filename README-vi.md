<div align="center">
  <img src="logo.svg" alt="YTSpoofingStream Logo" width="128" height="128">
  <h1>YTSpoofingStream</h1>
</div>

> **Cảnh báo dành cho người dùng Không có Premium**
> Tiện ích này được thiết kế **dành riêng cho những người dùng hiện đang có gói đăng ký YouTube Premium**. Nếu bạn không có YouTube Premium, các luồng gọi API nội bộ sẽ bị YouTube từ chối hoặc bóp băng thông, dẫn đến tình trạng video tải cực kỳ chậm, buffer liên tục, hoặc báo lỗi "Video unavailable". **Vui lòng không sử dụng tiện ích này nếu bạn không phải là thành viên Premium.**

*Đọc bằng ngôn ngữ khác: [English](README.md).*

---

## 📑 Mục lục
- [Tại sao bạn cần tiện ích này?](#-tại-sao-bạn-cần-tiện-ích-này)
- [Tính năng Nổi bật](#-tính-năng-nổi-bật)
- [Kiến trúc Kỹ thuật & Chuyên sâu](#-kiến-trúc-kỹ-thuật--chuyên-sâu)
- [Hướng dẫn Cài đặt](#-hướng-dẫn-cài-đặt)
- [⚠️ Giới hạn đã biết](#️-giới-hạn-đã-biết)
- [Báo cáo Lỗi & Hỗ trợ](#-báo-cáo-lỗi--hỗ-trợ)
- [Đóng góp vào Dự án](#-đóng-góp-vào-dự-án)
- [Giấy phép (License)](#-giấy-phép-license)

---

Một tiện ích mở rộng mạnh mẽ và siêu nhẹ dành cho Chrome, giúp ép trình phát web của YouTube phải cung cấp các luồng âm thanh Premium chất lượng cao nhất (như 256kbps AAC hoặc 300+ kbps Opus) bằng cách giả mạo yêu cầu (spoofing) đến các API nội bộ của YouTube (Android, iOS, TVHTML5 và Web Remix).

## 🌟 Tại sao bạn cần tiện ích này?

Gần đây, YouTube đã giới hạn các luồng âm thanh chất lượng cao (như ITAG 141 cho 256kbps AAC và ITAG 774 cho Opus bitrate cao) chỉ dành riêng cho người dùng Premium trên một số nền tảng nhất định. Trình phát trên nền web thường bị ép phải sử dụng âm thanh chất lượng thấp hơn (ITAG 251 ở mức 160kbps hoặc ITAG 140 ở mức 128kbps) ngay cả khi bạn là một người dùng Premium đang trả phí.

YTSpoofingStream hoạt động như một chiếc cầu nối vô hình. Nó bí mật yêu cầu các định dạng cao cấp bằng cách giả mạo thiết bị thông qua Background Service Worker, vượt qua giới hạn nhân tạo của trình duyệt web và nhét thẳng luồng âm thanh chất lượng cao vào video bạn đang xem.

## ✨ Tính năng Nổi bật

- **Mở khóa Âm thanh Premium**: Tận hưởng âm thanh trong trẻo bằng cách ép YouTube phục vụ các định dạng âm thanh bitrate cao (ITAG 141, 774) vốn bị ẩn đi trên nền web.
- **Động cơ Giả mạo Đa nền tảng (Multi-Client)**: Luân chuyển mượt mà giữa các client nội bộ của YouTube (WEB_REMIX, ANDROID, IOS, TVHTML5) để săn lùng định dạng âm thanh tốt nhất cho từng video.
- **Vượt rào BotGuard & poToken**: Tự động trích xuất `poToken` và `visitorData` trực tiếp từ trang web đang chạy để đánh lừa các cơ chế chống bot khắt khe của YouTube, triệt tiêu hoàn toàn lỗi "Video unavailable".
- **Hỗ trợ Vevo & Video Ca nhạc Bản quyền**: Xử lý mượt mà các luồng dữ liệu bị mã hóa `signatureCipher`. Tận hưởng âm thanh Premium ngay cả trên các MV ca nhạc được bảo vệ bản quyền.
- **Nền tảng Manifest V3 Tiên tiến**: Đánh chặn các yêu cầu API và sửa đổi Header (`Origin`, `User-Agent`) một cách tĩnh lặng thông qua API `declarativeNetRequest` gốc của Chrome. Đảm bảo hiệu năng tuyệt đối.
- **Pre-warm & Tự động Nâng cấp**: Tải trước các luồng HQ ngầm trong nền ngay khi bạn click chọn video ở thanh bên (Cơ chế SPA). Tự động nâng cấp trình phát lên HQ ngay khi dữ liệu sẵn sàng mà không cần tải lại trang.
- **Bảng điều khiển cho Dân công nghệ (Stats for Nerds)**: Giao diện popup trực quan, hiển thị nhật ký chi tiết, số lượng stream được tiêm vào, phương thức âm thanh đang hoạt động và trạng thái giả mạo theo thời gian thực.

## 🧠 Kiến trúc Kỹ thuật & Chuyên sâu

Để xây dựng được tiện ích này, chúng tôi đã phải vượt qua rất nhiều cơ chế bảo mật và quản lý trạng thái phức tạp bên trong kiến trúc Single Page Application (SPA) hiện đại của YouTube.

### 1. Lớp Đánh chặn (Interception Layer)
YouTube cung cấp dữ liệu video (`streamingData`) qua ba luồng khác nhau tùy thuộc vào trạng thái điều hướng:
- `window.ytInitialPlayerResponse` (nhúng thẳng vào HTML cho các truy cập trực tiếp).
- `window.ytplayer.config.args.raw_player_response` (cấu hình dự phòng/cũ).
- `window.fetch` (được sử dụng bởi router SPA khi người dùng bấm chuyển video).

Tiện ích tiêm một Content Script (`inject.js`) tại thời điểm `document_start` để chặn cả ba luồng này. Chúng tôi dùng `Object.defineProperty` để "móc" vào các biến toàn cục trước khi script của YouTube kịp khởi động. Khi SPA router gọi lệnh `fetch`, chúng tôi chặn Promise lại, chỉnh sửa JSON, tiêm định dạng xịn vào và đóng gói trả lại dưới dạng một `new Response()` hợp lệ.

### 2. Giả mạo Đa nền tảng & Vượt rào BotGuard
Để lấy được định dạng cao cấp, Content Script ủy quyền các truy vấn mạng cho Background Service Worker. SW này sẽ gọi API `/youtubei/v1/player` với các payload của thiết bị khác (như `WEB_REMIX` hoặc `TVHTML5`).
- **Bypass BotGuard:** YouTube kiểm tra rất gắt gao `poToken` (Proof of Origin) trên các client như TVHTML5. Tiện ích liên tục bắt lén các Request gửi đi của YouTube Player, trích xuất `poToken`, `signatureTimestamp` và `visitorData` còn "tươi" nhất, rồi tuồn sang Background SW để gắn vào Payload, giúp qua mặt BotGuard dễ dàng.
- **Spoofing Header:** Chúng tôi đăng ký linh hoạt các quy tắc `declarativeNetRequest` để giả mạo `User-Agent` và `Origin`, khiến máy chủ YouTube tưởng lầm yêu cầu phát ra từ Smart TV thực sự.

### 3. Khuất phục "Trình phát Cứng đầu" (State Corruption & Autoplay)
Thách thức lớn nhất là làm sao để trình phát HTML5 chấp nhận định dạng mới một cách mượt mà:
- **ITAG Disguise (Cú lừa ngoạn mục):** Trình phát mặc định sẽ văng lỗi ("Video unavailable" hoặc "Format Error") nếu nhận được mã ITAG lạ lẫm như `774`. Để qua mặt nó, chúng tôi "ngụy trang" mã ITAG của luồng 774 thành `251` (kèm chỉnh sửa `mimeType`). Trình phát sẽ bị lừa và tưởng nó đang phát Opus tiêu chuẩn 160kbps, nhưng thực chất nó đang gánh luồng 300+ kbps của Premium.
- **Vevo & signatureCipher:** Các MV ca nhạc có bản quyền (Vevo) không dùng link URL tĩnh mà dùng luồng mã hóa `signatureCipher`. Tiện ích được thiết kế cực kỳ cẩn thận để giữ nguyên cấu trúc mã hóa này khi tiêm vào Player, để thuật toán bẻ khóa `base.js` của chính YouTube tự tay giải mã định dạng Premium cho chúng ta.
- **Đóng băng Autoplay & Pre-warming:** Ép trình phát tải lại trang sẽ khiến Chrome tước bỏ quyền "tương tác người dùng", làm video bị đóng băng (Autoplay Policy). Thay vào đó, tiện ích lắng nghe sự kiện `yt-navigate-start` để tải trước (pre-warm) dữ liệu HQ trong nền. Ngay khi luồng 774 sẵn sàng, tiện ích gửi lệnh nâng cấp cưỡng chế thẳng vào API nội bộ của Player, nâng cấp âm thanh mượt mà không cần F5!

## 🚀 Hướng dẫn Cài đặt

Do tiện ích này can thiệp sâu vào các API nội bộ của YouTube, nó hiện không có mặt trên Chrome Web Store. Bạn có thể cài đặt thủ công thông qua Chế độ dành cho nhà phát triển (Developer Mode):

1. Tải bản phát hành mới nhất từ kho lưu trữ hoặc clone bằng lệnh `git clone`.
2. Giải nén các file vào một thư mục trên máy tính của bạn.
3. Mở Google Chrome và truy cập vào đường dẫn `chrome://extensions/`.
4. Bật **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên cùng bên phải.
5. Nhấn vào **Tải tiện ích đã giải nén (Load unpacked)** và chọn thư mục chứa các file của tiện ích này (nơi có file `manifest.json`).
6. Mở YouTube, đảm bảo bạn đã đăng nhập vào tài khoản Premium, và tận hưởng âm thanh chất lượng cao!

## ⚠️ Giới hạn đã biết

> [!CAUTION]
> **Không tương thích với YouTube Music (`music.youtube.com`).**
> Khi tiện ích đang bật, `music.youtube.com` có thể hoạt động bất thường — các bài hát trong hàng đợi phát (queue) có thể bị nhảy hoặc chuyển bài liên tục ngoài ý muốn do tiện ích bắt các yêu cầu tải trước (pre-fetch) ngầm trong nền. Nếu bạn muốn sử dụng YouTube Music bình thường, **hãy tắt tiện ích trước**.

| Nền tảng | Trạng thái |
|---|---|
| `youtube.com` | ✅ Hỗ trợ đầy đủ |
| `music.youtube.com` | ❌ Tắt tiện ích trước khi dùng |

---

## 🐞 Báo cáo Lỗi & Hỗ trợ

Nếu bạn gặp bất kỳ lỗi nào, ví dụ như "Video unavailable", buffer xoay vòng liên tục, hoặc mất âm thanh, vui lòng mở một Issue trên GitHub. Để giúp chúng tôi sửa lỗi nhanh hơn, hãy cung cấp:
- Đường dẫn (URL) của Video bị lỗi.
- Ảnh chụp màn hình Popup của tiện ích (hiển thị rõ phần `Active Audio` và `Client Stats`).
- Xác nhận rằng bạn đang đăng nhập vào tài khoản YouTube Premium.

## 🤝 Đóng góp vào Dự án

Chúng tôi luôn hoan nghênh sự đóng góp từ cộng đồng! Nếu bạn có ý tưởng cải thiện phương pháp giả mạo, vượt rào các hạn chế mới, hay tối ưu hóa bộ nhớ đệm:

1. Fork dự án này.
2. Tạo một nhánh mới (`git checkout -b feature/AmazingFeature`).
3. Commit thay đổi (`git commit -m 'Thêm tính năng AmazingFeature'`).
4. Push lên nhánh (`git push origin feature/AmazingFeature`).
5. Mở một Pull Request.

## 📄 Giấy phép (License)

Dự án này được phân phối dưới Giấy phép MIT. Xem file `LICENSE` để biết thêm chi tiết.
