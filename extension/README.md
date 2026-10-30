# PointSnap cho CVAT — extension annotator (0.5.0)

Bảng PointSnap trong trang job 3D của CVAT giúp annotator gán cuboid nhanh và đúng hơn. **Mọi phép tính chạy trong
trang CVAT; dữ liệu không rời CVAT, không cần chạy backend.** Extension ghi thay đổi vào bộ nhớ của CVAT như khi
người dùng kéo box: annotator xem trước, hoàn tác được (mục Hoàn tác bên dưới), và tự bấm **Save** của CVAT.

## Cài và mở

1. `chrome://extensions` (Edge: `edge://extensions`) → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
   Đã cài bản cũ thì bấm ↻ của extension, rồi tải lại tab CVAT (Save công việc trước).
2. **CVAT ở `http://localhost:8080`**: chạy sẵn. **CVAT ở địa chỉ khác** (của công ty, của người khác): mở trang CVAT đó,
   bấm biểu tượng PointSnap trên thanh trình duyệt → **Bật PointSnap cho trang này** → đồng ý quyền Chrome hỏi. Trang tự
   tải lại. Popup nhận ra trang có phải CVAT không (đọc `/api/server/about` của chính trang), báo phiên bản, và sau khi bật
   cho biết đã nhận dữ liệu CVAT chưa, đã mở job 3D chưa, Ctrl+Z của CVAT có hoàn tác được thao tác của PointSnap không.
3. **Spec của dự án** (nếu khác mặc định): mở một job của project, bấm **⚙** trên thanh tiêu đề bảng PointSnap (hoặc
   **Sửa** trên thẻ Spec). Xem mục *Spec của project* bên dưới. Trưởng nhóm **Export** file, annotator **Import** rồi
   **Save** ở job của cùng project. Trang **Tùy chọn** liệt kê bộ ngưỡng theo địa chỉ CVAT và theo project.

## Spec của project

Trình sửa mở ngay trong trang CVAT, không cần biết JSON:

- **Class** lấy từ label của job đang mở (tên, thuộc tính, giá trị), nên luôn khớp CVAT; class mới của project tự hiện.
- **Kích thước**: dài / rộng / cao dạng `min–max` (m). **Chia theo** một thuộc tính dạng chọn hoặc checkbox: mỗi giá trị một
  dòng (checkbox hiện **on / off**), ví dụ `rider_state` on cao 1,50–2,00, off cao 0,90–1,55. Ô để trống = không kiểm.
- Cột **Job**: khoảng thực tế của box đã gán trong job (đọc qua phiên đăng nhập CVAT của bạn), tô vàng khi lệch khoảng đang
  đặt; **Gợi ý từ job** điền khoảng đó vào các dòng có ≥ 3 box, xem lại rồi mới Save.
- Công tắc **Mặt đất**, **Chồng lấn** (mặc định bật cho mọi class, kể cả label đặt tên khác spec), **Vật cứng** (kiểm scale theo track, đồng bộ cỡ, mượt yaw); **Bắt buộc** cho thuộc
  tính dạng chọn (checkbox luôn có giá trị nên không cần); **Ghi chú** hiện trên thẻ Spec cho annotator.
- **Chồng lấn**: ngưỡng (mặc định 0%: cứ chồng là Lỗi, mọi class) và cặp class được chồng. **Luật spec**: người lái có box riêng, người nằm trong xe. **Ngưỡng**: mặt
  đất, phạm vi gán nhãn, độ cao LiDAR, lề kích thước.
- Ô sai dạng tô đỏ và khóa **Save**; dòng cuối cho biết box đang chọn có đạt với ngưỡng đang sửa không, trước khi Save.
- **Save** lưu cho project (chỉ phần khác mặc định, để mặc định được hiệu chỉnh sau này vẫn áp vào phần bạn không sửa);
  job không thuộc project nào thì lưu cho địa chỉ CVAT. **Export** ra file đầy đủ, **Import** đọc lại (chưa lưu tới khi Save).

Extension chỉ chạy trong trình duyệt của bạn và không gửi dữ liệu đi, nhưng có ghi vào nhãn: dùng trên CVAT của người
khác thì xin phép chủ hệ thống trước.

## Bảng trong job

- **Bảng nổi trên CVAT**: mở job 3D là bảng hiện ở góc phải trên, nổi trên trang (không chiếm chỗ thanh bên của CVAT),
  thao tác trên CVAT thế nào bảng cũng không mất. Kéo thanh tiêu đề để dời đi đâu cũng được, kéo góc dưới phải để đổi
  cỡ; nút **–** (hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) thu thành nút tròn mang màu trạng thái của box đang
  chọn, bấm nút tròn để mở lại (kéo nút tròn để dời). Vị trí, cỡ, thu nhỏ được nhớ. Mặt đất, tô điểm, khoá box trên
  canvas luôn chạy. Chạy như nhau trên Chrome, Edge, Opera. Popup của biểu tượng PointSnap trên thanh trình duyệt dùng để
  bật cho địa chỉ CVAT, xem tình trạng, đổi bộ ngưỡng. Bản nhúng thẳng vào CVAT (dịch vụ QC, không có extension) hiện
  bảng ở tab **Hỗ trợ** của thanh bên phải; tab **PointSnap** của bản nhúng dành cho QC và phiếu sửa lỗi.
- **Thanh tiêu đề**: chấm trạng thái (xanh ổn / cam cần xem / đỏ lỗi), box đang chọn,
  khoảng cách, số mục cần xem, tiến độ `xong/tổng`, ◎ khoá box, ⏮ / ⏭ track chưa xong trước / kế tiếp, ⚙ spec.
- **Checklist**, mỗi khía cạnh một dòng ✓ / ! / ✕ kèm một cụm từ ngắn (rê chuột xem đầy đủ) và **nút sửa nằm ngay trên
  dòng của vấn đề**: Mặt đất (**Hạ đáy** <kbd>G</kbd>), Kích thước (**Cỡ trung vị**), Ôm vật, Hướng (**Mượt yaw**),
  Chồng lấn, Thuộc tính. Báo nhầm thì bấm **✕** cuối dòng: dòng chuyển xám, không báo mục đó cho box / track này nữa;
  **↺** hiện lại.
- **Dải track**: một ô mỗi keyframe, ô vàng là keyframe lệch (rê chuột xem lý do), ô viền trắng là frame đang đứng;
  bấm ô để tới frame. **Sửa cả track** mở 4 thao tác.
- **Xem trước**: trước khi Áp dụng, box sau khi sửa ở frame này được vẽ **nét đứt xanh dương** chồng lên box hiện tại.
- Nền sáng như thanh bên của CVAT, có logo PointSnap; đường mặt đất trên canvas màu xanh dương để không lẫn với màu "ổn".

## Tính năng

| Tính năng | Cách dùng | Ghi vào CVAT? |
|---|---|---|
| Mặt đất tham chiếu + ΔZ | Chọn box: đường mặt đất (xanh dương, nét đứt) trên 4 view, vẽ theo độ cao đất thật dưới từng góc đáy (thấy dốc, thấy box nghiêng lệch đất); số ΔZ trên canvas; dòng Mặt đất trên panel | Không |
| Hạ đáy box | Nút **⤓ Hạ đáy** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>: đáy box đặt giữa mặt đất thấp nhất và cao nhất dưới 4 góc (dốc / bờ vỉa) | Có, 1 frame |
| Kiểm tra box đang chọn | Kích thước ngoài ngưỡng, scale không đồng bộ, lơ lửng / lún, Z ngoài ngưỡng, quá xa, chồng lấn, box rỗng, thiếu thuộc tính. Class chưa có khoảng kích thước trong spec (label đặt tên khác, vd `vehicles`): dòng Kích thước ghi "chưa có khoảng" (xám) kèm nút **Spec**, không hiện ✓ | Không |
| Điểm của vật (A4) | Đổi màu chính các điểm của point cloud trên cả 4 view: điểm trong box **xanh lá**, điểm của vật lòi ra ngoài box **đỏ** (chỉ điểm nối liền với vật, không lấy cây / tường bên cạnh). Nhãn khoảng hở từng mặt LiDAR nhìn thấy: "đuôi dư 24 cm", "trái lòi 8 cm" | Không |
| Chồng lấn | Box đang chồng: khung **đỏ** đậm, phần chồng tô đỏ ở view Top / 3D, nhãn "chồng 67%" (lấn dưới 1%: "chồng <1%"). Cứ chồng là **Lỗi**, mọi class. Cặp spec cho phép (người trên thùng xe, người lái…) hiện khung **xám** và mục Thông tin | Không |
| Thẻ spec (A8) | Nút **Spec** cạnh tên box: khoảng kích thước của class (đánh dấu ✓ / ✗ theo box), thuộc tính bắt buộc, class được chồng box, quy tắc spec | Không |
| Dải track | Một ô mỗi keyframe, vàng khi lệch kích thước / hướng; bấm ô để tới frame đó | Không |
| Đồng bộ kích thước cả track | Theo frame hiện tại hoặc theo trung vị; giữ mặt LiDAR nhìn thấy, giữ đáy box. Có xem trước | Có, cả track |
| Làm mượt yaw | Sửa keyframe lật 180°, lọc trung vị giữ đoạn rẽ thật. Có xem trước | Có, cả track |
| Tỉa keyframe | Bỏ keyframe mà CVAT nội suy lại được trong dung sai (tâm 5 cm, yaw 1°, kích thước 2 cm). Có xem trước | Có, cả track |
| Khoá box | Bật sẵn; nút ◎ hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> để tắt / bật. Đổi frame (phím CVAT hay ô dải track) vẫn chọn đúng box, camera đi theo box nên box đứng yên trên màn hình, giữ góc nhìn và zoom. Tắt khoá thì bấm ô dải track đưa camera tới box | Không |
| Bỏ qua cảnh báo | **✕** trên dòng báo nhầm: bỏ qua mục đó cho box (track: mọi frame); **↺** hiện lại. Lưu theo job trong trình duyệt | Không |
| Track đã xong | **Đánh dấu xong** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>; **Track chưa xong ›** chọn track kế tiếp. Chỉ lưu ID track trong trình duyệt | Không |

Thứ tự nên dùng cho một track pre-label: làm chuẩn một frame nhìn rõ → **Đồng bộ kích thước** → **Làm mượt yaw** →
**Tỉa keyframe** → soát các keyframe còn lại → Save.

Ngưỡng mặc định ở `src/annotator/guideline.js`, tool QC (`qc/`) dùng chung (khoảng kích thước người / xe máy
đã nới theo dữ liệu thật, xem tài liệu mục 6.3). Dự án khác ngưỡng: file bộ ngưỡng ở **Tùy chọn**, chỉ cần ghi phần khác,
ví dụ `{"maxDistanceM": 80}`. Kiểm tra **Quá xa** tắt cho tới khi đặt `maxDistanceM`. Dữ liệu ở hệ mặt đất (như KITTI,
LiDAR cao 1,73 m) hoặc hệ xe thu thì đặt `sensorOrigin` là vị trí LiDAR, riêng cho địa chỉ CVAT đó.

## Hoàn tác

- CVAT có `job.annotations.saveStates` (bản mới): mỗi thao tác của PointSnap là **một** bước Ctrl+Z của CVAT.
- CVAT chưa có hàm đó (đã đo trên **2.75.1**): lịch sử Undo của CVAT chỉ giữ 32 bước, nên ghi 38 keyframe từng bước sẽ
  vừa không Undo hết vừa đẩy mất lịch sử của annotator. PointSnap tạm dừng ghi lịch sử CVAT trong lúc lưu và hiện nút
  **↶ Hoàn tác** cho thao tác vừa làm. Ctrl+Z của CVAT không hoàn tác thao tác này. Keyframe đã bị sửa tiếp thì nút
  Hoàn tác giữ nguyên, không ghi đè. Nút chỉ hiện khi đang chọn đúng track vừa sửa; chọn track khác thì ẩn, quay lại thì
  hiện lại.

## Đã kiểm trên CVAT thật (2.75.1, task nuScenes scene-0061, 39 frame, 219 track)

| Hạng mục | Kết quả |
|---|---|
| Ghi box / đồng bộ 38 keyframe / tỉa / hạ đáy | Canvas 4 view vẽ lại ngay; lịch sử CVAT không bị ghi đè; nút Hoàn tác phục hồi đúng |
| Đường mặt đất, khung footprint | Nằm đúng trên box và point cloud ở cả 4 view |
| Dựng bản đồ địa hình | 5–16 ms mỗi frame (~35k điểm) |
| Báo nhầm trên 840 box nhãn chuẩn (10 frame) | 14 Cảnh báo / Lỗi (1,7 / 100 box), chủ yếu lơ lửng ở người đi bộ xa 20–45 m; Z ngoài ngưỡng 0. Chồng lấn đo lại từ 26/10 khi đổi thành "cứ chồng là Lỗi": xem PP-06 |
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
  panel.js          giao diện bảng: checklist, dải track, xem trước (shadow DOM); bảng nổi (extension) và tab Hỗ trợ (plugin QC)
  spec-editor.js    trình sửa spec của project (shadow DOM)
  annotator.js      bộ điều khiển
  settings-bridge.js  chuyển cấu hình của địa chỉ CVAT đang mở sang trang (ISOLATED world)
src/cvat-dom.js     chuyển frame bằng ô chọn frame của CVAT (dải track)
background.js       service worker: đăng ký content script cho các CVAT khác đã bật
hosts.js            các CVAT đã bật + cấu hình theo từng địa chỉ (popup, Tùy chọn, service worker, bridge dùng chung)
popup.js            nhận ra CVAT, bật một nút, báo tình trạng
options.js          danh sách CVAT, nhập / xuất bộ ngưỡng
tests/*.test.js     node --test tests/*.test.js
bench/              đo luật và tư thế xe theo khoảng cách trên dữ liệu công khai (Node, không nạp vào extension;
                    xem tài liệu mục 6.4)
```

Bảng kết quả quét của backend Python cũ (`pointsnap/`) đã gỡ cùng backend (28/10/2026). Luồng QC nay là tool `qc/`.
