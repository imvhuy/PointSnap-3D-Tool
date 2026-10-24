# PointSnap 0.3 — hướng dẫn kiểm tra bản mới

## Mở và kiểm tra môi trường

1. Mở `http://127.0.0.1:8765/app`. Mỗi lần tải trang, PointSnap hiện **Hệ thống** trước, kể cả đã có kết quả cũ.
2. Chọn đúng dự án. CVAT/token và model được kiểm tra theo Guideline của dự án đó.
3. Nếu thiếu runtime, bấm **Sao chép**, chạy lệnh trong PowerShell rồi **Kiểm tra lại**. Lệnh dùng đúng Python đang chạy backend. Việc kiểm tra không tự tải model.
4. Box Critic cần trọng số `.pt` do nhóm bàn giao: điền đường dẫn, lưu rồi kiểm tra lại. Camera có lựa chọn CPU/GPU hoặc không sử dụng.
5. Luật model đang bật mà chưa đủ yêu cầu sẽ chặn quét mới. **Tiếp tục công việc** vẫn cho xem kết quả cũ và sửa tay trong CVAT.

Muốn thay các luật sẽ chạy, mở **Guideline**. Năm nhóm chính chỉ có điều khiển có tác dụng; cấu hình chuyên sâu vẫn nằm trong YAML.

## Đọc kết quả và sửa

- Danh sách chỉ chứa **Lỗi + Cảnh báo**. Số lượng, bộ lọc, phân trang và extension dùng cùng chính sách. Thông tin thiếu bằng chứng nằm trong **Chẩn đoán lần quét**.
- Chọn một dòng: chi tiết, ảnh và nút mở CVAT trỏ đúng frame/đối tượng. Các chỉ số gốc không thay đổi khi lọc.
- Nạp extension từ `source-tool/pointsnap-3d/extension`, phiên bản **0.3.0**. Nếu trình duyệt đang trỏ thư mục bản cũ, tắt bản đó và dùng **Load unpacked** với thư mục mới; sau đó tải lại tab CVAT khi đã Save công việc.
- Kéo bằng tay nắm CVAT; tọa độ, kích thước, góc và thước cập nhật trên canvas. Nhả chuột để kiểm lại lỗi.
- **Hết lỗi đang xét — chưa Save** chỉ là kết quả kiểm tra hình học trong bộ nhớ. **Thiếu bằng chứng** không phải đã sửa xong.
- Sau Save, hướng dẫn của lần quét cũ bị vô hiệu hóa, kể cả khi chuyển frame rồi quay lại. Web hiện **Cần quét lại sau Save**. Tọa độ trực tiếp và công cụ CVAT vẫn sử dụng được.
- PointSnap không ghi hình học; Save, Undo và Redo đều dùng CVAT.

Kết luận lịch sử không xác định được chỉ số gốc sẽ không được gắn sang lỗi khác. Bản cũ được giữ lại để đối chiếu.

## Giao diện dữ liệu

- `GET /api/system/status?project_slug=...`: CVAT, runtime/model, số luật chạy được, extension và `scan_ready`/`blockers`.
- `GET /api/rules?project_slug=...`: danh mục nhóm/luật, điều kiện, trạng thái bật và khả năng chạy. Các nhãn/tip cũ được giữ cho khả năng đọc lịch sử.
- Finding có `finding_index` theo thứ tự trong `findings.json` và cờ `actionable`; dữ liệu gốc không bị lọc rồi đánh số lại. GuideContext v1 bổ sung project/run/index trong identity.
- `POST /api/extension/events`: sự kiện `selected`, `evaluated`, `saved`, được giới hạn theo dự án/run/CVAT/job và session/sequence. Cầu nối trả sự kiện mới nhất và trạng thái đã Save theo từng run. Không gửi hình học theo từng chuyển động chuột.
- Các API tự sửa/rollback tiếp tục trả **410**. Lịch sử và snapshot cũ vẫn đọc được.

## Phạm vi bàn giao

Thực hiện kiểm tra local trước. Sau khi người dùng xác nhận, tạo nhánh `codex/ui-manual-sync-20261016` từ `main` mới nhất của repo `AI20K-Build-Phase-Cohort-4A/P-029`, tích hợp giao diện/đồng bộ/công cụ sửa tay và tài liệu/ảnh/kiểm thử liên quan rồi tạo PR. Không đưa token, model, dữ liệu gán nhãn, môi trường Python hoặc toàn bộ lịch sử fork lên repo gốc.
