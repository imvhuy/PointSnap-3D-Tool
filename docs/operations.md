# Vận hành PointSnap local

Đối chiếu 12/10/2026. Phạm vi một người dùng tin cậy, một process Web cho mỗi
`POINTSNAP_HOME`. Xem [cài đặt](../CAI-DAT.md), [Docker](../README-Docker.md),
[bảo mật](local-security.md) và [bằng chứng review 08](../../../review/2026-10-10/08-report.md).

## Khởi động và kiểm tra

1. Khởi động CVAT ngoài repo, kiểm đăng nhập/PAT và job thử đúng server.
2. Python: `python -m pointsnap ui --no-browser`. Windows đã có `.venv` có thể dùng
   `./Start-PointSnap.ps1 -NoBrowser -Port 8765`; script xác định root theo vị trí
   file, in URL/PID và ghi log `out/ui-8765.*.log`. Không cần launcher thư mục cha.
   Có thể truyền `-PythonPath` và `-ProjectHome`; chính sách PowerShell của máy
   phải cho phép script. Nếu bị chặn, dùng lệnh Python trực tiếp; không cần đổi policy.
3. Web mặc định loopback; health Report API ở `/pointsnap/health`. Kiểm thêm GET
   report trên job thử, `point_cloud_available`/coverage và gate. HTTP 200 hoặc
   health thành công không chứng nhận đủ dữ liệu hay chất lượng nhãn.
4. Cài/update MV3 theo [extension](../extension/README.md); reload extension và
   trang CVAT. Web/extension bridge cần cả hai đang chạy, không có trạng thái online
   được lưu qua restart.

Để dừng Web, Ctrl+C nếu chạy foreground; nếu dùng launcher, dừng đúng PID vừa
được in (`Stop-Process -Id <pid>`). Không dừng mọi process Python trên máy.

## Dữ liệu, restart và sao lưu

Home mặc định là `~/.pointsnap`; dự án nằm dưới `projects/<slug>`. Nếu dùng launcher,
home mặc định là `data/pointsnap-home` cạnh script. Dùng `POINTSNAP_HOME` rõ ràng
khi chuyển giữa các cách chạy. Home chứa config/PAT, runs, snapshots, reports và
reviews; bảo quản như dữ liệu nhạy cảm, quyền đọc chỉ cho người vận hành.

1. Chờ scan/ghi cờ kết thúc, dừng Web rồi sao lưu **toàn bộ home**, không chỉ reports.
2. Lưu riêng dataset, bản xuất/manifest, `.env`, cấu hình custom và commit/image tag.
   Backup home không sao lưu database CVAT hoặc dataset ngoài home.
3. Kiểm checksum/số file, lưu ở nơi riêng có quyền hạn phù hợp. Không commit backup.
4. Restore vào thư mục riêng, đặt `POINTSNAP_HOME` trỏ tới đó, kiểm URL CVAT trước
   khi dùng PAT. Kiểm lại dataset/export paths và mở một run cũ/config/review.
5. Run hoàn tất vẫn đọc được. Run queued/running khi process chết được đánh dấu
   failed lúc startup; không tự resume. Quét lại job sau khi xác nhận CVAT đã lưu.

Review 08 kiểm byte-level backup/restore bằng fixture chứa PAT giả và review,
run done/queued. Chưa phục hồi database/nhãn CVAT thật; snapshot JSON hiện là bằng
chứng phục vụ khôi phục thủ công, chưa có CLI restore tự động.

## Update và rollback

- Ghi commit, Python/dependency versions, config hash, image ID/tag và home được
  dùng trước update. Dừng process, backup home rồi cập nhật checkout/package.
- Cài vào venv mới hoặc build image tag mới. Smoke CLI/Web/report trước khi dùng
  PAT công việc; Docker build CLI trước API cùng phiên bản. Giữ image/venv cũ.
- Rollback code và config tương ứng, restore backup sang home riêng rồi kiểm run.
  Không mở cùng home đồng thời bằng hai phiên bản. Chưa có migration/versioned
  schema bảo đảm mọi cặp version; test chỉ kiểm runner nguồn phần 04 đọc run đã
  hoàn tất của fixture với dependencies hiện hành.
- Đổi URL CVAT trong dự án xóa PAT cũ; nhập lại PAT của đúng server. Đóng job và
  phối hợp Save khi ghi/gỡ cờ vì GET→PATCH chưa atomic.

## Khi gặp lỗi

| Dấu hiệu | Kiểm tra |
|---|---|
| Không có point cloud | Dataset root, manifest/task URL, frame names, mounts, alias backend/Web của cùng server |
| Gate không đạt nhưng ít lỗi | Coverage gaps, `floating.no_evidence`, pose/cloud của luật đang bật |
| API 401/403 | PAT người gọi và quyền job trên đúng CVAT; không thay bằng token chung |
| API 429 | Chờ hai scan đang chạy hoàn tất rồi thử lại; health không chiếm slot scan |
| Không ghi được output | UID 1000 trên Docker và quyền đúng thư mục `out`/`data`; API mount chỉ đọc |
| Web không lên | Log stderr, port đang bị dùng, Python/venv, chính sách script |

Khi báo lỗi, gửi version/commit, endpoint không chứa token, loại dữ liệu, counts
và log đã che nhãn/PAT. Kết quả quality hiện còn cần manual precision và giảm báo
động proxy; chỉ dùng local với reviewer xác nhận, chưa có nghiệm thu phát hành rộng.
