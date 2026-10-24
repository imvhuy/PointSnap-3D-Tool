# Phạm vi bảo mật khi chạy local

PointSnap Web dành cho **một người dùng tin cậy trên máy local**. Chạy `pointsnap ui --no-browser` mặc định ở `127.0.0.1:8765`. Token dự án lưu dạng plaintext trong thư mục POINTSNAP_HOME; quyền đọc thư mục này quyết định ai có thể dùng token. Không dùng cùng home cho nhiều process Web.

Web kiểm Host loopback, Origin cùng scheme/host/port, chặn browser request cross-site và không cho nhúng vào iframe. Extension Chrome được người dùng cấp host permission là thành phần tin cậy; Origin `chrome-extension://<id>` hợp lệ được chấp nhận. CLI/local process không có Origin vẫn dùng API được. Các kiểm tra này không thay thế đăng nhập hoặc quyền người dùng cho dịch vụ LAN.

`POINTSNAP_ALLOWED_HOSTS` là danh sách hostname cách nhau bằng dấu phẩy khi có reverse proxy đã được kiểm soát. Không dùng `*`. Bind vào LAN hoặc thêm hostname không tạo cơ chế xác thực; việc triển khai qua proxy/LAN cần kiểm riêng ở phần deployment. Proxy HTTPS phải truyền đúng scheme để kiểm Origin.

Đổi origin hoặc đường dẫn CVAT trong project xóa token cũ trước khi ghi địa chỉ mới. Nhập PAT mới của đúng server trong cùng lần lưu hoặc sau đó. URL CVAT hỗ trợ HTTP(S) và đường dẫn proxy; không chứa user/password/query/fragment. Extension hiện nhận origin CVAT, cần kiểm riêng khi dùng đường dẫn proxy.

Giới hạn Web: payload HTTP 1 MiB, hàng đợi scan tối đa16, mặc định1 worker. Client CVAT tối đa100 trang mỗi danh sách, page_size500; mỗi request có timeout. Có thể cấu hình max_pages khi gọi CvatClient bằng Python cho dữ liệu lớn sau khi kiểm tài nguyên. Extension cũng có giới hạn100 trang và timeout15 giây. Các giới hạn không phải benchmark năng lực hệ thống.

Report API dùng PAT người gọi ở mỗi request, không dùng PAT dịch vụ/cache kết quả caller khác; tối đa2 report đồng thời. `python -m pointsnap.api` mặc định bind `127.0.0.1:8081`. Trong Docker, Dockerfile.api đặt `POINTSNAP_REPORT_HOST=0.0.0.0` để Traefik trên mạng container gọi được; không tự publish cổng ra host. Image base `pointsnap:0.1.0` và Compose phải được build/kiểm riêng theo hướng dẫn deployment.

Không đưa .env, POINTSNAP_HOME, snapshot, dữ liệu hoặc token vào Git/build context. File report HTML/CSV có dữ liệu nhãn của job; bảo quản như dữ liệu của dự án. Sửa/gắn/gỡ cờ dùng job thử và snapshot; khoảng GET→PATCH của CVAT vẫn chưa có giao dịch atomic, cần phối hợp Save khi nhiều người sửa cùng job.
