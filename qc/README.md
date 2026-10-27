# PointSnap QC

Dịch vụ quét QC cả job CVAT 3D, chạy trên một máy trong mạng công ty (hoặc localhost khi thử), kèm trang web xem kết quả.
Dùng **đúng bộ luật của bảng annotator** trong extension (`extension/src/annotator/measure.js`, `checks.js`): annotator
thấy "ổn" thì QC cũng thấy "ổn" trên cùng một box.

## Chạy

Cần Node ≥ 20, không cài thêm thư viện.

1. Tạo access token trên CVAT: bấm tên tài khoản (góc phải) → **Settings** / hồ sơ → **Access tokens** → tạo token, tick
   **Read only**, đặt ngày hết hạn. CVAT chỉ hiện giá trị một lần.
2. Chép `qc/.env.example` thành `qc/.env.local` (không commit), điền `CVAT_URL` và `CVAT_TOKEN`.
3. `node qc/server.js` → mở <http://127.0.0.1:8766>.

Chạy trên máy chủ cho cả nhóm: đặt `QC_HOST=0.0.0.0`. Dịch vụ không có đăng nhập riêng: ai vào được trang là xem được
kết quả, nên chỉ mở trong mạng nội bộ.

## Làm gì

Tool chỉ giảm việc lượt đầu cho QC (xếp chỗ cần xem trước, kèm số đo); QC vẫn kiểm cả job.

- **Quét job**: tải point cloud từng gói frame qua API CVAT, dựng box ở mọi frame như CVAT hiển thị (keyframe + nội suy).
- **Luật theo từng box, chung với bảng annotator** (`extension/src/annotator/`): mặt đất, kích thước theo class, lệch trong
  track, box rỗng, chồng lấn, spec người lái / người trong xe, thuộc tính bắt buộc, phạm vi; hướng nhảy giữa keyframe.
- **Luật chỉ QC** (`lib/trackrules.js`, cần nhìn nhiều frame, hợp với pre-label): box nhảy trong một frame, đổi ID giữa hai
  track, đứt track (một vật hai ID: ghép một-một bằng Hungarian, kiểm bằng point cloud ở chỗ nối, `lib/evidence.js`), một
  vật vẽ hai lần. Chuyển động xe thu khớp từ point cloud (`lib/icp.js`, CVAT không lưu pose).
- **Hình nhìn từ trên** cho mục đứt track: điểm LiDAR, box hai đoạn và chỗ mỗi vật lẽ ra ở, đọc thẳng từ CVAT khi bấm.
- **Trang job**: mức ưu tiên xem (không phải ĐẠT / KHÔNG ĐẠT), phần tool không kiểm, dải frame, thanh theo luật, danh sách
  gộp theo object + luật với ↗ mở CVAT đúng frame / object, ✓ Đúng, ✕ Báo nhầm (giữ qua các lần quét lại), xuất CSV / JSON.
- **Tab Guideline**: theo project, bật / tắt luật, ngưỡng, khoảng kích thước, thuộc tính bắt buộc, cặp được chồng, nhập /
  xuất JSON (nhận file Export của extension); mỗi lần lưu là một phiên bản, khôi phục được; job quét theo bản cũ thì trang
  nhắc quét lại.

## Đo trên dữ liệu thật (26/10/2026, CVAT 2.75.1 local, nhãn chuẩn)

| Job | Dữ liệu | Box | Thời gian | Mục lỗi + cảnh báo | Trong đó luật chỉ QC |
|---|---|---|---|---|---|
| 75 | nuScenes scene-1100 | 906 | 2,5 s | 6 | 0 |
| 74 | nuScenes scene-1077 | 651 | 2,1 s | 8 | 1 |
| 72 | Argoverse 2 | 1 515 | 8,7 s | 20 | 1 |
| 69 | nuScenes scene-0061 | 3 333 | 3,7 s | 115 | 3 |

Luật chỉ QC bắt lỗi cài vào bản sao nhãn: đổi ID 93%, đứt track 88%, vẽ hai lần 80%, box lệch 3 m 77%, to thêm 30% 70%.
Chi tiết, nguồn báo nhầm và cách đo: [docs/qc-scan-phan-tich-thiet-ke.md](../docs/qc-scan-phan-tich-thiet-ke.md) mục 9,
[docs/pain-points-va-giai-phap.md](../docs/pain-points-va-giai-phap.md) PP-19 – PP-24.

## Lưu ở đâu

`qc/.data/` (đổi bằng `QC_HOME`): `scans/` kết quả lần quét mới nhất mỗi job, `reviews/` kết luận của QC, `specs/` các phiên
bản guideline theo project. Dữ liệu point cloud không lưu lại: đọc từ CVAT, quét xong bỏ.

## Test

`node --test qc/test/*.test.js`
