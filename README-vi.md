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
- **Nền tảng Manifest V3 Tiên tiến**: Đánh chặn các yêu cầu API và sửa đổi Header (`Origin`, `User-Agent`) một cách tĩnh lặng thông qua API `declarativeNetRequest` gốc của Chrome. Đảm bảo hiệu năng tuyệt đối, không làm chậm trình duyệt như `webRequest` cũ.
- **Bộ đệm & Đồng bộ Thông minh**: Sử dụng kết hợp `sessionStorage` và bộ nhớ tạm (in-memory) để đảm bảo video tải được định dạng chất lượng cao ngay lập tức khi bạn F5 hoặc khi Playlist tự động chuyển bài, loại bỏ hoàn toàn độ trễ mạng.
- **Bảng điều khiển cho Dân công nghệ (Stats for Nerds)**: Giao diện popup trực quan, hiển thị nhật ký chi tiết, số lượng stream được tiêm vào, phương thức âm thanh đang hoạt động và trạng thái giả mạo theo thời gian thực.

## 🧠 Kiến trúc Kỹ thuật & Chuyên sâu

Để xây dựng được tiện ích này, chúng tôi đã phải vượt qua rất nhiều cơ chế bảo mật và quản lý trạng thái phức tạp bên trong kiến trúc Single Page Application (SPA) hiện đại của YouTube.

### 1. Lớp Đánh chặn (Interception Layer)
YouTube cung cấp dữ liệu video (`streamingData`) qua ba luồng khác nhau tùy thuộc vào trạng thái điều hướng:
- `window.ytInitialPlayerResponse` (nhúng thẳng vào HTML cho các truy cập trực tiếp).
- `window.ytplayer.config.args.raw_player_response` (cấu hình dự phòng/cũ).
- `window.fetch` (được sử dụng bởi router SPA khi người dùng bấm chuyển video).

Tiện ích tiêm một Content Script (`inject.js`) tại thời điểm `document_start` để chặn cả ba luồng này. Bằng cách sử dụng `Object.defineProperty`, chúng tôi móc (hook) vào các biến toàn cục trước khi script của YouTube kịp khởi động. Khi SPA router gọi lệnh `fetch` đến `/youtubei/v1/player`, chúng tôi chặn Promise lại, chỉnh sửa JSON, tiêm định dạng xịn vào và đóng gói trả lại dưới dạng một `new Response()` hợp lệ.

### 2. Giả mạo Đa nền tảng qua Background SW
Để lấy được các định dạng chất lượng cao, Content Script ủy quyền các truy vấn mạng cho Background Service Worker. Service Worker này sẽ gọi đến API `/youtubei/v1/player` kèm theo các payload tùy chỉnh đại diện cho các client khác nhau (ví dụ: gửi `"clientName": "WEB_REMIX"` hoặc `"TVHTML5"`).
Vì YouTube kiểm tra rất gắt gao các header CORS và Origin, chúng tôi đăng ký linh hoạt các quy tắc `declarativeNetRequest` để giả mạo `User-Agent`, `Origin`, và `Referer`, khiến máy chủ YouTube tưởng lầm đây là yêu cầu phát ra từ các thiết bị di động hay Smart TV thực sự.

### 3. Khuất phục "Trình phát Cứng đầu" (State Corruption & Autoplay)
Thách thức lớn nhất là làm sao để trình phát HTML5 của YouTube chấp nhận định dạng mới một cách mượt mà:
- **Format Spoofing**: Trình phát mặc định sẽ văng lỗi ("Video unavailable") nếu nó nhận được một ITAG lạ lẫm như `774`. Để qua mặt nó, chúng tôi clone toàn bộ stream 774 và "giả mạo" mã ITAG của nó thành `251` (kèm theo việc chỉnh sửa `mimeType`). Trình phát sẽ bị lừa và tưởng nó đang phát định dạng Opus tiêu chuẩn, nhưng thực chất nó đang gánh luồng dữ liệu 300+ kbps của Premium.
- **Đóng băng Autoplay trên SPA**: Nếu cố tình ép trình phát tải lại bằng API `player.loadVideoByPlayerVars()`, trạng thái nội bộ của player rất dễ bị lỗi (corrupted) nếu `videoId` không thay đổi. Tệ hơn nữa, nếu việc tải định dạng làm kẹt luồng SPA quá lâu, các trình duyệt (như Chrome) sẽ tước bỏ quyền "user gesture" (tương tác người dùng), kích hoạt chính sách chặn Autoplay khắt khe và đóng băng video hoàn toàn khi chuyển bài.
- **Giải pháp Caching**: Để giải quyết triệt để, chúng tôi xây dựng một bộ đệm `sessionStorage` với vòng đời 1 giờ.
  - **Ở lần tải đầu tiên (F5):** Tiện ích chủ động ép tải lại trang một lần duy nhất (`window.location.reload()`) để tiêm định dạng một cách đồng bộ (synchronous), đảm bảo player khởi tạo hoàn hảo.
  - **Khi chuyển bài (Playlist/SPA):** Cờ bảo vệ ngăn chặn việc tải lại trang. Thay vào đó, `fetch` interceptor sẽ đảm nhiệm việc chặn và tiêm định dạng khớp từng mili-giây với router của YouTube, đảm bảo tỷ lệ chặn Autoplay là 0% và chuyển bài mượt mà.

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
2. Tạo một nhánh tính năng mới (`git checkout -b feature/TinhNangMoi`).
3. Commit các thay đổi của bạn (`git commit -m 'Thêm TinhNangMoi'`).
4. Push lên nhánh vừa tạo (`git push origin feature/TinhNangMoi`).
5. Mở một Pull Request.

## 📄 Giấy phép (License)

Dự án này là mã nguồn mở và được phân phối theo giấy phép **MIT License**. Vui lòng xem file `LICENSE` để biết thêm thông tin chi tiết.
