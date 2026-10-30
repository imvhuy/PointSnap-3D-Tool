# Kiểm tra tích hợp CVAT

Ngày 29/10/2026, baseline `e845e7d`. Phạm vi: plugin CVAT, manifest/background/bridge của extension, hợp đồng API và tài liệu. Chưa chạy browser/CVAT thật trong đợt audit này.

## INT-01 — Chọn object chỉ theo serverID, thiếu kind

**Mức:** P2, ca hợp đồng đầu vào cần thêm E2E trên CVAT mục tiêu.

Nguồn: `qc/public/plugin.js:37`, đặc biệt `.find((x) => x.serverID === serverId)`; các callsite truyền `serverId` nhưng không truyền `kind` của object/phiếu. Dữ liệu scan và URL CVAT đã có `kind/type`, nhưng lúc chọn trực tiếp trong store thì loại bị bỏ.

Fixture có một shape và một track cùng `serverID=7`, clientID lần lượt 101 và 202, cùng frame. Yêu cầu chọn track 7 bằng hàm nguyên bản `goTo(7,0)` trả thành công nhưng chọn shape 101. Mã nguồn plugin được chạy trong VM, chỉ dừng trước bootstrap DOM, không thay logic hàm. [Probe](probe.cjs), [expected/actual](results.json).

Đây là bằng chứng hàm chọn sai **khi** hai loại có ID trùng, chưa phải quan sát lỗi trên job thật của người dùng. Cần contract fixture có cả shape và track trên bản CVAT triển khai. Hướng sửa: identity đầy đủ `(jobId, kind, serverId)` từ API tới UI và selector; với lỗi theo cặp cũng giữ kind của cả hai vật. Không dùng số clientID hiển thị hoặc serverID đơn lẻ làm định danh toàn hệ thống.

Nghiệm thu: shape và track trùng ID, ID tồn tại ở job khác, object deleted/outside, chuyển frame khi tải chậm; UI hoặc chọn đúng loại/object, hoặc báo không tìm thấy. `goTo()` trả false phải được hiện thành thông báo thay vì trông như đã tới box.

## INT-02 — Extension standalone chưa kết nối dịch vụ QC mới

Đây là **khoảng trống triển khai đã được tài liệu thừa nhận**, không tính thêm như lỗi thuật toán. `docs/qc-extension-api.md` mở đầu ghi phần extension chưa làm. Kiểm mã xác nhận:

- `extension/background.js:10` và `options.js:8` mặc định cổng 8765 của Python cũ.
- `background.js` allowlist gọi `/api/extension/jobs`, `/api/extension/poll`, `/api/projects/<slug>/scans/...`; fetch không gắn bearer `psq_…` và header ghi của dịch vụ QC mới.
- `manifest.json` vẫn nạp bộ script QC cũ; `content.js` chỉ khởi động bảng scan nếu `showScanPanel=true`, mặc định false. Vì thế không kết luận các chức năng đo/sửa nhãn standalone bị hỏng.
- Service Node hiện cổng 8766, API `/api/jobs/<id>`, `/api/tickets/...`; plugin cùng origin `/pointsnap-qc/` là đường đã được triển khai để dùng các API mới.

Do đó UI cho tạo token chưa chứng minh extension đã dùng được token đó. Chuyển cổng trong options cũng chưa đủ: API contract và auth vẫn khác. Cần chọn một đường tích hợp chính cho pilot; cấu hình/tài liệu phải phân biệt plugin hiện có với phần extension QC còn chưa làm.

## INT-03 — Hợp đồng plugin phụ thuộc phiên bản CVAT

Plugin lấy store/actionCreators qua `window.cvatUI.registerComponent`, nhưng chèn tab bằng class DOM `.cvat-objects-sidebar-tabs` / `.ant-tabs-*`, selector lặp mỗi 400 ms, chuyển object bằng action payload nội bộ. Đây là các điểm cần contract/E2E trên phiên bản CVAT thật, không suy ra hỗ trợ mọi phiên bản từ `node --check`.

`docs/qc-plugin-cvat.md` vừa mô tả phiếu thiếu vật đã có, vừa còn liệt kê phiếu này ở mục “Còn thiếu”; cuối tài liệu cũng ghi chưa thử các thao tác ghi trên CVAT local. Cần cập nhật tài liệu sau một lượt E2E, tránh dùng danh sách “đã có code” làm bằng chứng “đã chạy trên trình duyệt”.

Nghiệm thu: login/đổi tài khoản, mở job, đổi frame/object, QC tạo/sửa/thu hồi phiếu, annotator Save/nộp/rút, QC nghiệm thu/quét lại, đóng/mở tab, plugin và extension cùng bật. Các phiên bản hỗ trợ phải được pin và có log/trace cho từng lượt.

## Chiến lược kiểm thử

Unit/VM kiểm tra identity và logic độc lập. HTTP mock kiểm tra API. Browser E2E kiểm tra DOM, store/action contract và Save/reload. Ba lớp trả lời các câu hỏi khác nhau; bộ 167 test hiện có chưa thay thế E2E này. [Playwright hướng dẫn extension](https://playwright.dev/docs/chrome-extensions) dùng persistent Chromium context; công cụ kiểm thử có thể nằm trong môi trường QA riêng để runtime dự án vẫn giữ Node/JS stdlib.
