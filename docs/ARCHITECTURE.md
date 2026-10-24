# Kiến trúc PointSnap 3D — Architecture Walkthrough

Mốc Git ban đầu: `main`, commit `98e04f5`, 18/10/2026. Working copy có thay đổi chưa commit; xem [phạm vi đối chiếu](tai-lieu/README.md#phạm-vi-đối-chiếu). Mức tin cậy **Cao**: thấy trực tiếp trong mã/cấu hình/test; **Trung bình**: cần kiểm chứng ở runtime; **Thấp**: chưa đủ bằng chứng. Các sơ đồ ở [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md).

## 1. Executive Summary

PointSnap 3D 0.3.0 kiểm tra chất lượng nhãn cuboid 3D trên CVAT, xuất finding/báo cáo và hỗ trợ người dùng sửa tay bằng thước đo. Web workspace và extension trao đổi với backend tại máy. Scanner dùng các detector và nguồn dữ liệu cảm biến; thao tác gắn cờ chỉ chạy khi được yêu cầu. Các route áp dụng/hoàn tác sửa hình học trả HTTP 410.

Rủi ro chính: dữ liệu thiếu bằng chứng, coupling tới nội bộ CVAT, kết quả benchmark phụ thuộc tập/máy, và tài liệu v1 còn tồn tại. Hồ sơ được tổ chức theo [sáu hạng mục](tai-lieu/README.md); các snapshot cũ được giữ nguyên để đối chiếu.

## 2. Repository Purpose

Repository gồm Python package, CLI, Web, extension MV3, API báo cáo bổ sung, công cụ đánh giá và hồ sơ nhóm. Người dùng chính là annotator/reviewer nhãn LiDAR. CVAT lưu nhãn và thực hiện Save/Undo/Redo; PointSnap cung cấp phát hiện, số đo và kết luận có điều kiện theo guideline.

Mã nguồn chính nằm ở `source-tool/pointsnap-3d/pointsnap/` và `source-tool/pointsnap-3d/extension/`. Bản trong outputs là bản xuất lịch sử, không phải entry point phát triển.

## 3. Audience Guide

- **Lập trình viên mới:** đọc README, [danh mục mã nguồn](tai-lieu/ma-nguon.md), SRS, SDD và các entry point bên dưới.
- **Lead/người tiếp nhận:** xem sơ đồ, báo cáo kiểm thử, giới hạn nghiệm thu và nhật ký tuần.
- **AI coding agents:** đọc `source-tool/pointsnap-3d/CONVENTIONS.md`, `source-tool/pointsnap-3d/docs/manual-repair.md`, `source-tool/pointsnap-3d/docs/workspace-v3.md` và quyết định của nhóm trước khi sửa. Giữ nguyên định danh finding, hệ tọa độ và ranh giới sửa tay.

## 4. System Context

CVAT REST API cung cấp task/job/annotations; dữ liệu nuScenes/PandaSet hoặc manifest cung cấp cloud/pose/calibration/camera. Web và MV3 dùng FastAPI của workspace. ProjectManager lưu cấu hình/kết quả trên đĩa. Camera, Box Critic và learning là các nhánh theo cấu hình, không mặc nhiên hoạt động chỉ vì module tồn tại.

Không thấy PostgreSQL/Redis/Celery trong luồng workspace chính. CVAT có hạ tầng riêng ngoài ranh giới package này. Sơ đồ không giả định cấu trúc hạ tầng nội bộ của CVAT.

## 5. Main Entry Points

| Điểm vào | Loại | Vai trò và bằng chứng | Tin cậy |
|---|---|---|---|
| `source-tool/pointsnap-3d/pyproject.toml` | Package | console script pointsnap → cli.main:main | Cao |
| `source-tool/pointsnap-3d/pointsnap/cli/main.py` | CLI | argparse, nạp config, dispatch scan/gate/nuscenes/eval/learn/ui | Cao |
| `source-tool/pointsnap-3d/pointsnap/web/app.py` | Web/API | create_app; project, scan, review, guide/evaluate, extension | Cao |
| `source-tool/pointsnap-3d/pointsnap/web/runner.py` | Background worker | ScanRunner; đọc CVAT, quét, báo cáo và cờ tùy chọn | Cao |
| `source-tool/pointsnap-3d/extension/manifest.json` | Trình duyệt | content scripts, background.js service worker | Cao |
| `source-tool/pointsnap-3d/pointsnap/api.py` | HTTP API bổ sung | API báo cáo dùng PAT người gọi | Cao |
| `source-tool/pointsnap-3d/compose.yaml` | Container | pointsnap CLI và pointsnap_api cạnh mạng CVAT | Cao về cấu hình; chưa chạy lại Docker |

## 6. Major Components

| Khối | Sở hữu | Giao diện / phụ thuộc | Ranh giới |
|---|---|---|---|
| CLI | Tham số, cấu hình, mã thoát | Các module lệnh gọi scanner/gate/report/adapters | I/O và environment ở điểm chạy |
| Web | Dự án, scan, review, guide, preview, bridge | FastAPI và manager/runner | app.py tập trung nhiều route; cần test khi đổi contract |
| Core | Cuboid/FrameData/Finding, hình học, config, scanner, gate | FrameSource protocol, detector functions | Scanner có import JobData của CVAT; chưa hoàn toàn độc lập adapter |
| Detector | Bằng chứng hình học/camera/spec | Cuboid, config, dữ liệu cảm biến, model tùy chọn | Có điều kiện khả năng quan sát và evidence gate |
| Adapter/data | CVAT REST, nuScenes, PandaSet, PCD | HTTP/files → kiểu dữ liệu chung | Writer kiểm cạnh tranh và bảo toàn hình học khi gắn cờ |
| Extension | Đọc CVAT, HUD, sự kiện và lựa chọn | cvat-compat.js, proxy service worker, API workspace | Phụ thuộc store/camera CVAT cần thử browser thật |
| Report/eval/learn | HTML/CSV, thống kê, học từ review | Finding và kết quả duyệt | Benchmark/proxy khác precision xem tay |

## 7. Data and Control Flow

1. Web kiểm runtime/model theo project; người dùng chọn job và yêu cầu scan. Model được đánh dấu bắt buộc (`required`) mà chưa sẵn sàng chặn quét. Trong working copy đã rà, SAM cho box-fit là tùy chọn: thiếu điều kiện thì công bố fallback sang LiDAR, không phải mọi model được chọn đều tạo blocker.
2. ScanRunner tạo run và xếp hàng vào ThreadPoolExecutor (mặc định một worker, tối đa 16 pending).
3. Adapter đọc job/annotation; runner lưu snapshot trước gắn cờ; frames_for_job nạp nguồn đúng mapping.
4. Scanner tạo DetectionContext, chọn và gọi detector **tuần tự** theo config; lọc rule, evidence gate và sắp finding.
5. Runner tính coverage/gate, xuất HTML/CSV, lưu findings/summary/trạng thái; flag_job_errors chỉ gọi khi được yêu cầu.
6. Reviewer lưu kết luận theo project/run/finding index. Web/extension đồng bộ theo CVAT origin và job.
7. Người dùng sửa tay trong CVAT; guide/evaluate chỉ đọc/đo nhãn nháp. Sau Save, guide cũ mất hiệu lực, phải quét lại.

Nút/API gắn cờ từ một run đã hoàn tất khởi tạo **lượt quét mới** với flag=True và trả run_id mới; không ghi trực tiếp findings của run cũ. Client theo dõi run mới để xem kết quả gắn cờ.

Side effects thấy trong mã: HTTP CVAT, đọc cloud/ảnh/model, ghi file, thread nền và thời gian tạo run. Queue không phải dịch vụ bền vững; run gián đoạn được đánh dấu failed khi đọc lại sau restart.

Hợp đồng: Cuboid kiểm số hữu hạn/kích thước dương; FrameSource cấp dữ liệu từng frame; Finding giữ định danh gốc; GuideContext/evaluate có revision và độ đầy đủ ngữ cảnh. [SDD](tai-lieu/thiet-ke/SDD.md) mô tả trường dữ liệu và route chính.

## 8. Runtime, Configuration, and Deployment

Package yêu cầu Python >=3.10. Chạy từ thư mục source-tool/pointsnap-3d:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pointsnap ui
```

Web workspace mặc định cổng 8765, màn chính /app. Cấu hình dựa trên `source-tool/pointsnap-3d/pointsnap/config.yaml`, guideline project, `.env` và POINTSNAP_HOME. Token lưu tách metadata; không đưa giá trị token vào hồ sơ.

Triển khai bổ sung được mô tả trong `source-tool/pointsnap-3d/README-Docker.md`: compose khai báo API báo cáo cổng 8081 sau Traefik với prefix /pointsnap. Đây là điểm chạy khác FastAPI workspace 8765; không đồng nhất hai dịch vụ. Compose còn dùng image tag mặc định 0.1.0, cần đối chiếu bản build khi triển khai 0.3.0.

Đóng gói bằng `python -m build` tại thư mục package; workflow có cài wheel ở môi trường riêng và smoke ngoài source. Đợt sắp xếp này không xác nhận lại deployment Docker hoặc model GPU.

## 9. Testing and Verification

CI hiện có: pytest tests + auto-tests trên Python 3.10/3.11 Ubuntu và 3.12 Windows; build artifact; Node 22 extension. E2E suite và browser thật là tầng riêng. [TEST-PLAN](tai-lieu/kiem-thu/TEST-PLAN.md) và [TEST-REPORT](tai-lieu/kiem-thu/TEST-REPORT.md) ghi lệnh, kết quả và giới hạn.

Lệnh từ thư mục package:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests auto-tests
.\.venv\Scripts\python.exe -m pytest -q e2e_tests
node --test extension/tests/*.test.js
```

Từ gốc repository: `python tools/verify_repository_docs.py` kiểm hồ sơ và bảo toàn. Bộ verifier của skill có thể chạy bằng đường dẫn tuyệt đối tới verify_architecture_docs.py; các heading giữ tên tiếng Anh để dùng được gate này.

## 10. How to Navigate the Codebase

1. README → tai-lieu/README.md → SRS/SDD.
2. cli/main.py và web/app.py để hiểu entry point.
3. web/runner.py → core/scanner.py → detector tương ứng để theo một lượt scan.
4. core/model.py và CONVENTIONS.md để hiểu hình học/định danh.
5. web/guides.py → extension/src/manual-controller.js, manual-geometry.js, cvat-compat.js để theo sửa tay.
6. Test cùng lĩnh vực trước khi sửa; review theo ngày chỉ dùng với đúng mốc được ghi.

Các tên ngắn trong thứ tự đọc này được đặt trong thư mục package hoặc extension đã nêu ở mục 2; [danh mục mã nguồn](tai-lieu/ma-nguon.md) có liên kết trực tiếp.

## 11. Safe Change Guide for Humans and AI Agents

AI agents và người sửa cần đọc convention/quyết định, manual-repair và workspace-v3. Khoanh vùng thay đổi theo feature; giải thích phạm vi mở rộng khi một contract ảnh hưởng Web + scanner + extension.

- Không dùng bản source trong outputs làm điểm sửa chính. Môi trường, cache, egg-info, build và kết quả sinh ra không là mã tác giả cần refactor.
- Đổi detector: test trường hợp lỗi và nhãn sạch, thiếu điểm/pose/camera, gate và hiện thị finding.
- Đổi guide: test revision, context_complete, complete_frames và Save invalidation. HTTP 410 của API ghi hình học v2 là contract.
- Đổi adapter/writer: test source ID, mapping server/task, nội suy và bảo toàn hình học; chạy thử ghi chỉ trên job kiểm thử được phép.
- Đổi CVAT hook: Node test + thử MV3/CVAT thật; unit test không chứng minh tương thích canvas thật.
- Bảo toàn tài liệu lịch sử, dữ liệu local và nội dung người dùng. Xem manifest trước khi chuyển file.

## 12. Assumptions and Items Needing Human Validation

| Mục | Cần xác minh | Tác động | Tin cậy hiện tại |
|---|---|---|---|
| CVAT thực tế | Phiên bản server và các capability store/camera trên môi trường nộp | Tương thích MV3/HUD | Trung bình: có code/test, chưa chạy browser ở đợt này |
| Model/dataset | Trọng số, calibration, mapping và nguồn dữ liệu của người dùng | Độ đúng của finding | Chưa xác minh runtime |
| Precision | Chấm tay trên tập độc lập, riêng từng luật | Nghiệm thu chất lượng | Chưa nghiệm thu đầy đủ theo review PR81 |
| Docker bổ sung | Image tag/command và kết nối CVAT ở môi trường triển khai | Deployment 8081 | Chưa chạy lại |

### Validation notes

Đã phân biệt FastAPI workspace với API báo cáo; sơ đồ không thêm database/queue ngoài mã. README cũ có badge và số chất lượng theo snapshot; bản gốc được giữ trong hồ sơ bảo toàn và nội dung lịch sử, không dùng làm kết quả kiểm thử mới. Tài liệu v1 có apply/rollback và track mặc định khác hiện tại; SRS/SDD ghi contract 0.3.0. Mockup A13 thiếu support.js ngay từ trước sắp xếp; không tự tạo dữ liệu thay thế.

## 13. Suggested Architecture Improvements

| Category | Recommendation | Evidence | Senior Developer Rationale | Manager Rationale | Effort | Risk | Priority |
|---|---|---|---|---|---|---|---|
| Documentation/context | Đồng bộ một bảng phiên bản/contract giữa các tài liệu | README cũ, PROJECT v1/v2, manual-repair | Giảm hiểu sai route lịch sử | Giảm thời gian bàn giao | S | Thấp | P1 |
| Verification/guardrail | Chạy kiểm hồ sơ và link ở CI | tools/verify_repository_docs.py mới; workflow hiện chưa gọi | Bắt link hỏng sau chuyển file | Hồ sơ nộp dễ kiểm tra | S | Thấp | P2 |
| Runtime/operations | Kiểm và ghi rõ phiên bản image của API bổ sung | compose.yaml dùng tag 0.1.0 | Tránh chạy nhầm artifact | Giảm lỗi triển khai | S | Thấp | P2 |
| Contract/schema | Giữ test capability CVAT thật theo phiên bản được hỗ trợ | cvat-compat.js và manual browser script | Xác minh cạnh extension → CVAT ngoài mock | Giảm rủi ro demo | M | Thấp | P1 |
| Boundary/modularity | Ghi rõ dependency JobData trong scanner trước khi thêm adapter mới | core/scanner.py import adapters.cvat.reader | Không giả định core hoàn toàn tách CVAT | Dự toán tích hợp thực tế | S | Thấp | P3 |

## 14. Glossary

| Từ | Ý nghĩa |
|---|---|
| Cuboid | Hộp 3D gồm tâm, kích thước, góc và định danh |
| Finding | Phát hiện theo luật kèm frame, mức và bằng chứng |
| FrameSource | Protocol cung cấp point cloud/pose theo frame |
| Gate | Điều kiện ĐẠT/KHÔNG ĐẠT theo ngưỡng và coverage |
| Guide / evaluate | Tham chiếu đo và kiểm lại nhãn nháp, không lưu hình học |
| MV3 | Manifest V3, mô hình extension với service worker |
| Held-out / precision | Tập tách khỏi tinh chỉnh / tỷ lệ đúng trong các finding đã kết luận |

## 15. Appendix: Evidence Map

| Kết luận / cạnh kiến trúc | Bằng chứng trực tiếp | Tin cậy |
|---|---|---|
| Web → runner → scanner → report/CVAT | `source-tool/pointsnap-3d/pointsnap/web/runner.py` | Cao |
| Scanner chọn detector và xử lý tuần tự | `source-tool/pointsnap-3d/pointsnap/core/scanner.py` | Cao |
| Gắn cờ có bảo vệ hình học | `source-tool/pointsnap-3d/pointsnap/adapters/cvat/writer.py`, `source-tool/pointsnap-3d/tests/test_cvat_writer.py` | Cao |
| File storage và xử lý restart | `source-tool/pointsnap-3d/pointsnap/web/projects.py`, `source-tool/pointsnap-3d/pointsnap/web/runner.py` | Cao |
| Guide/evaluate và HTTP 410 | `source-tool/pointsnap-3d/pointsnap/web/app.py`, `source-tool/pointsnap-3d/tests/test_manual_guides.py` | Cao |
| MV3 và hook CVAT | `source-tool/pointsnap-3d/extension/manifest.json`, `source-tool/pointsnap-3d/extension/src/cvat-compat.js` | Cao về mã |
| API báo cáo riêng trong Docker | `source-tool/pointsnap-3d/pointsnap/api.py`, `source-tool/pointsnap-3d/Dockerfile.api`, `source-tool/pointsnap-3d/compose.yaml` | Cao về cấu hình |
| Giới hạn benchmark/precision | `review/2026-10-18/pr81-review.md` | Cao về nội dung báo cáo; không phải tái đo |
| Các gate CI đang khai báo | `.github/workflows/test.yml` | Cao |
