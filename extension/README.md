# PointSnap cho CVAT — extension annotator (0.4.0)

Bảng PointSnap trong trang job 3D của CVAT giúp annotator gán cuboid nhanh và đúng hơn. **Mọi phép tính chạy trong
trang CVAT; dữ liệu không rời CVAT, không cần chạy backend.** Extension ghi thay đổi vào bộ nhớ của CVAT như khi
người dùng kéo box: annotator xem trước, hoàn tác được (mục Hoàn tác bên dưới), và tự bấm **Save** của CVAT.

## Cài và mở

1. `chrome://extensions` (Edge: `edge://extensions`) → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
   Đã cài bản cũ thì bấm ↻ của extension, rồi tải lại tab CVAT (Save công việc trước).
2. Mở một job 3D trên CVAT (`http://localhost:8080`; địa chỉ khác thì thêm ở **Tùy chọn**). Bảng **PointSnap** (rộng
   264 px) hiện ở bên phải, kéo thanh tiêu đề để dời. Thanh tiêu đề đã đủ để làm việc: chip ΔZ, số lỗi / cảnh báo, tiến
   độ `xong/tổng`, ◎ bám camera, ⏭ track chưa xong, ▴ thu gọn chỉ còn thanh này. Mục Track (biểu đồ, nút sửa cả track)
   và Spec mặc định đóng, bấm để mở; lỗi hiện mỗi lỗi một dòng (rê chuột xem đủ), mục Thông tin gộp một dòng.

## Tính năng

| Tính năng | Cách dùng | Ghi vào CVAT? |
|---|---|---|
| Mặt đất tham chiếu + ΔZ | Chọn box: đường mặt đất (xanh, nét đứt) trên 4 view, số ΔZ trên panel. Xanh ≤ 5 cm, cam lơ lửng, đỏ lún | Không |
| Hạ đáy box | Nút **⤓ Hạ đáy** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>: đáy box đặt giữa mặt đất thấp nhất và cao nhất dưới 4 góc (dốc / bờ vỉa) | Có, 1 frame |
| Kiểm tra box đang chọn | Kích thước ngoài ngưỡng, scale không đồng bộ, lơ lửng / lún, Z ngoài ngưỡng, quá xa, chồng lấn, box rỗng, thiếu thuộc tính | Không |
| Điểm của vật (A4) | Đổi màu chính các điểm của point cloud trên cả 4 view: điểm trong box **xanh lá**, điểm của vật lòi ra ngoài box **đỏ** (chỉ điểm nối liền với vật, không lấy cây / tường bên cạnh). Nhãn khoảng hở từng mặt LiDAR nhìn thấy: "đuôi dư 24 cm", "trái lòi 8 cm" | Không |
| Chồng lấn | Box đang chồng: khung **đỏ** đậm, phần chồng tô đỏ ở view Top / 3D, nhãn "chồng 67%". Cặp spec cho phép (người trên thùng xe, người lái…) hiện khung **xám** và mục Thông tin | Không |
| Thẻ spec (A8) | Nút **Spec** cạnh tên box: khoảng kích thước của class (đánh dấu ✓ / ✗ theo box), thuộc tính bắt buộc, class được chồng box, quy tắc spec | Không |
| Dải tổng quan track | Dài / Rộng / Cao / Yaw theo keyframe; chấm đỏ là keyframe lệch, bấm để tới frame đó | Không |
| Đồng bộ kích thước cả track | Theo frame hiện tại hoặc theo trung vị; giữ mặt LiDAR nhìn thấy, giữ đáy box. Có xem trước | Có, cả track |
| Làm mượt yaw | Sửa keyframe lật 180°, lọc trung vị giữ đoạn rẽ thật. Có xem trước | Có, cả track |
| Tỉa keyframe | Bỏ keyframe mà CVAT nội suy lại được trong dung sai (tâm 5 cm, yaw 1°, kích thước 2 cm). Có xem trước | Có, cả track |
| Camera theo track | **Camera theo track** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>: đổi frame vẫn chọn và focus đúng track | Không |
| Track đã xong | **Đánh dấu xong** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>; **Track chưa xong ›** chọn track kế tiếp. Chỉ lưu ID track trong trình duyệt | Không |

Thứ tự nên dùng cho một track pre-label: làm chuẩn một frame nhìn rõ → **Đồng bộ kích thước** → **Làm mượt yaw** →
**Tỉa keyframe** → soát các keyframe còn lại → Save.

Ngưỡng mặc định theo `pointsnap/config.yaml` và `pointsnap/guidelines/spec-vn.yaml`. Dự án khác ngưỡng: **Tùy chọn →
Guideline ghi đè (JSON)**, chỉ ghi phần khác, ví dụ `{"maxDistanceM": 80}`. Kiểm tra **Quá xa** tắt cho tới khi đặt
`maxDistanceM`. Dữ liệu xuất ở hệ xe thu thì đặt `sensorOrigin` là vị trí LiDAR.

## Hoàn tác

- CVAT có `job.annotations.saveStates` (bản mới): mỗi thao tác của PointSnap là **một** bước Ctrl+Z của CVAT.
- CVAT chưa có hàm đó (đã đo trên **2.75.1**): lịch sử Undo của CVAT chỉ giữ 32 bước, nên ghi 38 keyframe từng bước sẽ
  vừa không Undo hết vừa đẩy mất lịch sử của annotator. PointSnap tạm dừng ghi lịch sử CVAT trong lúc lưu và hiện nút
  **↶ Hoàn tác** cho thao tác vừa làm. Ctrl+Z của CVAT không hoàn tác thao tác này. Keyframe đã bị sửa tiếp thì nút
  Hoàn tác giữ nguyên, không ghi đè.

## Đã kiểm trên CVAT thật (2.75.1, task nuScenes scene-0061, 39 frame, 219 track)

| Hạng mục | Kết quả |
|---|---|
| Ghi box / đồng bộ 38 keyframe / tỉa / hạ đáy | Canvas 4 view vẽ lại ngay; lịch sử CVAT không bị ghi đè; nút Hoàn tác phục hồi đúng |
| Đường mặt đất, khung footprint | Nằm đúng trên box và point cloud ở cả 4 view |
| Dựng bản đồ địa hình | 5–16 ms mỗi frame (~35k điểm) |
| Báo nhầm trên 840 box nhãn chuẩn (10 frame) | 14 Cảnh báo / Lỗi (1,7 / 100 box), chủ yếu lơ lửng ở người đi bộ xa 20–45 m; Z ngoài ngưỡng 0, chồng lấn 0 |
| Đo được mặt đất (độ tin cậy ≥ 0,3) | ~54% box trong 30 m; LiDAR 32 tia thưa nên box xa thường chỉ báo "không đủ điểm mặt đất" |
| Dải track trên 1395 keyframe chuẩn | Kích thước: 0 keyframe bị đánh dấu nhầm; ngưỡng yaw chỉnh theo dữ liệu (xe 15°, người 45°) |
| Làm mượt yaw trên nhãn chuẩn | Xe / rào chắn: đổi 1 keyframe (2°); người đi bộ bị đổi nhiều nên đã tắt cho người / động vật |
| Tỉa keyframe trên nhãn nuScenes | Không bỏ được keyframe nào: nhãn ở hệ LiDAR của từng frame, xe thu đang chạy nên vị trí không tuyến tính; hiệu quả thật phụ thuộc pre-label của dự án |

**Dữ liệu thứ hai: Argoverse 2** (log val `02678d04`, LiDAR 64 tia, 10 Hz, 40 frame, 48 track, task 51 trên CVAT local):
trong 50 m sai số mặt đất so với bản đồ thật p90 ≤ 10 cm, đo được mặt đất 88% box trong 30 m, 2 cảnh báo / 83 box
(đều là xe 0 điểm LiDAR); tỉa keyframe bỏ 32% keyframe chuẩn với sai lệch ≤ 5 cm; trên pre-label giả, dải track bắt
97% keyframe sai cỡ và 26/26 keyframe lật. Từ dữ liệu này: luật lơ lửng / lún chỉ áp trong 50 m. Chi tiết:
[docs/pain-points-va-giai-phap.md mục 6.2](../docs/pain-points-va-giai-phap.md).

**Dùng thật trên dữ liệu bốc ngẫu nhiên** (25/10/2026; nuScenes scene-1077, scene-1100 và 13 hộp pre-label thật của
PointPillars trên KITTI 000008): báo nhầm trên nhãn chuẩn 0,7–1,6 box / 100 sau khi nới khoảng kích thước người / xe máy
(trước đó 18 / 100 ở scene-1100); đồng bộ kích thước + tỉa 40 → 14 keyframe, **Ctrl+S rồi tải lại trang** khớp 40/40
frame; phím <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> / <kbd>G</kbd> và phím chuyển frame của CVAT bấm thật đều chạy.
Chi tiết: [mục 6.3](../docs/pain-points-va-giai-phap.md).

Box bị khóa (🔒) trong CVAT: panel ghi "đang khóa", các nút sửa và phím tắt sửa không chạy.

Chưa kiểm: độ mượt khi kéo chuột ở frame đông điểm (khung trình duyệt thử quá hẹp).

Toàn bộ phần chạm nội bộ CVAT nằm trong [`src/annotator/cvat-adapter.js`](src/annotator/cvat-adapter.js).

```
src/annotator/
  box.js            hình học cuboid, chồng lấn (thuần, có test)
  spatial-grid.js   chỉ mục điểm theo ô nhìn từ trên
  terrain.js        bản đồ địa hình của frame, đo tiếp đất (thuần, có test)
  guideline.js      ngưỡng mặc định + ghi đè từ Tùy chọn (thuần, có test)
  checks.js         luật kiểm tra một box (thuần, có test)
  track-ops.js      kế hoạch sửa cả track (thuần, có test)
  object-points.js  điểm của vật quanh box, khoảng hở từng mặt (thuần, có test)
  cvat-adapter.js   cầu nối duy nhất tới nội bộ CVAT
  overlay.js        vẽ SVG trên 4 view
  cloud-colors.js   tô màu chính các điểm của point cloud CVAT (A4), trả màu gốc khi bỏ chọn
  panel.js          giao diện bảng (shadow DOM)
  annotator.js      bộ điều khiển
  settings-bridge.js  chuyển Tùy chọn sang trang (ISOLATED world)
tests/*.test.js     node --test tests/*.test.js
```

# Bảng kết quả quét (luồng QC cũ, cần PointSnap backend)

Tắt mặc định từ 0.4.0; bật ở **Tùy chọn → Hiện bảng kết quả quét của PointSnap backend**. Phần sửa tay v2 (thước,
khung tham chiếu theo lần quét) đã được thay bằng bảng annotator ở trên.

> Đối chiếu 12/10/2026: logic có 36 Node tests trên nhánh review, gồm identity/scope và từ chối ambiguity. Chưa nghiệm thu lại Load unpacked/service worker/DOM trong Chrome hoặc Edge thật. CVAT API 2.78.1 đã kiểm riêng; không suy ra toàn luồng MV3 đã đạt. Xem [phần 05](../../../review/2026-10-10/05-report.md) và [bàn giao tổng](../../../review/2026-10-10/08-handoff.md).

Extension Chrome / Edge (Manifest V3) giúp annotator **ở yên trong CVAT** khi sửa các box mà PointSnap đã gắn cờ `pointsnap_error`: tự lọc box lỗi, chuyển frame có lỗi bằng một phím mà không tải lại trang, hiện thông báo lỗi kèm gợi ý sửa.

> Nguyên tắc: extension **không sửa mã nguồn CVAT, không sửa box**. Nó chỉ đọc những gì CVAT hiển thị, đọc nhãn qua REST API chính thức của CVAT (chỉ `GET`, bằng phiên đăng nhập sẵn có của trình duyệt), và bấm hộ các nút có sẵn như người dùng tự bấm.

## Cài đặt (một lần, khoảng 1 phút)

1. Mở `chrome://extensions` (Edge: `edge://extensions`).
2. Bật **Developer mode** (Chế độ nhà phát triển).
3. Bấm **Load unpacked** → chọn thư mục `source-tool/pointsnap-3d/extension`.
4. Ghim biểu tượng PointSnap lên thanh công cụ. Bấm biểu tượng: thấy PointSnap đang chạy hay chưa, mở nhanh web
   PointSnap / CVAT, phím tắt và nút **Tùy chọn**.

Mặc định extension chạy trên CVAT ở `http://localhost:8080` và gọi PointSnap ở `http://127.0.0.1:8765`. CVAT ở địa chỉ khác: thêm ở trang **Tùy chọn**, bấm **Lưu** và đồng ý cấp quyền.

Cập nhật bản mới: `git pull`, rồi bấm nút tải lại (↻) của extension ở `chrome://extensions`, rồi tải lại trang CVAT.

## Dùng

1. Quét job bằng PointSnap và **Gắn cờ lên CVAT** (giao diện web `pointsnap ui` hoặc `pointsnap scan --job <id> --flag`).
2. Mở job 3D trên CVAT. Bảng **PointSnap** hiện ở góc trái (kéo thanh tiêu đề để dời chỗ, bấm `–` để thu gọn) và tự bật bộ lọc của CVAT để **chỉ hiện box có cờ**.
3. Tab **Lỗi hiện tại**: bấm **›** / **‹** (hoặc phím `.` / `,`, cũng nhận `]` / `[`) để tới frame có lỗi kế tiếp; box lỗi được yêu cầu làm sáng khi có ánh xạ duy nhất. Bấm nhiều lần liền thì extension đi lần lượt sau khi CVAT tải xong từng frame.
4. Thẻ lỗi cho biết mức lỗi, loại lỗi, box, mô tả và **Cách sửa**. Frame có nhiều box lỗi thì bấm `1 / 2 ›` trên thẻ để chuyển box kế tiếp; khi sidebar không phân biệt được box trùng nhãn/cờ, dùng link `serverID` trong báo cáo. Rê chuột vào box trên CVAT thì thẻ đổi theo box đó.
5. Ghi kết luận bằng **Đúng là lỗi** / **Báo nhầm** (cần PointSnap chạy).
6. Tab **Danh sách**: mọi lỗi của job, lọc Lỗi / Cảnh báo, bấm dòng để nhảy tới frame; phía dưới là **Quét lại** / **Quét + gắn cờ**. Sửa box xong thì **Save** (Ctrl+S) như bình thường.
7. Xong cả job: bấm **Quét + gắn cờ** ở tab Danh sách để kiểm lại, rồi tải lại trang để thấy cờ mới.

### Liên kết với giao diện web PointSnap

Mở cùng lúc web PointSnap (`127.0.0.1:8765`) và tab CVAT đang mở job:

- Ở màn Kết quả của web, nút **Mở trong CVAT** đổi thành **Chuyển CVAT tới box này** khi có tab CVAT (cài extension) đang mở job đó. Bấm nút: tab CVAT nhảy tới frame và yêu cầu làm sáng box theo identity hợp lệ, rồi được đưa lên trước, **không tải lại trang**. Chưa mở tab CVAT nào thì nút mở link như cũ.
- Chọn mục trên web (bấm dòng, phím J / K) thì tab CVAT tự chuyển theo.
- **Đúng là lỗi / Báo nhầm** ghi ở web hay ở extension đều hiện ở bên kia sau khoảng 2 giây.
- **Áp dụng / Hoàn tác sửa box** ở bên nào cũng hiện ở bên kia trong vài giây (`history_rev`), kèm nút Hoàn tác;
  extension nhắc tải lại trang CVAT để nạp box mới. Đề xuất sửa trong extension lấy từ đúng mục của lần quét nên
  trùng với đề xuất trên web.
- Nút ↗ trên đầu bảng mở kết quả job trên web PointSnap.

Cách hoạt động: web gửi lệnh lên PointSnap (`POST /api/extension/focus`); extension hỏi PointSnap mỗi giây (`GET /api/extension/poll`), lần hỏi đó cũng cho web biết tab CVAT đang mở job nào (`GET /api/extension/status`). Cả hai trả `reviews_rev` (kết luận) và `history_rev` + `history_event` (lần sửa / hoàn tác box mới nhất của job) để mỗi bên tự cập nhật. Không có kết nối trực tiếp giữa hai tab, dùng host permission được người dùng cấp cho CVAT và PointSnap.

| Chức năng | Cần PointSnap chạy? |
|---|---|
| E1 Bảng PointSnap trên trang job | Không |
| E2 Tự bật bộ lọc "chỉ box có cờ" | Không |
| E3 Thông báo lỗi + gợi ý sửa của box đang chọn | Không |
| E4 Lỗi tiếp / trước (nút, phím `,` `.` hoặc `[` `]`), không tải lại trang | Không |
| E5 Danh sách mọi lỗi của job, bấm dòng để nhảy tới frame | Không (lấy từ cờ trên CVAT) |
| E6 Quét lại, Quét + gắn cờ, ghi **Đúng là lỗi / Báo nhầm** | Có |

Phím `,` `.` và `[` `]` được chọn theo bản CVAT trong tài liệu gốc; kiểm lại nếu bản CVAT khác có shortcut trùng; `J` (Join) và `K` (Switch keyframe) đã là phím của CVAT nên extension không dùng. Gõ tiếng Việt kiểu Telex có thể biến `[` `]` thành `ư` `ơ`, nên dùng `,` `.`.

## Khi có trục trặc

| Hiện tượng | Cách xử lý |
|---|---|
| "CVAT chưa nạp bộ lọc PointSnap" | Lần đầu mở một task: bấm **Tải lại trang** trong bảng (chỉ cần một lần). |
| Bộ lọc không tự bật | Làm tay: **Filters → Add rule → Attributes → nhãn → `pointsnap_error` → is not empty → Submit**. Các nút khác vẫn dùng được. |
| "Job này chưa có thuộc tính pointsnap_error" | Chưa gắn cờ lần nào: quét và gắn cờ bằng PointSnap trước. |
| Chân bảng ghi "PointSnap tắt" | Chạy `pointsnap ui`, rồi bấm **Kiểm tra lại**. E1–E5 vẫn chạy khi PointSnap tắt. |
| Gắn cờ xong mà không thấy cờ mới | CVAT chỉ đọc nhãn khi mở job: **Save** rồi tải lại trang. |
| Bảng không hiện | Kiểm tra extension đang bật ở `chrome://extensions` và địa chỉ CVAT có trong trang Tùy chọn. |

## Cấu trúc

```
extension/
  manifest.json      quyền: storage, scripting; host: PointSnap 127.0.0.1:8765 (CVAT khác: xin quyền khi thêm)
  background.js      service worker: gọi API PointSnap thay content script; đăng ký content script cho CVAT khác
  popup.html/.js     bấm biểu tượng: trạng thái PointSnap, mở web / CVAT, phím tắt
  options.html/.js   địa chỉ PointSnap, CVAT khác, tự bật bộ lọc, tự làm sáng box (tự kiểm tra kết nối)
  ui.css             kiểu dáng chung của popup và trang Tùy chọn
  src/core.js        logic thuần (đọc cờ, gợi ý sửa, frame kế tiếp, bộ lọc) — có test Node
  src/cvat-dom.js    đọc giao diện CVAT và bấm hộ nút (tên lớp ổn định của CVAT)
  src/cvat-api.js    GET nhãn của job qua REST API của CVAT; chuẩn bị bộ lọc trong "Recently used"
  src/seed.js        chạy khi trang bắt đầu tải, chuẩn bị bộ lọc trước khi CVAT dựng trang job
  src/content.js     bảng PointSnap (Shadow DOM, không lẫn CSS với CVAT)
  src/panel-css.js   kiểu dáng bảng, sáng / tối theo hệ thống
  tests/core.test.js node --test tests/*.test.js
```

Bộ lọc được chuẩn bị bằng cách thêm một mục vào **lịch sử bộ lọc** của CVAT (`annotationFiltersHistory` trong localStorage của trang CVAT), giống như khi người dùng đã tự tạo bộ lọc đó một lần; sau đó extension bấm hộ **Filters → Recently used → mục PointSnap → Submit**.

API PointSnap dùng: `GET /api/extension/jobs/{job_id}?cvat_url=…` (dự án và lần quét mới nhất của job), `GET /api/extension/poll`, `POST /api/projects/{slug}/scans`, `GET /api/projects/{slug}/scans/{run_id}`, `GET` / `PUT /api/projects/{slug}/scans/{run_id}/reviews[/{index}]`, `GET /api/projects/{slug}/scans/{run_id}/findings/{index}/repair` (đề xuất sửa theo mục; dự phòng `GET /api/jobs/{job}/tracks/{track}/repair`), `POST /api/jobs/{job}/tracks/{track}/apply-repair` và `/rollback` (đã ngừng ở v2: HTTP 410).

Test:

```bash
node --test tests/*.test.js
```

## Identity, quyền và dữ liệu

Đặt `POINTSNAP_EXTENSION_IDS` trước khi chạy backend để chỉ cho các ID extension được liệt kê (phân cách bằng dấu phẩy) gọi API ghi. Không đặt hoặc để trống biến này thì giữ hành vi cũ; extension ngoài danh sách vẫn được đọc.

Focus/review được khóa theo origin CVAT, project/run và job. Sidebar DOM không luôn cung cấp serverID; nhiều box cùng nhãn/cờ thì extension từ chối đoán box. Quét lại sau Save/gắn cờ vì CVAT có thể cấp ID mới. Extension nhận origin HTTP(S), không hỗ trợ URL có đường dẫn proxy; không chứa user/password/query/fragment. Cấp host permission ở Tùy chọn và reload extension/trang sau cập nhật. Đổi server/đường dẫn trên Web xóa PAT cũ; nhập PAT của đúng server. Không lưu PAT vào extension. Các request scan/flag vẫn có tác động backend; dùng job thử và phối hợp Save theo [bảo mật local](../docs/local-security.md).
