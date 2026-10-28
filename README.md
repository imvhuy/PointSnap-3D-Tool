# PointSnap 3D

Công cụ giúp gán nhãn và kiểm duyệt cuboid 3D (LiDAR) trên CVAT. Dữ liệu không rời CVAT: extension chạy trong trang
CVAT, dịch vụ QC đọc CVAT bằng access token và chạy trong mạng nội bộ.

| Thư mục | Dành cho | Là gì |
|---|---|---|
| [`extension/`](extension/README.md) | Annotator | Extension Edge / Chrome: bảng PointSnap trong trang job 3D của CVAT (đo box, mặt đất, kích thước theo spec, hướng, track, hoàn tác) |
| [`qc/`](qc/README.md) | QC + annotator | Dịch vụ Node (không thư viện ngoài): quét cả job, QC duyệt 100% object, trả lỗi, giao annotator sửa, nghiệm thu |
| [`docs/`](docs/) | Mentor, nhóm | Pain point và giải pháp, thiết kế tool QC, báo cáo dự án |

Dịch vụ QC dùng lại các module luật của extension (`extension/src/annotator/`), nên annotator và QC đo box theo cùng một
cách.

## Chạy nhanh

- **Extension**: `edge://extensions` (hoặc `chrome://extensions`) → bật Developer mode → Load unpacked → chọn `extension/`.
  Chi tiết: [extension/README.md](extension/README.md).
- **QC**: Node ≥ 20. Chép `qc/.env.example` thành `qc/.env.local`, điền `CVAT_URL` và `CVAT_TOKEN`, rồi chạy:

```bash
node qc/server.js
```

  Mở <http://127.0.0.1:8766> và đăng nhập bằng tài khoản CVAT. Chi tiết: [qc/README.md](qc/README.md).

## Test

```bash
node --test qc/test/*.test.js extension/tests/*.test.js
```

## Tài liệu

- [Pain point khi gán nhãn cuboid 3D và cách giải quyết](docs/pain-points-va-giai-phap.md)
- [Tool scan QC: phân tích và thiết kế](docs/qc-scan-phan-tich-thiet-ke.md)
- [Báo cáo dự án (12/10/2026)](docs/bao-cao-du-an.md)

Backend Python cũ (`pointsnap/`, ~27 000 dòng) đã gỡ ngày 28/10/2026; xem lịch sử git nếu cần.
