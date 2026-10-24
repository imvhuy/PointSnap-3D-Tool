# PointSnap 3D (Clean Edition)

**Công cụ Kiểm soát & Đảm bảo Chất lượng Nhãn 3D Bounding Cuboid trên CVAT**  
*Bản mã nguồn tinh gọn và tài liệu kiến trúc phục vụ Rebuild & Phát triển nâng cao.*

---

## 📂 Cấu trúc thư mục

Thư mục này được trích xuất tinh gọn, chỉ chứa mã nguồn vận hành chính và tài liệu chuyên sâu:

```
pointsnap-clean/
├── pointsnap/             # Mã nguồn Core Backend (Python)
│   ├── core/              # Thuật toán hình học, ground estimation (RANSAC), data models, scanner
│   ├── detectors/         # Các bộ kiểm tra hình học: floating, size, heading, fit, spec, lidar
│   ├── cli/               # Giao diện dòng lệnh CLI (pointsnap scan, audit, ui)
│   ├── web/               # FastAPI backend & Giao diện Web Portal (HTML5, JS, CSS)
│   ├── adapters/          # Đầu nối đọc dữ liệu CVAT REST API, nuScenes, PandaSet
│   ├── guidelines/        # File cấu hình quy chuẩn gán nhãn YAML (spec-vn.yaml)
│   └── vision/            # Module mở rộng AI/Model thị giác 2D (tùy chọn)
│
├── extension/             # Mã nguồn Chrome Extension (Manifest V3) cho CVAT
│   ├── src/               # Content scripts, Background service worker, HUD thước đo 3D
│   ├── manifest.json      # Khai báo extension
│   └── icons/             # Icon extension
│
├── docs/                  # Hệ thống tài liệu & Hướng dẫn kỹ thuật
│   ├── PAIN_POINTS_AND_ARCHITECTURE_GUIDE.md # TÀI LIỆU QUAN TRỌNG NHẤT: Pain points, bài học thực chiến & Blueprint
│   ├── ARCHITECTURE.md    # Mô tả kiến trúc hệ thống hiện hữu
│   ├── ARCHITECTURE_DIAGRAMS.md # Sơ đồ luồng dữ liệu & kiến trúc Mermaid
│   ├── CONVENTIONS.md     # Quy ước lập trình, hệ tọa độ, đơn vị đo
│   ├── manual-repair.md   # Đặc tả giao diện sửa tay và cơ chế an toàn
│   └── workspace-v3.md    # Hướng dẫn workspace và cơ chế kết nối CVAT
│
├── pyproject.toml         # Cấu hình cài đặt package Python
├── .env.example           # Biến môi trường mẫu (CVAT Token, URLs)
├── Dockerfile             # Container build image
└── compose.yaml           # Docker Compose cấu hình dịch vụ
```

---

## 🚀 Khởi chạy nhanh

### 1. Cài đặt Backend
```bash
# Tạo môi trường ảo
python -m venv .venv

# Kích hoạt trên Windows PowerShell
.\.venv\Scripts\Activate.ps1

# Cài đặt package ở chế độ editable
pip install -e .
```

### 2. Khởi chạy Web Portal
```bash
pointsnap ui
# Truy cập giao diện tại: http://localhost:8765/app
```

### 3. Cài đặt Chrome Extension
1. Mở trình duyệt Chrome / Edge, truy cập `chrome://extensions/`.
2. Bật chế độ **Developer mode** (Góc trên bên phải).
3. Bấm **Load unpacked** và chọn thư mục `pointsnap-clean/extension`.

---

## 📖 Bắt đầu từ đâu khi Rebuild?

Hãy đọc file tài liệu:
👉 **`docs/PAIN_POINTS_AND_ARCHITECTURE_GUIDE.md`**

Tài liệu này tổng hợp:
1. Chi tiết 3 pain points thực tế: **P-010** (Z-grounding), **P-011** (Pre-review Auto QA), **P-012** (Scene clutter).
2. Tại sao thuật toán hình học bắt đứt gãy track lại thất bại và bị loại bỏ hoàn toàn.
3. Tại sao bỏ tự động sửa box (v1) chuyển sang hỗ trợ đo đạc trực quan bằng HUD (v2 - QĐ-010).
4. Bản thiết kế kiến trúc Clean Architecture & Headless Core để tái xây dựng hoàn hảo.