# Quy ước dùng chung

Mọi module (core, adapter, báo cáo) theo đúng quy ước trong file này. Đổi quy ước thì sửa file này **trong cùng PR**.

Ký hiệu: ✅ đã xác minh · ⬜ chưa xác minh (ghi việc sẽ xác minh)

## 1. Hệ tọa độ trong core

| Mục | Quy ước |
|---|---|
| Đơn vị | Mét, giây, radian |
| Hệ trục | Tay phải, **z hướng lên** |
| Box nằm trong hệ nào | Hệ tọa độ point cloud của chính frame đó. Khi xuất sang CVAT (`to-cvat`, A2), chuyển sang hệ **xe thu** bằng `(x,y,z) → (y,-x,z)`, yaw mới = yaw cũ − π/2: quay **−90°** theo quy ước toán học nhìn từ +z. Hệ xe thu: x trước, y trái, z lên ([QĐ-008](../../so-quyet-dinh.md#qđ-008)); dùng đúng `LIDAR_TO_EGO_ROT` cho point cloud, box và pose |
| `Cuboid.center` | Tâm hình học của box |
| `Cuboid.dims` | `(length, width, height)`. **length nằm dọc trục x local của box** (hướng đầu xe, [QĐ-008](../../so-quyet-dinh.md#qđ-008)), width theo y local, height theo z |
| `Cuboid.yaw` | Góc quay quanh trục z, đi từ trục +x của hệ point cloud tới trục x local của box, ngược chiều kim đồng hồ nhìn từ trên xuống. Luôn chuẩn hóa về [-π, π) |
| Roll, pitch | Core coi bằng 0. Adapter giữ giá trị gốc trong `attrs` để ghi ngược lại không bị mất |
| Đáy box | `bottom_z = center_z − height / 2` |
| Thứ tự 8 góc (`geometry.corners`) | 4 góc đáy rồi 4 góc nóc; mỗi mặt đi ngược chiều kim đồng hồ từ góc trước-trái: (+l, +w), (−l, +w), (−l, −w), (+l, −w) |

## 2. CVAT: cuboid 3D

✅ Xác minh trong mã nguồn CVAT 2.77.1 (commit `4b017e6`, `D:\Work\cvat`):

| Mục | Giá trị | Nguồn |
|---|---|---|
| `points` của shape `cuboid` trong task 3D | 16 số: `[px, py, pz, rx, ry, rz, sx, sy, sz, 0, 0, 0, 0, 0, 0, 0]` | `cvat/apps/dataset_manager/bindings.py` (đọc `dm_points[0:3]`, `[3:6]`, `[6:9]`; ghi thêm 7 số 0) |
| `px, py, pz` | Tâm hình học: box là `BoxGeometry(1, 1, 1)` đặt tại gốc rồi dịch tới position | `cvat-canvas3d/src/typescript/cuboid.ts` |
| `rx, ry, rz` | Góc Euler (radian), thứ tự XYZ mặc định của three.js | `cuboid.ts` (`rotation.set(x, y, z)`) |
| `sx, sy, sz` | Kích thước đầy đủ theo trục x, y, z local | `canvas3dView.ts` (`setScale(points[6], points[7], points[8])`) |

**Ánh xạ sang core:** `Cuboid(center=(px, py, pz), dims=(sx, sy, sz), yaw=rz)`, giữ `rx, ry` trong `attrs` (`cvat_rx`, `cvat_ry`).
Ghi ngược lại: `points = [*center, rx, ry, yaw, *dims, 0, 0, 0, 0, 0, 0, 0]` (`adapters/cvat/shapes.py`).

**Task do `pointsnap nuscenes to-cvat --upload` tạo** (`datasets/nuscenes/to_cvat.py`):
- 10 label kiểu `cuboid`; mỗi label có thuộc tính `pointsnap_error` (text) và `reviewed` (checkbox), cả hai `mutable` (giá trị riêng từng frame).
- Dữ liệu tải lên là một file zip các `.pcd` tên `000000.pcd`, `000001.pcd`, …; CVAT sắp frame theo tên (`sorting_method=lexicographical`), nên frame CVAT = frame trong `manifest.json`.
- Mỗi đối tượng nuScenes là một track. Trong CVAT một track kéo dài tới cuối job cho tới khi gặp keyframe `outside`, nên: sau frame cuối của track thêm một keyframe `outside`. Từ C2 (spec 4.4, `core.model.add_track_markers`): track khuyết ≤ 6 frame ở giữa thì thêm keyframe `occluded` (vị trí nội suy) ở frame đầu đoạn vắng và giữ track; khuyết lâu hơn thì thêm `outside` sau frame có mặt cuối cùng và phần sau thành track mới.
- `--taxonomy spec-vn` (C2): 5 label theo spec giao thông VN (`Vehicle`, `Two-wheels`, `Pedestrian`, `Animal`, `Obstacle`), mỗi label thêm thuộc tính `select` (mutable) theo `datasets/taxonomy.py`; giá trị lấy từ category và thuộc tính của nuScenes. Quét task này với `--config pointsnap/guidelines/spec-vn.yaml`.
- Bản xuất ghi kèm `manifest.json` (frame ↔ file ↔ `sample_token` ↔ `sensor_to_world`), `ground_truth.json` (nhãn chuẩn) và sau khi tải lên là `cvat_task.json` (id task, id job).

Xác minh trên CVAT 2.77.1 chạy thật (06/10, task thử tạo từ bộ nuScenes giả; `tests/test_live_cvat.py`):
- [x] Gửi box qua API rồi đọc lại: tâm, kích thước, yaw khớp tuyệt đối (lệch 0 mm, 0 rad).
- [x] API chỉ nhận `Accept: application/vnd.cvat+json`; gửi `application/json` bị HTTP 406.
- [x] `GET /api/jobs/<id>/annotations`: mỗi track chỉ chứa **keyframe nhập tay**; mỗi keyframe có `id`, `frame`, `outside`, `points`, `attributes`. Keyframe `outside=true` nằm ở frame đầu tiên đối tượng vắng mặt.
- [x] `GET /api/tasks/<id>/data/meta`: `frames[].name` theo đúng thứ tự frame (`000000.pcd`, …) → dùng để khớp với `manifest.json`.
- [x] Link mở thẳng một frame và đối tượng: `<url>/tasks/<task>/jobs/<job>?frame=<n>&type=<track|shape>&serverID=<id>` (route `/tasks/:tid/jobs/:jid`, tham số `frame`, `type`, `serverID` trong `cvat-ui`, tương đương tính năng "Copy object URL" của CVAT; box thuộc track dùng `type=track&serverID=<track_id>`, shape lẻ dùng `type=shape&serverID=<shape_id>`).
- [ ] Trục lên của canvas 3D là +z, box nhìn đúng trên point cloud thật (kiểm bằng mắt ở G0).
- [x] Ghi / gỡ thuộc tính `pointsnap_error` qua API (`PATCH /api/jobs/<id>/annotations?action=update`), hình học box không đổi (`tests/test_live_cvat.py`, A4). CVAT xử lý `update` bằng cách **xóa rồi tạo lại** shape/track được gửi, nên phải gửi nguyên track với đủ keyframe lấy từ `GET`; không dựa vào id shape để so trước/sau.
- [x] Mỗi lần `scan --flag` đồng bộ cờ: box hết lỗi được gỡ cờ cũ; cờ chỉ ghi vào box khớp đúng id (không gắn cả frame khi finding thiếu id).
- [ ] Lọc box có cờ trong canvas 3D (kiểm bằng mắt ở G1).
- [ ] Phiên bản CVAT của BTC (`cvat.note.transformerlabs.ai`) có cùng định dạng `points`.

## 3. nuScenes v1.0-mini

Đã cài đặt trong `pointsnap/adapters/nuscenes/reader.py` (B1) và kiểm bằng bộ dữ liệu giả có đáp án tính tay (`tests/fake_nuscenes.py`).
⬜ Còn phải xác minh trên dữ liệu thật: box chuẩn nằm đúng trên các điểm của đối tượng (C3).

| Mục | Giá trị |
|---|---|
| Nhãn `sample_annotation` | `translation` = tâm box, **hệ toàn cục**; `size` = **[width, length, height]**; `rotation` = quaternion **[w, x, y, z]**, hệ toàn cục |
| Đổi nhãn về hệ LiDAR | toàn cục → xe thu (`ego_pose` của `sample_data` LIDAR_TOP) → cảm biến (`calibrated_sensor`) |
| Point cloud `.pcd.bin` | `float32`, 5 giá trị mỗi điểm: x, y, z, intensity, ring index. Không phải PCD chuẩn, phải chuyển đổi |
| Tần số keyframe | 2 Hz, cách nhau ≈ 0,5 giây. Box và point cloud dùng keyframe của `LIDAR_TOP`. Riêng luật lơ lửng / lún (mặt đất v2, C1) gộp thêm `floating.sweeps` lượt quét trung gian (20 Hz) ngay trước keyframe, đổi về hệ LiDAR của keyframe và bỏ điểm nằm trong box nội suy theo thời điểm từng sweep |
| Thứ tự frame | Đi theo chuỗi `first_sample_token` → `next` của cảnh; frame đánh số từ 0 |
| Track id | Số thứ tự của `instance` trong bảng `instance.json`: cố định giữa các lần chạy và giữa các cảnh |
| Class | Ánh xạ category nuScenes sang 10 class của task theo bảng chuẩn của bài toán detection nuScenes (`CATEGORY_TO_LABEL` trong `reader.py`). Category khác (động vật, xe cấp cứu, xe đẩy, xe lăn, vật cản rời, giá để xe…) bị bỏ qua |
| Box không có điểm | Bỏ box có `num_lidar_pts` < 1 (tham số `min_lidar_points`): người gán không thấy box đó trên point cloud. Vì vậy một track có thể khuyết vài frame ở giữa |
| Box nghiêng | Box nuScenes chỉ quay quanh trục z toàn cục; đổi sang hệ LiDAR có thể nghiêng nhẹ. Core giữ yaw, ghi góc nghiêng vào `attrs["tilt_rad"]` |

## 4. Mã luật và mức

| `rule` | Loại lỗi | Ý nghĩa |
|---|---|---|
| `floating` | Lơ lửng / lún | Khoảng cách đáy box tới mặt đất cục bộ vượt ngưỡng |
| `floating.no_evidence` | Lơ lửng / lún | Vành đai quanh box có quá ít điểm ground; mức Thông tin |
| `size.class_range` | Sai kích thước | l, w hoặc h nằm ngoài khoảng thường gặp của class. "Lớn bất thường" mà điểm LiDAR của vật lấp đầy ≥ 85% chiều đó (chở hàng, hình dạng đặc biệt) thì hạ Lỗi xuống Cảnh báo (C5) |
| `size.in_track` | Sai kích thước | Kích thước một keyframe lệch so với trung vị của track |
| `track.jump` | Đứt track | Tâm box lệch khỏi vị trí nội suy từ hai keyframe lân cận |
| `track.split_id` | Đứt track | Track kết thúc rồi một track cùng class bắt đầu ngay gần đó |
| `track.long_interpolation` | Đứt track | Đoạn dài chỉ có box nội suy trong khi đối tượng di chuyển (B5b) |
| `heading.flip` | Sai hướng box | Hướng box (hệ toàn cục) đổi giữa hai keyframe nhanh hơn tốc độ quay hợp lý: lật đầu, xoay ngang (C1) |
| `heading.motion` | Sai hướng box | Hướng box lệch / ngược hướng chuyển động khi vật chạy nhanh hơn `min_speed_mps` (C1, spec 4.2). Ngược chiều ở ≥ 80% đoạn mà vật chạy ≤ `reverse_max_mps` (xe 3 m/s): một mục Cảnh báo "có thể đang lùi" thay vì Lỗi từng frame (C5) |
| `heading.points` | Sai hướng box | Trục box lệch trục cụm điểm LiDAR (khớp hình chữ L), so với các frame khác của track (C1) |
| `fit.empty` | Box lệch khỏi vật | Vùng quanh box quét rõ nhưng trong box không có điểm nào cao hơn đáy box; box `occluded` thì bỏ qua. Mức Cảnh báo (C1) |
| `fit.outside` | Box lệch khỏi vật | Tỉ lệ điểm của vật (nối liền với điểm trong box) nằm ngoài box, so với trung vị các frame khác của track: box nhỏ hoặc lệch (C1) |
| `fit.loose` | Box lệch khỏi vật | Mặt box quay về phía LiDAR, không bị che, cách điểm gần nhất của vật quá xa: box dư (C1) |
| `fit.overlap` | Box lệch khỏi vật | Hai box cùng frame chồng nhau (phần chung / box nhỏ hơn), trừ cặp class được phép (C1) |
| `track.reuse_id` | Đứt track | Track đã kết thúc bằng `outside` rồi lại có box (spec 4.4.3–4.4.4). Mức Cảnh báo (C2) |
| `track.id_swap` | Đứt track | Hai track cùng nhóm đổi chỗ nhau ở một frame: mỗi box khớp quỹ đạo dự đoán của track kia hơn hẳn track mình (≤ 35% độ lệch khi giữ nguyên) (C5, spec 4.4.6) |
| `track.occluded_long` | Đứt track | `occluded` liên tục quá `track.max_occluded_frames` (6) frame (spec 4.4.5). Mức Cảnh báo (C2) |
| `attr.missing` | Thiếu / sai thuộc tính | Thiếu thuộc tính bắt buộc theo `spec.required_attributes` (spec 3.1.3). Mức Lỗi (C2) |
| `track.static_shift` | Đứt track | Vật đứng yên (các keyframe khác tụ trong 10 cm, hệ toàn cục) mà box ở một keyframe lệch > 20 cm (C3) |
| `heading.static` | Sai hướng box | Vật đứng yên mà hướng box ở một keyframe lệch > 4° (modulo 180°); không xét người, động vật, vật tròn / đối xứng (`static.yaw_excluded_classes`, ghi `Class` hoặc `Class/thuộc tính`) (C3, C5) |
| `cam.mismatch` | Box lệch khỏi vật | Phần mặt nạ vật cùng nhóm trên ảnh camera (Mask R-CNN) nằm ngoài khung chiếu 8 góc box cao hơn trung vị các frame khác của track > 20 điểm %; model ảnh không thấy vật thì bỏ qua; frame ban đêm bỏ qua. Mức Thông tin (`camera.mismatch_severity`) (C3, cần PyTorch) |
| `fit.offset` | Box lệch khỏi vật | Chọn điểm của vật quanh box (nới `box_fit.search_margin_m`, bỏ mặt đất / box khác) theo `box_fit.source`: `lidar` = điểm nối liền với box; `sam` = điểm rơi vào mặt nạ SAM 2.1 (prompt từ khung chiếu box + điểm LiDAR, cần ảnh camera + GPU). Fit lại box giữ kích thước, chỉ canh theo mặt thấy được (không bị che, không ra ngoài ảnh): tâm vật lệch tâm box > `box_fit.offset_warning_m` (Cảnh báo) / `offset_error_m` (Lỗi), kèm box đề xuất. Đo từng frame, không cần track. Tắt mặc định (`rules.fit_offset`); bật bằng `guidelines/box-fit.yaml` (LiDAR) hoặc `box-fit-sam.yaml` |
| `fit.yaw` | Sai hướng box | Cùng phép đo của `fit.offset`; xe đủ dài, đủ điểm và cụm điểm phủ ≥ ½ chiều dài: trục chữ L của cụm điểm lệch hướng box > `box_fit.yaw_warning_deg` / `yaw_error_deg` (modulo 90°), kèm hướng đề xuất. Tắt mặc định (`rules.fit_yaw`) |
| `cam.face` | Sai hướng box | Ngược đầu cả track, kể cả xe đứng yên: mỗi keyframe xe nhìn rõ trên ảnh, biết camera nhìn mặt đầu hay mặt đuôi box (chiếu box), hỏi CLIP zero-shot "đầu xe hay đuôi xe"; ≥ `face.min_votes` phiếu chắc chắn nói ngược và chiếm ≥ `face.vote_ratio` thì báo một mục cho cả track, kèm hướng đề xuất yaw + π cho mọi keyframe. Cần ảnh camera + GPU. Tắt mặc định (`rules.cam_face`) |
| `cam.class` | Thiếu / sai thuộc tính | Ở đa số (≥ 60%) lần nhìn rõ, vật trên ảnh trùng khung chiếu thuộc nhóm khác với nhãn (người / xe hai bánh / xe / động vật). Mức Cảnh báo (C3) |
| `cam.missing` | Box lệch khỏi vật | Ảnh thấy vật chắc chắn (điểm ≥ 0.85, cao ≥ 40 px, ≥ 15 điểm LiDAR) mà không có box 3D chiếu tới. Mức Thông tin, không gắn cờ CVAT (C3) |
| `critic.box` | Box lệch khỏi vật | Box Critic (model nhóm tự huấn luyện, `critic.model`) cho xác suất box sai ≥ 0.7, kèm gợi ý sửa (C3, `docs/huong-dan/huan-luyen-box-critic.md`) |
| `attr.height` | Thiếu / sai thuộc tính | Thuộc tính không khớp chiều cao box (trung vị đoạn cùng giá trị): `spec.attribute_height`, khóa `Class/giá trị[/giá trị]`. Mức Cảnh báo (C6) |
| `spec.inside` | Thiếu / sai thuộc tính | Tâm box vật trong nằm trong footprint box vật bao, đáy không cao hơn `inside_min_lift_m` (0,6 m): `spec.inside_forbidden`, vd người trong xe (spec 4.3B). Mức Cảnh báo (C6) |
| `spec.rider_double` | Thiếu / sai thuộc tính | Box người chồng ≥ 50% footprint lên box xe hai bánh `with_rider` cùng frame (spec 4.3C): `spec.rider_double`. Mức Cảnh báo (C6) |
| `lidar.missing` | Box lệch khỏi vật | Cụm điểm LiDAR (ngoài mọi box, giống người / xe hai bánh / xe, chân sát đất) **di chuyển** đều qua ≥ 3 keyframe (≥ 3 m; cỡ người ≥ 1,5 m qua ≥ 4 keyframe) và chỗ đứng cũ trống sau 1 s, mà không có box: nghi sót đối tượng (spec 4.2). Vật **đứng yên** chỉ báo khi ảnh camera (lớp 2) thấy vật cùng loại ở ≥ 2 keyframe. Mức Cảnh báo, không gắn cờ CVAT được (C7) |
| `attr.rider_state` | Thiếu / sai thuộc tính | Xe hai bánh `without_rider` chạy > 2,5 m/s ≥ 2 bước liền (quên đổi khi lên xe), hoặc `with_rider` đứng yên mà track người mới bắt đầu sát xe (≤ 1,2 m) và xe vẫn `with_rider` ≥ 2 keyframe sau (quên đổi khi xuống xe). `spec.rider_state`. Mức Cảnh báo (C8, spec 4.3C) |
| `cam.sparse` | Box lệch khỏi vật | Box ≤ `camera.sparse_max_points` (2) điểm LiDAR, nằm trong ảnh ban ngày, mà model 2D không thấy vật cùng nhóm (spec 4.2 không nên gán vật quá ít điểm). Một mục mỗi track, mức Thông tin (C8, cần PyTorch) |
| `attr.invalid` | Thiếu / sai thuộc tính | Giá trị ngoài `spec.allowed_values` (khóa `thuộc_tính` hoặc `Class.thuộc_tính`). Mức Lỗi (C2) |

**Box `occluded`** (thuộc tính `occluded` của CVAT, `Cuboid.occluded`): vật không nhìn thấy, vị trí do người gán ước
lượng. Mọi luật hình học (lơ lửng / lún, kích thước, nhảy vị trí, nội suy dài, hướng, box lệch) bỏ qua box này; chỉ
luật track theo spec dùng đến (C2).

Mức: `error` (Lỗi) · `warning` (Cảnh báo) · `info` (Thông tin). Câu thông báo luôn có số đo cụ thể, ví dụ *"Đáy box cách mặt đất 22 cm"*.

## 5. Cấu hình và bí mật

- Ngưỡng nằm trong `pointsnap/config.yaml`. Muốn thử ngưỡng khác: tạo file chỉ chứa phần cần đổi, chạy `pointsnap --config <file> ...`. Khóa gõ sai bị báo lỗi ngay.
- Bật / tắt luật (`rules:`): cho phép tắt/bật từng luật (`floating`, `size_class_range`, `size_in_track`, `track_jump`, `track_split_id`, `track_long_interpolation`; từ C1 thêm `heading_flip`, `heading_motion`, `heading_points`, `fit_empty`, `fit_outside`, `fit_loose`, `fit_overlap`). Bộ quét bỏ qua detector khi toàn bộ luật của nó bị tắt và lọc bỏ finding bị vô hiệu hóa khỏi kết quả. File cấu hình / guideline cũ không có khóa của luật C1 thì luật đó coi là bật; thiếu mục `heading:` hoặc `fit:` thì dùng ngưỡng mặc định.
- Cấu hình dự án (A11): lưu trữ tại `~/.pointsnap/projects/<slug>/` (`project.json`, `secret.json`, `guideline.yaml`, `runs/`).
- Token CVAT: lưu riêng trong `secret.json` hoặc biến môi trường `CVAT_TOKEN`; không ghi token trong file cấu hình hay `guideline.yaml`. API không bao giờ trả token ra ngoài.
- Thứ tự ưu tiên của URL CVAT, từ thấp tới cao: `config.yaml` mặc định → biến môi trường `CVAT_URL` → file `--config`. Trong giao diện Web, URL cấu hình ở dự án (`project.json`) luôn có độ ưu tiên cao nhất cho dự án đó.
- `CVAT_AUTH_SCHEME`: `Bearer` (mặc định, dùng cho Personal Access Token tạo trong giao diện CVAT) hoặc `Token` (token cũ lấy từ `/api/auth/login`).
- `NUSCENES_ROOT`: thư mục dữ liệu nuScenes, dùng làm mặc định cho `--dataroot`.
- Không commit dữ liệu nuScenes, file `.pcd`, báo cáo hay bản chụp nhãn (đã có trong `.gitignore`).

## 6. Gate và dữ liệu kiểm tra (review 01, 11/10/2026)

- `gate_verdict` trả `(passed, reasons)`; caller CLI/Web truyền `coverage_gaps` do `scan_coverage_gaps` xác định theo luật đang bật. Hàm gate không tự đọc dataset.
- Thiếu nguồn point cloud cho `floating`, `heading_points`, `fit_empty`, `fit_outside`, `fit_loose` trên job có box nhìn thấy: kiểm tra một phần, gate KHÔNG ĐẠT.
- Thiếu pose ở bất kỳ frame có box nhìn thấy thuộc track khi bật `track_jump`, `track_split_id`, `track_long_interpolation` (và `track.long_interpolation.enabled`), `heading_flip` hoặc `heading_motion`: gate KHÔNG ĐẠT. Kiểm tra ở cấp job mang tính bảo thủ, không suy ra pose đủ chỉ vì có `FrameSource`.
- `floating.no_evidence` giữ mức Thông tin, không ghi cờ lỗi hình học vào CVAT, nhưng chặn gate vì chưa đủ bằng chứng mặt đất. Các mục Thông tin khác không tự động chặn gate.
- Luật tắt không yêu cầu dữ liệu; `fit.overlap`, kích thước, thuộc tính và luật vòng đời track có thể chạy không cần LiDAR. ĐẠT chỉ có nghĩa đạt ngưỡng trong cấu hình đã dùng, không chứng nhận sót đối tượng hoặc mọi box đã được kiểm đủ.
- CLI: 0 = ĐẠT; 1 = vượt ngưỡng hoặc thiếu dữ liệu đã xác định; 3 = lỗi đọc/quét dữ liệu. Web lưu `gate_passed`, `gate_reasons`, `coverage_gaps` trong `summary.json`. Báo cáo cũ không được đánh giá lại tự động.

## 7. Điều kiện kiểm luật sau review 02

- `FrameData.points`: mảng số `(N, ≥3)`, chỉ x/y/z phải hữu hạn; mảng rỗng phải có shape `(0, ≥3)`. Pose nếu có là phép quay tay phải + tịnh tiến 4×4 hữu hạn, không chứa scale/shear; kiểm trực chuẩn và hàng cuối với dung sai 1e-6. Timestamp nếu có phải hữu hạn, tính bằng giây.
- Quaternion được chuẩn hóa sau khi chia cho thành phần có trị tuyệt đối lớn nhất, tránh tràn/thiếu số; thành phần NaN/Inf hoặc quaternion 0 bị từ chối.
- Ngưỡng số và khoảng min/max trong YAML phải hữu hạn; `track.keyframe_interval_s > 0`. Không đổi ngưỡng phát hiện mặc định trong phần 02.
- Điểm trên mặt/cạnh/góc cuboid được tính trong box; dung sai số học `points_in_cuboid` là **1e-9 m**, tách khỏi margin thực tế do caller chọn. Vùng lọc thô ground/box khác phải bao trọn footprint đã xoay.
- Size class/track, jump và heading theo track chỉ dùng box nhìn thấy **và keyframe nhập tay**. Long interpolation đo khoảng vắng giữa keyframe thật, kể cả caller cung cấp thêm box nội suy. Các luật vòng đời track vẫn dùng outside/occluded.
- Size chia baseline theo `(track_id, khóa tra khoảng kích thước)`, có thể là class/subtype. Nếu không có range cho subtype thì giữ fallback class đã quy định, không tự tạo ngưỡng mới.
- Hướng trục LiDAR dùng modulo 90°; unwrap các hướng quanh một mốc trước khi tính trung vị, tránh hiểu +44° và −44° là quanh 0°.
- Thiếu pose ở một ứng viên split: dùng cùng hệ local cho toàn bộ phép ghép, ghi `has_world_pose=False`. Gate vẫn áp dụng hợp đồng thiếu dữ liệu của phần 01.
- Thiếu timestamp trong một chuỗi: dùng thời gian tương đối theo `keyframe_interval_s` cho toàn chuỗi, không trộn timestamp epoch với frame×interval. Fallback này giả định lấy mẫu đều theo cấu hình.
- Khi quét `JobData`, scanner truyền `stop_frame`: track không có outside sau keyframe cuối vẫn tồn tại đến cuối job; occluded ở cuối track cũng kéo dài đến `stop_frame`. Danh sách Cuboid thuần không có biên job nên giữ cách suy ra từ các frame được cung cấp; caller cần JobData/biên job nếu muốn kiểm đúng phần đuôi CVAT.
- `track.split_id` đối chiếu class/subtype theo `size.key_attributes` được cấu hình, không ghép hai subtype khác nhau chỉ vì cùng label tổng.
- Finding được sắp ổn định thêm theo label/source_id; overlap dùng thứ tự box xác định khi chọn mục tiêu. Không sửa hình học hoặc thuộc tính của đầu vào khi kiểm luật.

Ma trận 18 mã luật, ca biên và bằng chứng: [review phần 02](../../review/2026-10-10/02-report.md).

## 8. Dữ liệu và writer sau review 03

- Manifest của bản xuất toàn scene kiểm số frame, tên file/sample_token, pose/time và transform trước scan. Auto tìm theo URL CVAT + task_id; bản cũ thiếu URL cần xác minh và chỉ manifest rõ hoặc cập nhật metadata.
- PCD chỉ hỗ trợ binary XYZ/intensity float32, COUNT=1; kiểm SIZE/TYPE/count/byte và finite. nuScenes bin cần 5 float32/điểm, không âm thầm bỏ byte cuối. Sweep thiếu dùng số có; sweep corrupt báo lỗi.
- Tên hệ export `ego` là hệ hiển thị quay cố định −90° giữ gốc LiDAR, chưa phải biến đổi calibration đầy đủ về gốc xe. Pose đi kèm bảo toàn world; core vẫn mô hình yaw.
- Thuộc tính mutable kế thừa theo frame tới lần đổi/reset rõ. Cờ reset bằng chuỗi rỗng ở keyframe kế tiếp khi cần; không xóa entry rồi để cờ trước đó kế thừa lại.
- Writer so nhãn fresh với lượt scan, GET lại trước PATCH; thay đổi yêu cầu quét lại. Còn race sau GET cuối nếu client khác sửa cùng lúc, chưa có bảo đảm atomic. Tránh sửa cùng job lúc ghi cờ.
- CVAT có thể cấp source ID keyframe mới. Chỉ rebind theo track/frame khi đúng keyframe đã scan và nhãn chưa đổi; ID lạ unmatched. Flag attribute phải mutable.
- Snapshot load từ API có thêm `meta.cvat_annotations` là payload gốc; không token, giữ ngoài Git. So geometry/state theo key ổn định và dung sai tuyệt đối, không dựa vào ID cấp lại.

Mapping/18 ca/16 findings và bằng chứng: [review phần 03](../../review/2026-10-10/03-report.md).

### Bổ sung coverage khi review lại ba nhánh

FrameSource có mặt nhưng point cloud rỗng ở frame có box nhìn thấy vẫn là thiếu dữ liệu cho các luật LiDAR đang bật. Gate chặn cả khi floating tắt; không dùng sự tồn tại của nguồn frame thay cho bằng chứng có điểm.
