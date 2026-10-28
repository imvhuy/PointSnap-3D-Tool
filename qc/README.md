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

Đăng nhập bằng chính tài khoản CVAT: dịch vụ hỏi CVAT xem tên + mật khẩu đúng không rồi đăng xuất phiên CVAT đó, không lưu
mật khẩu; phiên của trang giữ trong bộ nhớ (khởi động lại dịch vụ thì đăng nhập lại). Vai trò: tài khoản trong `QC_USERS`
(phân tách bằng dấu phẩy) là QC; để trống thì admin CVAT là QC; còn lại là annotator. Sai mật khẩu 8 lần trong 10 phút thì
khoá 10 phút. Token `CVAT_TOKEN` vẫn là quyền đọc dữ liệu của dịch vụ, người dùng không thấy.

Chạy trên máy chủ cho cả nhóm: đặt `QC_HOST=0.0.0.0`, chỉ mở trong mạng nội bộ (trang chạy http, chưa có TLS).

## Làm gì

Tool chỉ giảm việc lượt đầu cho QC (xếp chỗ cần xem trước, kèm số đo); QC vẫn kiểm cả job.

- **Quét job**: tải point cloud từng gói frame qua API CVAT, dựng box ở mọi frame như CVAT hiển thị (keyframe + nội suy).
- **Luật theo từng box, chung với bảng annotator** (`extension/src/annotator/`): mặt đất, kích thước theo class, lệch trong
  track, box rỗng, chồng lấn, spec người lái / người trong xe, thuộc tính bắt buộc, phạm vi; hướng nhảy giữa keyframe.
- **Luật chỉ QC** (`lib/trackrules.js`, cần nhìn nhiều frame, hợp với pre-label): box nhảy trong một frame, đổi ID giữa hai
  track, đứt track (một vật hai ID: ghép một-một bằng Hungarian, kiểm bằng point cloud ở chỗ nối, `lib/evidence.js`), một
  vật vẽ hai lần. Chuyển động xe thu khớp từ point cloud (`lib/icp.js`, CVAT không lưu pose).
- **Hình nhìn từ trên** cho mục đứt track: điểm LiDAR, box hai đoạn và chỗ mỗi vật lẽ ra ở, đọc thẳng từ CVAT khi bấm.
- **Duyệt Job** (theo Figma "PointSnap 3D"): mức ưu tiên xem (không phải ĐẠT / KHÔNG ĐẠT), dải mật độ lỗi theo frame, phân bố
  theo quy tắc, phạm vi kiểm tra (gồm phần tool không kiểm và số box tool không đo được), danh sách lỗi & cảnh báo với Mở
  CVAT đúng frame / object (mục theo cặp ghi cả hai), ✓ Đúng / ✕ Báo nhầm, xuất CSV / JSON.
- **Mọi Object & Tiến độ**: mọi track / shape (kể cả object tool không báo gì), tiến độ duyệt bắt buộc, chỉ hoàn thành job
  khi đủ 100%; "Xem tiếp" đi lần lượt (phím 1 OK, 2 trả lỗi, 3 báo nhầm, J / K, Esc) và mở CVAT trong một tab dùng chung;
  duyệt nhanh nhóm vật đứng yên; track bị sửa sau khi duyệt (dấu vân tay đổi) tự về "Chưa xem". Sáng / tối.
- **Tab Guideline**: theo project, bật / tắt luật, ngưỡng, khoảng kích thước, thuộc tính bắt buộc, cặp được chồng, nhập /
  xuất JSON (nhận file Export của extension); mỗi lần lưu là một phiên bản, khôi phục được; job quét theo bản cũ thì trang
  nhắc quét lại.
- **Bảng nổi trên CVAT** (Edge / Chrome ≥ 116): khi "Xem tiếp", một cửa sổ nhỏ luôn nằm trên CVAT có OK / Trả lỗi / Báo
  nhầm / Lùi / Tiếp và phím tắt; mỗi bước tự mở object kế tiếp trong tab CVAT. QC không phải chuyển qua lại giữa hai tab.
- **Trả lỗi nhanh, gửi một lượt** (QC → annotator → QC): trả lỗi (✕, phím 2, hoặc ở mục tool báo) chỉ hỏi nhãn lỗi (lỗi tool
  báo đã chọn sẵn), frame thấy lỗi, ghi chú. Lỗi gom lại; **Gửi N lỗi cho annotator** tạo mỗi object một phiếu BUG-###.
  Annotator thấy ở tab **Việc của tôi** (chỉ phiếu của mình): hàng đợi lỗi, mở CVAT đúng object và frame, trả lời, **Nộp
  lại**. Lúc nộp, dịch vụ đọc lại object trên CVAT: chưa đổi gì (quên Lưu) thì báo cả annotator lẫn QC. QC **Nghiệm thu
  đạt** hoặc **Trả lại sửa tiếp**; nghiệm thu ghi theo bản đã sửa, quét lại không bắt duyệt lần nữa. Job chỉ hoàn thành khi
  đủ 100% object, đã gửi hết lỗi và nghiệm thu hết phiếu. Annotator không xem được kết quả quét hay guideline editor.
- **Làm ngay trong trang CVAT** (thử trên CVAT local): plugin `public/plugin.js` được nginx của CVAT chèn vào trang. Dịch vụ
  đặt ở `/pointsnap-qc/` cùng địa chỉ CVAT, nhận người dùng từ phiên đăng nhập CVAT. QC xem lần lượt object, chuyển frame
  và chọn box không tải lại trang; annotator sửa và nộp phiếu tại chỗ. Cài / gỡ:
  [docs/qc-plugin-cvat.md](../docs/qc-plugin-cvat.md). Extension (nếu dùng) kết nối bằng token tạo ở menu tài khoản:
  [docs/qc-extension-api.md](../docs/qc-extension-api.md).

Thử nghiệm 2 vòng QC ↔ annotator với lỗi cài biết trước, và số đo sau khi sửa luật box nhảy:
[docs/qc-thu-nghiem-2-vong.md](../docs/qc-thu-nghiem-2-vong.md).

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
bản guideline theo project, `objects/` duyệt từng object, `tickets/` phiếu giao việc. Dữ liệu point cloud không lưu lại: đọc từ CVAT, quét xong bỏ.

## Test

`node --test qc/test/*.test.js`
