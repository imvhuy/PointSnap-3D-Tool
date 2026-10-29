# PointSnap 3D — Pain point khi gán nhãn cuboid 3D và cách giải quyết

> Tài liệu báo cáo mentor · cập nhật 25/10/2026 · trạng thái: **extension annotator 0.4.0 đã triển khai và chạy thử
> trên CVAT 2.75.1 local; phần QC chưa làm**
>
> Phạm vi: gán nhãn 3D cuboid trên point cloud LiDAR trong CVAT cho dự án ADAS, gồm khâu annotator và khâu QC.
> Số liệu thời gian / tỉ lệ reject lấy từ tài liệu nội bộ cũ (quan sát trên nuScenes), **chưa đo lại trên dự án thật**.
> Ngưỡng của extension đã chỉnh theo nhãn chuẩn nuScenes scene-0061 trên CVAT thật (mục 6.1).

---

## 1. Bối cảnh và ràng buộc

| Ràng buộc | Hệ quả thiết kế |
|---|---|
| **Dữ liệu không được rời CVAT** | Mọi tính toán cho annotator chạy trong trình duyệt (extension đọc point cloud CVAT đã tải). Scan chuyên sâu cho QC chỉ chạy trên server nằm cùng hạ tầng CVAT, đọc qua API CVAT, không lưu bản sao. Issue của QC lưu trong CVAT |
| **Annotator chỉ dùng extension** | Không bắt annotator mở web hay cài Python |
| **"Tool đề xuất, con người quyết định"** | Tool không tự Save. Mọi thao tác sửa có xem trước, Undo được, người dùng bấm Save của CVAT |
| **Demo hiện chạy localhost** (CVAT + nuScenes) | Demo phải dùng đúng kiến trúc áp dụng được cho dữ liệu thật, không dựa vào việc backend đọc nuScenes trên máy |

**Ưu tiên:** annotator trước (khoảng 70% công sức), QC một lớp mỏng (30%). Giờ công nằm chủ yếu ở annotator. Pre-label khiến annotator thực chất đang review từng track, nên công cụ làm cho annotator QC dùng lại được.

**Chia lỗi theo loại, không theo người:**
- **Lỗi máy đo được** (kích thước, thuộc tính, box rỗng, chồng box, lơ lửng): bắt ngay ở annotator.
- **Lỗi cần phán đoán** (sai class khi mơ hồ, sót vật bị che, sai ID): giữ ở QC.

---

## 2. Tổng quan

| Mã | Pain point | Người gặp | Giải pháp chính | Cần ghi box? | Hiện trạng |
|---|---|---|---|---|---|
| PP-01 | Pre-label đặt keyframe ở mọi frame, phải sửa từng frame | Annotator | Đồng bộ kích thước track, tỉa keyframe, áp delta cho dải frame | Có | **Đã làm** đồng bộ kích thước, làm mượt yaw, tỉa keyframe; chưa làm áp delta, gợi ý frame tham chiếu |
| PP-02 | Căn đáy box sát mặt đất bằng mắt | Annotator | Bản đồ địa hình + HUD ΔZ + hạ đáy box một chạm | Có (hạ đáy) | **Đã làm** trong extension; backend vẫn dùng thuật toán cũ |
| PP-03 | Mất dấu box khi chuyển frame | Annotator | Khoá box (camera đi theo box) | Không | **Đã làm** |
| PP-04 | Không biết frame nào trong track bị sai | Annotator | Dải tổng quan track, đánh dấu ngoại lai | Không | **Đã làm** (kích thước, yaw) |
| PP-05 | Không thấy box ôm hết vật chưa | Annotator | Tô điểm trong/ngoài box, khoảng hở từng mặt | Không | **Đã làm** |
| PP-06 | Box chồng nhau, trùng track do pre-label | Annotator, QC | Cảnh báo chồng box khi kéo, phát hiện track trùng | Không | **Đã làm** báo Lỗi mọi chồng lấn trong frame, mọi class (cặp spec cho phép ở mức Thông tin); chưa làm track trùng |
| PP-07 | Kích thước sai class, scale không đồng bộ | Annotator | Kiểm tra kích thước theo class/subtype và theo track | Không | **Đã làm** |
| PP-08 | Hướng box lật hoặc đổi đột ngột | Annotator | Phát hiện lật hướng + làm mượt yaw | Có (làm mượt) | **Đã làm** (vật cứng) |
| PP-09 | Box Z vô lý ở nơi thiếu điểm mặt đất | Annotator, QC | Kiểm tra "Z ngoài ngưỡng" so với mặt đất chung | Không | **Đã làm** |
| PP-10 | Box nằm ngoài phạm vi gán nhãn | Annotator | Kiểm tra "Quá xa" | Không | **Đã làm**, chờ chốt khoảng cách theo spec |
| PP-11 | Không biết track nào đã làm xong | Annotator | Đánh dấu track đã xong, tiến độ job | Không | **Đã làm** |
| PP-12 | Spec dài, thuộc tính đổi theo thời gian | Annotator | Thẻ spec theo class, kiểm tra thuộc tính | Không | **Đã làm** thẻ spec và kiểm tra thiếu thuộc tính; chưa làm đổi thuộc tính theo dải frame |
| PP-13 | Kéo chuột không chính xác, box mới cỡ mặc định | Annotator | Ô nhập số, mẫu kích thước theo class | Có | Chưa có |
| PP-14 | Sót vật do pre-label bỏ sót | QC | Phát hiện cụm điểm di chuyển chưa có box | Không | Có, độ phủ còn thấp |
| PP-15 | QC không biết đã xem track/frame nào | QC | Bảng độ phủ theo track | Không | Chưa có |
| PP-16 | Ghi issue tốn thời gian, không thống nhất | QC | Mẫu issue một chạm, lưu trong CVAT | Không | Chưa có |
| PP-17 | Re-review phải xem lại cả job | QC | So sánh lần nộp trước và lần nộp lại | Không | Chưa có |
| PP-18 | Báo nhầm làm mất niềm tin; kết luận mất sau quét lại | QC | Khóa ổn định cho kết luận, đo precision từng luật | Không | Kết luận đang mất sau quét lại |

---

## 3. Chi tiết pain point của annotator

### PP-01. Pre-label đặt keyframe ở mọi frame

**Vấn đề.** Pre-label gán keyframe cho từng frame. Một xe lệch kích thước 20 cm thì annotator phải kéo lại ở 50–100 frame, và không nhờ được nội suy của CVAT.

**Giải pháp:**
1. **Gợi ý frame tham chiếu** *(chưa làm)*: chấm điểm từng keyframe theo số điểm trong box, số mặt nhìn thấy và khoảng cách tới LiDAR. Annotator làm chuẩn frame tốt nhất trước.
2. **Đồng bộ kích thước cả track** *(đã làm)*, chỉ cho vật cứng. Nguồn kích thước là frame hiện tại hoặc trung vị các keyframe.
   - **Giữ cố định các mặt LiDAR nhìn thấy**, chỉ kéo dài về phía bị che: c' = c + R·(±Δd/2), dấu hướng ra xa cảm biến. Nếu cảm biến nằm trong dải của trục đó (nhìn ngang) thì giữ tâm.
   - Giữ đáy box: z' = đáy + h'/2.
3. **Làm mượt yaw** *(đã làm)*, xem PP-08.
4. **Tỉa keyframe thừa** *(đã làm)* bằng Douglas–Peucker theo thời gian.
   - Giữ keyframe đầu và cuối.
   - Nội suy giữa các keyframe được giữ **đúng công thức của CVAT** (đối chiếu `cuboid-track.ts`): tâm và kích thước tuyến tính, góc theo cung ngắn nhất.
   - Keyframe nào sai số vượt ngưỡng (tâm 5 cm, yaw 1°, kích thước 2 cm) thì giữ lại và chia đôi đoạn.
   - Luôn giữ keyframe `outside` và keyframe kề chỗ đổi thuộc tính, `outside`, `occluded`.

   So với chính cách CVAT nội suy trong cùng hệ tọa độ, nên đúng cả khi không có pose.
5. **Áp delta cho dải frame** *(chưa làm)*: sửa một frame, áp cùng phần dịch/xoay/kích thước cho frame A→B.

**Thứ tự nên dùng:** đồng bộ kích thước → làm mượt yaw → tỉa keyframe. Còn nhiễu thì không tỉa được bao nhiêu.

**An toàn khi ghi.** Mọi thao tác có bản xem trước. Lúc bấm Áp dụng, extension lập lại kế hoạch trên dữ liệu mới nhất; nếu track vừa bị sửa giữa chừng thì cập nhật bản xem trước và không ghi.

**Hoàn tác (đo trên CVAT 2.75.1).**
- Bản CVAT mới có `job.annotations.saveStates`: cả thao tác là một bước Ctrl+Z.
- CVAT 2.75.1 không có hàm này, và lịch sử Undo chỉ giữ 32 bước. Lưu từng keyframe thì một thao tác 38 keyframe vừa không Undo hết được, vừa đẩy mất lịch sử của annotator.
- Vì vậy trên CVAT cũ, extension tạm dừng ghi lịch sử CVAT (`job.actions.freeze`) trong lúc lưu, và có nút **Hoàn tác** riêng. Keyframe nào đã bị sửa tiếp sau đó thì giữ nguyên, không ghi đè. Nút chỉ hiện khi đang chọn đúng track vừa sửa: bản đầu vẫn hiện khi đã chọn track khác, dễ tưởng là hoàn tác track đang chọn.

**Kết quả trên CVAT thật.** Đồng bộ 38 keyframe: canvas vẽ lại ngay, nút Hoàn tác phục hồi đủ 38 keyframe. Trên nhãn nuScenes, tỉa keyframe không bỏ được keyframe nào: nhãn nằm ở hệ LiDAR của từng frame, xe thu đang chạy nên vị trí không tuyến tính. Hiệu quả thật phụ thuộc pre-label của dự án.

**Kỳ vọng.** Annotator chỉ còn soát số ít keyframe còn lại thay vì cả track. Bấm giờ trực tiếp trong demo.

### PP-02. Căn đáy box sát mặt đất (Z-grounding)

**Vấn đề.** CVAT không hiển thị mặt đất tham chiếu. Annotator phải xoay, zoom ở các view để ước lượng. Tài liệu cũ ghi thao tác Z chiếm khoảng 35–40% thời gian chỉnh một box, và lơ lửng/lún chiếm khoảng 30% số ca bị trả về.

**Hiện trạng trước khi làm.** Có ba cách tính mặt đất khác nhau (hai ở backend, một trong extension), cho kết quả khác nhau. Bản trong extension có lỗi dùng mặt đất của box đầu tiên cho mọi box sau.

**Giải pháp đã triển khai trong extension** (`extension/src/annotator/terrain.js`). Backend chưa đổi.
1. **Bản đồ địa hình mỗi frame** (theo hướng GroundGrid, RA-L 2024), dựng một lần khi đổi frame, mất 5–16 ms với khoảng 35k điểm:
   - Bỏ điểm nằm trong box đã gán, nới 0,2 m.
   - Lưới 0,4 m. Mỗi ô lấy z thấp nhất; điểm thấp hơn trung vị z thấp nhất của 3×3 ô quanh quá 0,3 m là tia phản xạ dưới đất, bị bỏ. Đây là chỗ lưới min-Z cũ bị kéo xuống.
   - Mỗi ô lưu số điểm, trung bình, phương sai (Welford) của điểm trong dải [sàn, sàn + 2 m].
   - Ô là đất khi vùng 3×3 (5×5 nếu xa hơn 20 m) có ≥ 3 điểm và độ lệch chuẩn gộp ≤ 0,05 m + 0,0015 × khoảng cách. Độ cao ô là trung bình các điểm.
   - Ô không thấy đất (dưới gầm xe, bị che) nội suy từ các ô đất xung quanh theo nghịch đảo bình phương khoảng cách. Bán kính tìm là 2 m + 0,05 × khoảng cách tới LiDAR, vì tia thưa dần.
   - **Độ tin cậy** = min(1, số ô đất làm điểm tựa / 6) × (số góc phần tư có ô đất / 4). Nội suy từ mọi phía đáng tin hơn ngoại suy từ một phía. Bản đầu dùng khoảng cách tới ô đất gần nhất, quá khắt khe với LiDAR thưa.
2. **Tra cho từng box, O(1), chạy được cả lúc kéo:**
   - Lấy độ cao địa hình tại 4 góc footprint, **chỉ dùng ô đất trong ±1 m quanh đáy box**. Trên CVAT thật, mái hiên và sàn cao bị nhận là đất làm người đi bộ bị báo lún tới 4,9 m. Lệch hơn 1 m thì để luật Z thô (PP-09) bắt.
   - Gọi mặt đất thấp nhất và cao nhất dưới footprint là `min`, `max`. **ΔZ = khoảng đáy box nằm ngoài [min, max]**: dương là lơ lửng, âm là lún, 0 nếu nằm trong. Trên bờ vỉa hoặc dốc không biết box tựa mặt nào, nên chấp nhận cả khoảng để tránh báo nhầm.
   - *(26/10)* **Vật che chân.** Người đứng sau rào chắn / capo xe / tường thấp: LiDAR không thấy chân và không thấy đất
     ngay sau vật che, nên 4 góc footprint nội suy từ mặt trên phẳng của vật che, và box đúng bị báo lún (người dùng gặp
     trên CVAT công ty: lún 41 cm; nhãn chuẩn scene-0061: người sau rào chắn lún 60 cm). Khi đáy box thấp hơn `min`, tìm
     ô đất trong 2,5 m quanh box thấp hơn `min` ít nhất 25 cm (cao hơn bờ vỉa). Có từ 2 ô thì box có thể đứng trên mặt
     thấp đó: `min` hạ xuống ô gần đáy box nhất. Chỉ nới chiều lún, không tạo báo lơ lửng mới.
     - Đo trên nhãn chuẩn: scene-0061 (1 663 box, 39 frame) bỏ 3 / 10 báo lún nhầm, cả 3 là người sau rào chắn; AV2
       (1 475 box) không đổi. Hạ giả box đúng 30 / 50 cm: scene-0061 còn bắt 183 / 184 và 315 / 318, AV2 128 / 128 và
       147 / 147.
     - Đã thử và bỏ: bán kính 3,5 m (bỏ 6 / 10 báo nhầm nhưng sót thêm 9% box lún giả); đếm điểm thô thấp hơn mặt đo
       được (kém hơn); điểm của chính vật thấp hơn mặt đo được (không đổi gì trên dữ liệu này); đòi bậc giữa hai ô đất
       kề nhau (không bỏ được báo nhầm nào, sót thêm 7% box lún giả).
     - 7 báo lún còn lại trên scene-0061 đều là người đi bộ 16–39 m. Hai ca xem kỹ chỉ có 1 và 2 điểm LiDAR trong box;
       một ca có mặt đất thật cách 3,4 m, ngoài bán kính.
   - *(27/10)* **Box có pitch / roll.** Spec chỉ cho yaw nhưng CVAT cho kéo nghiêng. Bản cũ chỉ so góc đáy thấp nhất với
     khoảng mặt đất, nên box nghiêng 3° chạm đất một đầu vẫn "sát đất" dù đầu kia hở (xe tải 10,2 m: hở 69 cm). Nay đo
     đất dưới đúng 4 góc đáy thật; box nghiêng thì so từng góc với đất ngay dưới nó và báo góc lệch nhiều nhất (box đã
     nghiêng thì theo được mặt dốc, không cần chấp nhận cả khoảng). Box chỉ có yaw: kết quả không đổi.
   - *(27/10)* **Vẽ đường mặt đất theo độ cao thật dưới các góc**, kéo dài theo độ dốc, thay vì đường phẳng ở góc thấp
     nhất. Người dùng thấy đường "lệch": (1) trên dốc, đường phẳng ở góc thấp nhất nằm dưới đáy box mà vẫn báo sát đất;
     (2) view Side / Front của CVAT xoay theo cả pitch / roll của box, nên box nghiêng trông vẫn nằm ngang còn đường mặt
     đất phẳng thì xiên. Nút Hạ đáy dời box để các góc đáy cân quanh mặt đất (box phẳng: như cũ, giữa mặt thấp nhất và
     cao nhất).
   - *(28/10)* **Kiểm mọi class.** Luật chỉ chạy cho class có tên trong danh sách mặc định (tên nuScenes và spec VN).
     Label CVAT công ty "vehicles" không khớp tên nào nên lệch bao nhiêu cũng không báo, kể cả khi đã hạ ngưỡng trong ⚙
     rồi Save; panel vẫn đo và ghi "cao X cm" nên trông như luật hỏng. Nay `ground.classes: ['*']` (như chồng lấn), bỏ
     tick class trong ⚙ để tắt. Nhãn chuẩn scene-0061 (39 frame): rào chắn và nón giao thông mới được kiểm báo 2,0% và
     2,7% box, ngang người đi bộ (3,3%). Kiểm trên CVAT localhost: lưu ngưỡng Cảnh báo > 5 cm / Lỗi > 10 cm thì box lún
     15 cm chuyển từ ✓ sang Lỗi ngay.
   - *(28/10)* Rà các luật khác: Z, quá xa, box rỗng, ôm vật, scale / hướng theo track, chồng lấn chạy cho mọi class.
     Luật tra theo tên class (khoảng kích thước, thuộc tính bắt buộc, cặp được chồng, người lái / người trong xe) cần
     spec đúng tên label của project. Khoảng kích thước từng im lặng hiện ✓ khi class chưa có khoảng: nay dòng Kích thước
     ghi "chưa có khoảng" (mức Thông tin) kèm nút Spec mở trình sửa đúng class (thử trên AV2: `wheelchair`).
3. **Bằng chứng từ chính vật:** đếm điểm trong footprint cao hơn `max` + 8 cm mà thấp hơn đáy box − 5 cm. Đó là điểm của chính vật (bánh xe, chân) nằm dưới đáy box. Từ 8 điểm trở lên thì báo Lỗi lơ lửng. So với `max` chứ không với `min` để điểm vỉa hè không bị đếm.
4. Độ tin cậy < 0,3 thì báo "không đủ điểm mặt đất" (mức Thông tin), không đoán.
5. **Ngưỡng:** Cảnh báo khi |ΔZ| > 20 cm, Lỗi khi > 35 cm. Bản đề xuất ban đầu là 15/30 cm; đã nới theo dữ liệu thật (mục 6.1). **Chỉ đánh giá box trong 50 m:** trên Argoverse 2, so với bản đồ mặt đất thật, sai số p90 ≤ 10 cm trong 50 m nhưng tới 1,37 m ở 50–75 m (mục 6.2).
6. **Ở server QC** *(chưa làm)*: thêm phép so với trung vị ΔZ của các frame khác trong track, để triệt sai số có hệ thống. Trình duyệt chỉ có point cloud của frame đang mở nên extension không làm được việc này.

**Hiển thị.** Đường mặt đất trên view side/front, khung footprint ở mặt đất trên view top/3D, số ΔZ có dấu. Xanh khi |ΔZ| ≤ 5 cm, cam khi lơ lửng, đỏ khi lún.

**Hạ đáy box** (nút hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>) chỉ áp cho frame đang mở, vì trình duyệt chỉ có point cloud của frame đó. Đáy box được đặt **giữa** `min` và `max` (trên đất phẳng hai mức trùng nhau). Bản trước dời ít nhất (lơ lửng thì hạ tới
`max`, lún thì nâng tới `min`); đo trên box chuẩn ở dốc / bờ vỉa (mặt đất dưới 4 góc chênh > 8 cm) nâng hoặc hạ 30 cm
rồi hạ đáy: đặt giữa lệch nhãn chuẩn p50 3–7 cm, p90 9–18 cm; dời ít nhất lệch p50 tới 16 cm, p90 tới 36 cm.

**Kết quả trên CVAT thật** (nhãn chuẩn nuScenes scene-0061, 10 frame):
- Đo được khoảng 54% box trong 30 m.
- |ΔZ| trung vị 4 cm, p90 16 cm.
- Ngưỡng 20/35 cm báo 9 Cảnh báo + 2 Lỗi trên 132 box đo được, chủ yếu người đi bộ ở 20–45 m. Ngưỡng 15/30 cm báo 18 + 2.
- Bằng chứng "điểm dưới đáy box" báo 1/425 box.

### PP-03. Mất dấu box khi chuyển frame

**Vấn đề.** Sang frame mới phải tìm box, chọn lại và chỉnh lại góc nhìn. Việc này lặp lại ở mọi box, không chỉ box lỗi.

**Giải pháp.** **Khoá box**, bật sẵn (nút ◎ hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>; phím `F` và `D` đơn là phím chuyển frame của CVAT). Khi frame đổi:
- chọn lại đúng box đang khoá (sự kiện `canvas.selected` của CVAT);
- **dời camera đúng quãng tâm box đã đi** giữa hai frame (`setLookAt` của camera-controls trong canvas3d). Góc nhìn và độ zoom annotator đang dùng giữ nguyên, nên box đứng yên trên màn hình.

Bản đầu chỉ chọn lại box mà camera đứng yên. Xe thu chạy thì box trôi dần khỏi màn hình, và annotator dễ chọn / sửa nhầm box khác (CVAT 3D chọn box theo chuột). Không dùng `focusObjectByClientId` mỗi frame vì nó đổi zoom và góc nhìn, kèm hiệu ứng chuyển cảnh.

Cũng áp dụng khi **bấm ô keyframe trên dải track**: tới frame mới vẫn chọn đúng box đó, camera đi theo. Tắt khoá thì bấm ô keyframe đưa camera tới box một lần. Bật lại khoá khi box đã trôi khỏi màn hình thì camera về box trước. Bỏ chọn box trong frame thì thôi khoá, đổi frame không chọn lại box cũ. Box không có ở frame mới (ra khỏi track) thì báo, và chọn lại khi box xuất hiện trở lại.

**Ghi chú.** Không cần ghi box, làm được ngay. Đây là pain point bị đánh giá thấp nhất so với thời gian nó tiêu tốn.

### PP-04. Không biết frame nào trong track bị sai

**Vấn đề.** Muốn tìm frame sai phải mở từng frame.

**Giải pháp đã làm.** Dải tổng quan track: biểu đồ nhỏ theo keyframe cho dài, rộng, cao, yaw. Bấm vào chấm đỏ để nhảy tới frame. Cách đánh dấu keyframe lệch:
- **Kích thước của vật cứng:** dùng **đúng ngưỡng của luật "Scale không đồng bộ"**, lệch trung vị track > max(10 cm, 5%), để dải và thẻ kiểm tra cùng một kết luận. Bản đầu dùng trung vị + MAD; khi 40% keyframe cùng lệch thì MAD phình ra, nên không đánh dấu keyframe nào dù luật vẫn báo.
- **Kích thước người / động vật:** trung vị + MAD, |x − trung vị| > max(3 × 1,4826 × MAD, 5 cm).
- **Yaw (hiện tại):** **đoán yaw của mỗi keyframe từ lân cận** bằng 4 cách: nội suy giữa i−1 và i+1, giữa i−2 và i+2
  (theo số frame, cung ngắn nhất, như CVAT nội suy), ngoại suy thẳng từ hai keyframe trước, từ hai keyframe sau. Chỉ đánh
  dấu khi **mọi** cách đoán đều lệch quá ngưỡng. Xe rẽ thật (kể cả rẽ gắt, tốc độ quay đổi dần) luôn có cách đoán khớp;
  một keyframe sai thì không cách nào khớp, còn keyframe kề nó vẫn có cách đoán không đi qua keyframe sai. Keyframe đầu /
  cuối track được kiểm bằng ngoại suy (các bản trước bỏ qua). Không unwrap cả track.
  - Bản 1 so với trung vị cả track: nhầm 94/1395 keyframe chuẩn vì xe rẽ thật.
  - Bản 2 unwrap rồi so với lân cận: chỉ bắt 2/26 keyframe lật đúng 180° (mục 6.2).
  - Bản 3 so với hướng trung bình tròn của lân cận: một keyframe quay 90° kéo cả hai keyframe kề bị đánh dấu theo.
  - Bản 4 (thử ngày 25/10, đã bỏ) bỏ dần lân cận lệch nhất: kề bị lây ít hơn nhưng đánh dấu nhầm xe rẽ gắt ở ngã tư
    (nuScenes scene-1077, 2 Hz: −156° → 176° → 153° → 137°) vì bỏ hết lân cận phía trước khúc cua.
  - So trên nhãn chuẩn thật (mục 6.3): nuScenes mini 644 track / 14 536 keyframe và AV2 47 track, mỗi track chèn một
    keyframe sai ở vị trí ngẫu nhiên:

    | | Báo nhầm nhãn sạch | Bắt lật 180° | Bắt lật ở đầu / cuối track | Keyframe kề bị đánh dấu lây (quay 90°) |
    |---|---|---|---|---|
    | Bản 3 | 3 (0,02%) | 563/644 nuScenes, 45/47 AV2 | 0/76 | 1345 nuScenes, 130 AV2 |
    | Bản 4 (bỏ) | 25 (0,17%) | 563/644, 45/47 | 0/76 | 137, 5 |
    | **Hiện tại** | **3 (0,02%)**, AV2 0 | **633/644, 47/47** | **75/76** | 220, 11 |
  - Ngưỡng theo dữ liệu chuẩn: **15° cho vật cứng** (xe, rào chắn lệch lân cận tối đa 12°), **45° cho người / động vật** (người đi bộ tối đa 37°).

**Chưa có:** dải khoảng cách tới mặt đất và số điểm theo frame, vì trình duyệt chỉ có point cloud của frame đang mở.

### PP-05. Không thấy box đã ôm hết vật chưa

**Vấn đề.** Point cloud cùng màu, không phân biệt điểm thuộc box.

**Giải pháp đã làm** (`extension/src/annotator/object-points.js`, cùng cách làm với `core/box_points.py` của backend):
1. Lấy điểm trong box nới 0,5 m. Bỏ điểm cao hơn nóc + 0,3 m, điểm thuộc box khác, và điểm thấp hơn **mặt đất ngay dưới chính điểm đó** + 15 cm.
   - Mặt đất của từng điểm tra trên bản đồ địa hình (PP-02), chỉ dùng ô đất trong ±1 m quanh đáy box, nhớ theo ô để không tra lại.
   - Bản đầu dùng **một** độ cao chung cho cả box (mặt đất thấp nhất dưới footprint + 15 cm). Trên dốc hoặc bờ vỉa, điểm mặt đường ở phía cao lọt qua ngưỡng, rồi phép loang lan theo vệt tia trên mặt đường.
   - Gặp trên Argoverse 2: 27/28 "điểm lòi ra" của một xe là điểm mặt đường, kèm nhãn sai "trái lòi 23 cm". Sau khi sửa, cả frame chỉ còn 1 điểm như vậy, và xe đó thành "trái 1 cm".
2. **Chỉ giữ điểm nối liền với vật:** loang qua ô lưới 0,3 m (26 hướng), bắt đầu từ các điểm nằm trong box nới 0,3 m. Cây, tường, cột cách vật quá một ô bị loại. Mặt đất đã bị bỏ ở bước 1 nên không còn làm cầu nối cho phép loang.
3. **Đổi màu chính các điểm của point cloud CVAT** (`cloud-colors.js`): điểm trong box (dung sai 4 cm) **xanh lá**, điểm của vật lòi ra ngoài box **đỏ**. Bốn view của CVAT dùng chung một geometry, nên điểm đổi màu ở cả 4 view, đúng độ sâu, không bị che. Màu gốc được giữ lại và trả về khi bỏ chọn, đổi box hay đổi frame; nhãn không bị đụng tới. Bản đầu chỉ vẽ chấm SVG nhỏ chồng lên canvas, annotator test không nhận ra. Nay chấm SVG chỉ còn là phương án dự phòng khi point cloud không có màu theo điểm.
4. **Khoảng hở từng mặt** (đầu, đuôi, trái, phải, nóc). Khoảng hở = nửa kích thước − phân vị 98% tọa độ cụm điểm theo trục đó. Dương là box dư ("đuôi dư 24 cm"), âm là vật lòi ra ("trái lòi 8 cm"). Nhãn hiện ở view nhìn thấy mặt đó. Một mặt chỉ được đo khi **nhìn thấy rõ**:
   - Quay về phía LiDAR và **không bị nhìn xiên quá 70°**: góc giữa pháp tuyến mặt và hướng tới LiDAR ≤ 70°.
   - **Không bị che:** trên tia từ LiDAR tới tâm mặt có ít hơn 3 điểm của vật khác cách tia < 0,3 m.
   - Bản đầu chỉ xét "quay về phía LiDAR", nên báo "đuôi dư 72 cm" cho một xe mà LiDAR nằm lệch hẳn sang hông: mặt đuôi bị nhìn xiên khoảng 10° và có vật chắn. Sau khi sửa, frame AV2 đó chỉ còn 9 mặt đủ điều kiện để đo. Tính cho 39 box mất 45 ms.
5. **Dòng "Ôm vật" trên checklist (0.5.0)** tô vàng khi một mặt nhìn thấy có vật lòi ra > 10 cm, **hoặc** ≥ 20 điểm đỏ chiếm
   ≥ 15% điểm của vật. Box dư chỉ ghi số, không tô vàng (nhãn chuẩn nuScenes dư p90 tới 33 cm).
   - Thử trên CVAT thật: xe ngắn đi 40 cm có 272 điểm đỏ (37%) nhưng không mặt nào đủ điều kiện để đo, nên chỉ dùng mặt
     thì bỏ sót.
   - Đo trên box chuẩn và box co 15% (nuScenes scene-1077, scene-1100, AV2): báo nhầm 0–5% như khi chỉ dùng mặt; bắt được
     38% / 78% / 76% box co, so với 32% / 78% / 71%. Dùng riêng tỉ lệ điểm đỏ thì bắt kém hơn (14% / 59% / 65%).

**Kiểm trên CVAT thật:** xe tải 16 m có 479 điểm trong box (xanh lá), 4 điểm lòi ra (đỏ), đo được mặt đuôi và mặt phải.

**Cố ý không làm.** Tự fit box vào cụm điểm. Tài liệu cũ đã đo: khung dựng từ cụm điểm lệch tâm 44–84 cm vì LiDAR chỉ thấy mặt gần.

### PP-06. Box chồng nhau và trùng track

**Vấn đề.** Ở bãi đỗ và dòng xe máy đông, box dễ lấn nhau. Tracker của pre-label đôi khi sinh hai track cho một vật.

**Giải pháp:**
- Tỉ lệ chồng = diện tích chồng nhìn từ trên (cắt đa giác lồi Sutherland–Hodgman) / diện tích box nhỏ hơn, khi hai box có phần thể tích chung. Chia cho box nhỏ hơn để bắt box nhỏ nằm gọn trong box lớn, trường hợp IoU bỏ sót. Chồng theo chiều cao ≤ 1 cm hoặc phần chung nhìn từ trên ≤ 1 cm² coi là chạm mép.
- Bỏ qua cặp spec cho phép (`overlap_allowed_pairs`: người–người, người–xe hai bánh, đầu kéo–rơ-moóc…).
- *(Đã làm)* Trong lúc kéo: box đang chồng có khung **đỏ đậm**, phần chồng tô đỏ ở view Top / 3D, nhãn "chồng X%" cạnh box kia, và mục trong panel. Bản đầu: Cảnh báo > 20%, Lỗi > 50%, chỉ khi chồng theo chiều cao ≥ 30%.
- *(Đã làm)* **Cặp spec cho phép vẫn hiện**, ở mức Thông tin với khung xám. Bản đầu bỏ qua hoàn toàn các cặp này, nên trên nhãn chuẩn annotator không thấy gì: mọi box đang chồng trong frame đều là cặp được phép (xe đạp–người 32%, người đứng trên thùng xe tải 100%), và annotator tưởng tính năng không chạy.
- *(Đã làm, 26/10)* **Cứ chồng là Lỗi, mọi class** (theo yêu cầu người dùng). Ngưỡng mặc định `overlap.warning` =
  `overlap.error` = 0, `overlap.classes: ['*']` (thêm cọc tiêu, rào chắn, Obstacle và class bất kỳ của project), bỏ điều
  kiện chồng theo chiều cao ≥ 30%. Lấn dưới 1% ghi "chồng <1%". Cặp spec cho phép vẫn chỉ là Thông tin. Project muốn nới
  thì đặt lại ngưỡng / bỏ tick class trong ⚙. Tool QC dùng chung luật nên cũng báo theo.
  - Đo trên nhãn chuẩn công khai (box có cặp chồng không được phép / tổng box): nuScenes scene-1100 0 / 848, scene-1077
    54 / 639 (toàn rào chắn nối nhau, < 20%), scene-0061 630 / 3 333 (rào chắn nối nhau, rào chắn – xe công trình / người /
    cọc tiêu; 161 cặp < 1%), AV2 116 / 1 515 (người ngồi xe lăn 100%, xe đạp – xe con, xe – xe). Phần lớn là lấn
    thật nhưng nhỏ mà người gán nhãn chuẩn để nguyên; luật cũ không kiểm rào chắn và bỏ qua phần chồng dưới 20%.
- *(Đã làm, 26/10)* **Cặp "được phép" mà vi phạm spec thì không còn là "được phép".** Bản trước coi mọi cặp người–xe hai
  bánh, người–xe là được chồng, nên hai lỗi spec không bị báo. Nay extension có hai luật giống bộ quét QC, xét trước danh
  sách cặp được phép, báo ở cả box người lẫn box xe:
  - `spec.rider_double` (spec 4.3C): xe ghi `with_rider` mà người lái còn box riêng (≥ 50% footprint của người nằm trong
    xe, đáy lệch < 1 m). Người dắt xe `without_rider` vẫn là "được phép chồng".
  - `spec.inside` (spec 4.3B): box người nằm trong box xe (tâm trong footprint, đáy người không cao hơn đáy xe 0,6 m). Người
    đứng trên nóc / thùng xe không bị báo.
  - Trên 4 310 box người đi bộ nhãn chuẩn nuScenes mini: 0 báo nhầm `spec.inside`.
- *(Chưa làm)* Nghi trùng track: cùng class, chồng ≥ 70% ở ≥ 3 frame liền nhau. Gợi ý giữ track nào, xóa track nào; người dùng xác nhận.

### PP-07. Kích thước sai class, scale không đồng bộ

**Giải pháp (luật đã có ở backend, chuyển sang extension):**
- **Kích thước ngoài ngưỡng** (`size.class_range`): so với khoảng kích thước theo `Class/subtype`, nới 10% thì Cảnh báo, 25% thì Lỗi.
  - Khoảng cũ dựng từ 5 cảnh nuScenes. Thử trên cảnh ngẫu nhiên scene-1100 (mục 6.3): 41/248 box chuẩn bị báo, do xe tay
    ga dài 1,27 m (`vehicle.motorcycle` của nuScenes gồm cả xe tay ga nhỏ) và người gầy / trẻ em rộng 0,41 m. Trên cả 10
    cảnh nuScenes mini, khoảng cũ báo nhầm: xe máy 16,7%, bus 7,7%, nón giao thông 7,1%, người 5,4%, trailer 29%.
  - Đã nới các class đó theo min–max nhãn chuẩn của 10 cảnh (người dài 0,30–1,30 m, rộng 0,30–1,05 m, cao 1,00–2,20 m;
    xe máy dài 1,20–2,80 m, rộng 0,45–1,45 m…): báo nhầm trên 14 129 box chuẩn từ **3,4% xuống 0,5%**. Trên AV2 (không
    dùng để chỉnh) người từ 11,9% xuống 0%; còn lại 3 track ở 108–156 m có kích thước bất thường thật (xe rộng 2,8 m).
  - **Giữ nguyên khoảng của car** (1,3% báo nhầm): đây là luật bắt pre-label cắt ngắn xe. Trên pre-label thật của
    PointPillars (KITTI 000008) nó bắt được xe dài 3,14 m.
  - `pointsnap/config.yaml` của bộ quét QC **chưa** cập nhật theo: cần làm khi tới phần QC.
  - *(26/10)* **Xe hai bánh có / không người lái** tách theo chiều cao box: nhãn chuẩn nuScenes mini (596 box có thuộc tính
    `cycle.with_rider` / `without_rider`) cho có người 1,56–1,93 m, không người 0,95–1,53 m. Khoảng `Two-wheels/with_rider`
    cao 1,50–2,00 m, `without_rider` 0,90–1,55 m (extension và `spec-vn.yaml` của QC). Khoảng cũ chồng nhau (1,0–2,0 và
    0,8–1,8), nên xe ghi `with_rider` mà box không gồm người, hoặc ngược lại, không bị báo. Nay báo và gợi ý "hoặc thuộc tính
    rider_state chọn sai"; báo nhầm 1/596 box (xe không người cao 1,74 m, mức Cảnh báo).
- **Scale không đồng bộ** (`size.in_track`): lệch so với trung vị track > max(10 cm, 5%) thì Cảnh báo, > max(30 cm, 15%) thì Lỗi. Không áp cho người và động vật.

Ngưỡng kép (tuyệt đối và tương đối) co giãn theo cỡ vật: cùng một epsilon không thể vừa cho xe buýt 12 m vừa cho cọc tiêu 0,4 m.

**Cần làm.** Thống kê lại khoảng kích thước trên dữ liệu VN, vì nhiều khoảng (van, ba gác, động vật) đang là ước lượng. Trên CVAT thật, xe buýt nuScenes rộng 3,52 m bị báo Cảnh báo vì khoảng `bus` đang là 2,2–3,2 m (4 lần trên 840 box): khoảng này cần nới theo dữ liệu.

### PP-08. Hướng box lật hoặc đổi đột ngột

**Giải pháp:**
- **Phát hiện** (`heading.flip`): cắt track tại chỗ hướng đổi nhanh hơn tốc độ quay hợp lý của nhóm class. Ngưỡng max(`flip_warning_deg`, `yaw_rate_max_dps` × dt) tự nới theo thời gian giữa hai keyframe, đúng hơn một ngưỡng số frame cố định. Đoạn dài nhất làm chuẩn.
- **Sửa: "Làm mượt yaw"** *(đã làm)*:
  1. **Phát hiện lật đầu trên góc gốc**, chưa unwrap: keyframe bị lật khi **đa số** keyframe lân cận (cửa sổ 5) lệch nó ≥ 150°. Bản đầu unwrap trước rồi so với trung vị, nhưng unwrap qua chỗ lật làm lệch 2π mọi frame phía sau nên không phát hiện được. Một đoạn dài bị ngược không đạt đa số nên giữ nguyên, để annotator tự xoay cả đoạn.
  2. Xoay keyframe lật thêm π, rồi unwrap.
  3. Lọc trung vị với **cửa sổ đối xứng, co lại ở hai đầu track**. Cửa sổ lệch một phía kéo cuối đoạn rẽ về phía giữa. Lọc trung vị giữ nguyên bước nhảy của đoạn rẽ thật.
  4. Chỉ đổi keyframe lệch > 2°.
- **Chỉ cho vật cứng.** Trên nhãn chuẩn, xe / rào chắn chỉ bị đổi 1 keyframe (2°), nhưng người đi bộ bị đổi 25/602 keyframe tới 10° vì người xoay thật. Đã tắt cho người và động vật.

**Lưu ý cấu hình.** `track.keyframe_interval_s = 0.5` là của nuScenes (2 Hz). Dữ liệu thật 10 Hz mà không có timestamp thì tốc độ tính ra thấp đi 5 lần, và luật hướng theo chuyển động sẽ bỏ qua. Phải đặt đúng tần số dữ liệu.

### PP-09. Box có Z vô lý ở nơi thiếu điểm mặt đất (mới)

**Vấn đề.** Luật lơ lửng/lún im lặng khi quanh box thiếu điểm mặt đất (ở xa, chỗ đông xe). Một box bị kéo lệch 2 m ở khoảng cách 50 m sẽ lọt.

**Giải pháp đã làm.** Kiểm tra thô "Z ngoài ngưỡng": đáy box so với **mặt đất chung của vùng**, tức **phân vị 20%** độ cao các ô đất trong bán kính 15 m trên bản đồ địa hình. Nằm ngoài [−1 m, +2 m] thì báo, **chỉ trong 35 m**, mức **Cảnh báo**, bỏ qua box `occluded`.

**Vì sao khác đề xuất ban đầu** ([−0,5, +0,5] m, mức Lỗi, dùng trung vị). Trên CVAT thật, bản đầu báo Lỗi nhầm 55/210 box chuẩn:
- Cảnh thật có nhiều tầng mặt đất. Nhãn chuẩn có người đứng trên bục cao hơn mặt đường 1,6 m.
- Mái nhà / sàn cao phẳng bị nhận là ô đất, kéo trung vị lên tới 11 m. Mặt đất thật luôn nằm dưới các mặt đó, nên dùng phân vị thấp.
- Xa hơn 35 m, point cloud gần như chỉ còn các mặt cao; mặt đất chung không tin được.

Sau khi sửa: 0 báo nhầm trên 840 box chuẩn. Luật này chỉ còn là lưới an toàn cho box bị kéo lệch thô (≥ 1 m xuống hoặc ≥ 2 m lên) ở chỗ thiếu điểm đất quanh box.

**Không dùng Z tuyệt đối theo hệ cảm biến.** Ở 80 m trên dốc 5%, mặt đường đã chênh khoảng 4 m.

### PP-10. Box nằm ngoài phạm vi gán nhãn (mới)

**Vấn đề.** Pre-label gán cả vật ở xa ngoài phạm vi spec. Nếu không phát hiện sớm, QC phải trả về.

**Giải pháp đã làm.** Kiểm tra "Quá xa": √(x² + y²) từ tâm box tới gốc LiDAR > `maxDistanceM` thì Cảnh báo. Dữ liệu ở hệ xe thu thì đặt `sensorOrigin` là vị trí LiDAR. Mặc định `maxDistanceM = null` (tắt) cho tới khi có số theo spec; đặt ở **Tùy chọn → Guideline ghi đè**.

**Cần chốt.** Khoảng cách tối đa theo spec, và có chia theo class không.

### PP-11. Không biết track nào đã làm xong

**Giải pháp đã làm.** Nút **Đánh dấu xong** hoặc <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. Lưu trong trình duyệt, chỉ lưu ID track (server ID; track mới chưa Save thì chỉ giữ tới khi tải lại trang), không lưu dữ liệu nhãn. Panel hiện tiến độ ("23/41 track xong") của frame đang mở và nút **Track chưa xong ›**.

### PP-12. Spec dài, thuộc tính đổi theo thời gian

**Giải pháp:**
- *(Đã làm)* Kiểm tra thiếu thuộc tính bắt buộc theo spec-vn, mức Lỗi. Khoảng kích thước tra theo `Class/subtype`.
- *(Đã làm)* **Thẻ spec** (nút **Spec** cạnh tên box) theo class của box đang chọn:
  - Khoảng kích thước của `Class/subtype`, có đánh dấu ✓ / ✗ theo kích thước box hiện tại.
  - Thuộc tính bắt buộc kèm giá trị đang chọn.
  - Các class được phép chồng box.
  - Quy tắc spec ngắn: chung (4.2) và theo class (người trong xe 4.3B, người lái 4.3C, nhóm người 4.3B, đàn động vật 4.3E).

  Nội dung lấy từ `specNotes` của guideline, dự án ghi đè được ở Tùy chọn.
- *(Chưa chuyển sang extension)* Các luật thuộc tính khác đã có ở backend: sai giá trị, thuộc tính không khớp chiều cao, quên đổi `rider_state`.
- *(Chưa làm)* Thao tác "đổi thuộc tính từ frame này tới hết đoạn" (cần ghi box).

### PP-13. Kéo chuột không chính xác, box mới cỡ mặc định

**Giải pháp.** Ô nhập số cho dài, rộng, cao, yaw, Z. Box mới tạo tự nhận kích thước mẫu theo class/subtype (trung vị khoảng trong spec).

---

## 4. Chi tiết pain point của QC

### PP-14. Sót vật do pre-label bỏ sót

**Hiện trạng.** Luật `lidar.missing` gom cụm điểm ngoài mọi box, nối cụm qua các frame, rồi báo chuỗi di chuyển đều. Trên nuScenes tìm lại được 66–71% vật bị bỏ box.

**Cải tiến.**
- Nối cụm bằng Kalman vận tốc không đổi + ghép Hungarian, **cho phép vắng 1–2 frame**. Hiện chỉ cần mất một frame là đứt chuỗi, và ghép tham lam dễ ghép chéo hai người đi gần nhau.
- Gom cụm có xét độ cao để người dưới tán cây không dính vào cây.

**Vị trí.** Tầng scan chuyên sâu trên server cạnh CVAT, không thuộc demo annotator.

### PP-15. QC không biết đã xem track/frame nào

**Giải pháp.** Bảng độ phủ theo track trong extension ở chế độ QC. Danh sách track xếp theo rủi ro, dùng kết quả scan để xếp thứ tự xem chứ không làm phán quyết.

### PP-16. Ghi issue tốn thời gian, không thống nhất

**Giải pháp.** Mẫu issue một chạm (sai kích thước, lơ lửng, sai hướng, sót vật, sai class, sai ID), gắn sẵn track, frame và điều khoản spec. Có cả issue cho lỗi QC tự thấy mà scan không bắt.

**Lưu trữ.** Lưu trong CVAT qua API Issue bằng phiên đăng nhập của QC. Annotator thấy issue ngay trong extension, kèm gợi ý sửa với issue hình học.

**Cần kiểm.** CVAT có lưu và trả về được Issue cho job 3D qua API không.

### PP-17. Re-review phải xem lại cả job

**Giải pháp.** So sánh lần nộp trước và lần nộp lại theo từng track/frame. Chỉ hiện issue cũ (đã sửa chưa) và box bị đổi thêm ngoài issue.

### PP-18. Báo nhầm làm mất niềm tin; kết luận mất sau quét lại

**Vấn đề:**
- Bộ quét báo nhầm khoảng 3 Cảnh báo/100 box trên nuScenes. Job 100 frame × 50 box nhận khoảng 150 cảnh báo rác.
- Kết luận "Báo nhầm" của QC gắn với lần quét. Quét lại thì báo nhầm cũ hiện lại nguyên vẹn.

**Giải pháp:**
- Kết luận gắn với khóa ổn định (job, track, frame, luật) thay vì lần quét.
- Đo precision từng luật trên dữ liệu thật, từ kết luận Đúng/Báo nhầm của QC.
- **Chỉ chặn submit bằng luật gần như không báo nhầm:** thiếu/sai thuộc tính, box rỗng, trùng box. Không dùng "Z ngoài ngưỡng" để chặn: trên dữ liệu thật mặt đất chung chỉ tin được trong 35 m (PP-09).
- Luật có ngưỡng hình học chỉ cảnh báo. Annotator bỏ qua được nhưng phải chọn lý do, và QC thấy danh sách đã bỏ qua.
- *(Đã làm, phía annotator)* Nút **✕** trên dòng Cần xem / Lỗi của checklist: "báo nhầm, không báo mục này cho box này nữa".
  - Áp dụng cho cả track: mọi frame của track, theo ID track trên server.
  - Dòng chuyển xám "đã bỏ qua", không tính vào số mục cần xem, nút sửa ẩn đi. Nút ↺ hiện lại cảnh báo.
  - Bỏ qua Kích thước / Hướng thì dải track thôi tô vàng vì lý do đó. Bỏ qua Chồng lấn thì thôi vẽ khung đỏ.
  - Lưu theo job trong trình duyệt (`localStorage`), không ghi vào CVAT; QC chưa thấy. Chọn lý do và cho QC xem danh sách để cho phase QC.

**Rủi ro hành vi.** Nếu luật kích thước chặn submit, annotator junior có thể kéo box cho tắt cảnh báo thay vì sửa đúng (ví dụ thu box van về cỡ car). Lỗi rõ ràng biến thành lỗi ẩn.

### PP-19. Scan QC chỉ lặp lại luật của annotator thì không đáng chạy (26/10)

**Bằng chứng.** Bản đầu của dịch vụ QC (`qc/`) chạy đúng bộ luật theo từng box của extension. Trên 4 job công khai (6 405
box) nó ra đúng những gì bảng annotator đã báo khi mở từng box. Thêm được hai thứ: box annotator chưa mở tới, và gộp theo
track. QC cần luật mà người sửa từng box không thấy được.

**Giải pháp.** Hai lớp luật:
- Theo từng box: **dùng chung** với annotator (cùng code) để hai bên không ra kết luận ngược nhau.
- **Chỉ QC**, cần nhìn nhiều frame / cả job: đứt track, đổi ID, track trùng, box nhảy trong một frame (PP-20); sau đó
  chuyển động xe thu tự ước lượng từ point cloud và sót vật (PP-14).

### PP-20. Pre-label: keyframe ở mọi frame, tracker đứt / đổi ID, box rung từng frame (26/10)

**Bằng chứng.**
- Job pre-label và nhãn chuẩn đều có keyframe ở mọi frame: job 69 có 3 900 keyframe cho 219 track / 39 frame. Luật "box
  trôi ở frame nội suy" không có gì để bắt; lỗi nằm ở **từng frame** do model sinh ra.
- Tracker của model hay đứt một vật thành nhiều track, đổi ID khi hai vật đi gần nhau, sinh hai track cho một vật.
  Annotator sửa từng box nên khó thấy; QC mở từng frame thì không kịp.

**Giải pháp (QC).**
- `track.fragment`: một track kết thúc, track mới cùng nhóm class bắt đầu gần đó trong vài frame (vị trí đoán theo vận
  tốc) → nghi cùng một vật bị đứt ID.
- `track.swap`: hai track cùng class đổi chỗ cho nhau (mỗi track nhảy về phía vị trí của track kia) → nghi đổi ID.
- `track.duplicate`: hai track chồng nhau ở nhiều frame liền → một vật vẽ hai lần.
- `track.jump`: vị trí / kích thước / hướng ở một frame lệch hẳn so với mọi cách đoán từ frame lân cận (cùng cách của
  `heading.jump`).

**Đã làm (26/10, `qc/lib/trackrules.js`).** Đo trên 4 job công khai (6 405 box, 366 track):

| | Bản đầu | Bản cuối |
|---|---|---|
| Báo trên nhãn chuẩn (box) | 289 (đứt track 211 ở scene-0061, vẽ hai lần 40 ở AV2) | 8, gộp thành 5 mục |

Ba thay đổi làm số báo nhầm giảm:
- **Chuyển động xe thu ước lượng từ chính nhãn.** CVAT không lưu pose; vật đứng yên vẫn trôi 5 m mỗi frame theo xe thu. Khớp
  phép quay + tịnh tiến mà đa số track đồng ý (RANSAC 2 điểm). Luật chuyển động chạy trên cả toạ độ xe thu lẫn toạ độ đã bù,
  chỉ báo khi cả hai cùng báo: scene-0061 (nhiều rào chắn) toạ độ xe thu báo nhầm hàng trăm mục; scene-1077 (cao tốc, ít vật
  đứng yên) thì toạ độ đã bù báo nhầm nhiều hơn.
- **Hai track cùng có mặt ở một frame thì không thể là một vật bị tách ID** (bỏ 200 báo nhầm "đứt track" giữa các rào chắn).
- **Nhiều track cùng nhảy ở một frame** (≥ 3 và ≥ 15% số track đang chạy) là lỗi cả frame (lệch thời điểm frame, xe thu
  phanh), không báo từng track; ghi một dòng cho QC.

Bắt lỗi cài vào bản sao nhãn (15 lần mỗi loại mỗi job): box lệch 3 m ở một frame 77%, lệch 1,5 m 63%, to thêm 30% 70% (người
và vật không cứng được nới 35% nên không bắt), đứt track 88%, đổi ID 93%, vẽ hai lần 80%. Bỏ sót chủ yếu ở vật chạy nhanh (ngưỡng
nới theo quãng đường mỗi frame) và keyframe đầu / cuối track (chỉ có ngoại suy). 5 mục còn lại trên nhãn chuẩn chưa mở xem
được là nhãn chuẩn bị tách ID thật hay báo nhầm.

**Rà lại "Nghi đứt track" (27/10).** Xem từng mục trên nhãn chuẩn theo toạ độ đã bù chuyển động xe thu: 3/4 là báo nhầm
(hai nón đứng yên cách nhau 1,3 m và 2,6 m thay nhau hiện; hai người đi cạnh nhau cách 1 m). Sửa:
- Ngưỡng theo **cỡ vật** (¼ chiều dài, trong 0,5–2 m) thay cho 2 m cố định; chỉ nới **dọc hướng chạy** theo quãng đường đi
  trong khoảng đứt, **ngang hướng chạy** thì không (xe làn bên cạnh).
- Đoán **hai chiều** (đoạn trước đi tới, đoạn sau lùi về); **vận tốc hai đoạn** lệch > max(30%, 0,5 m/frame) là hai vật.
- Báo khi một trong hai hệ toạ độ nối được (đòi cả hai thì bỏ sót nửa số ca cài), trừ khi toạ độ đã bù cho thấy hai vật
  đứng yên cách nhau (hàng nón dọc đường). So khớp hai hệ toạ độ phải cùng object kia (trước đó chỉ so object + frame).
- Mục ghi hai frame (cuối đoạn trước, đầu đoạn sau); `maxGapFrames` đếm số frame trống.

Kết quả: 27 edge case (`qc/test/fragment.test.js`: xe chạy, rẽ, xe nhanh 15 m/frame, nón đứng yên khi xe thu chạy 8 m/frame,
người đi bộ, nhãn rung ±20 cm, đoạn chỉ một keyframe, biên 5 frame trống, xe buýt 12 m; và các ca không được báo: hai nón cạnh
nhau, xe sau tới chỗ xe trước vừa rời, xe làn bên, xe ngược chiều, xe cùng làn chậm hơn 40%, khác class, cùng track ra vào,
hai track cùng có mặt) đúng cả 27. Nhãn chuẩn còn 1 mục (scene-1077, car #61 → car #3: nối liền nhau, lệch 74 cm, kích
thước lệch 0,5 m, nhiều khả năng nhãn chuẩn tách ID thật). Bắt đứt track cài vào 4 job 92% (55/60).

**Phản hồi của QC (27/10):** mục scene-1077 car #61 → #3 là **hai xe khác nhau** (QC xem trên CVAT: frame 14 LiDAR quét
thưa, box #61 xoay lệch). Luật chỉ nhìn chuyển động box nên không phân biệt được. Làm lại theo 4 bước:

1. **Chuyển động xe thu khớp từ point cloud** (`qc/lib/icp.js`): bỏ mặt đất và điểm trong box đã gán, chiếu xuống mặt
   phẳng, tìm thô hai tầng quanh dự đoán rồi ICP 2D. 25 ms/frame. Rào / nón đứng yên theo toạ độ đã bù: scene-0061 lệch
   tối đa trung vị 18 cm, p90 30 cm (ước lượng từ nhãn: 30 / 77 cm); scene-1077 (cao tốc) p90 38 cm (từ nhãn: 13 m, sai hẳn:
   xe thu thật chạy 6 m/frame, ước lượng từ nhãn ra 10–12 m).
2. **Ghép đoạn track một-một bằng Hungarian** trên chi phí chuẩn hoá (lệch dự đoán dọc / ngang hướng chạy, lệch vận tốc,
   lệch kích thước, độ dài khoảng đứt), sau khi loại cặp vượt ngưỡng.
3. **Bằng chứng point cloud ở chỗ nối** (`qc/lib/evidence.js`): đặt box "ma" ở chỗ mỗi vật lẽ ra ở trong frame của vật
   kia; có cụm điểm ở đó không thuộc vật thật (nối nhau trong 0,6 m) và không thuộc box nào khác → hai vật, bỏ mục. Với #61 →
   #3: ở frame 14 có 11 điểm ở chỗ #3 lẽ ra ở mà không nối với cụm của #61 → hai vật, đúng như QC nhận định.
4. **Hình nhìn từ trên trên trang QC**: nút "Xem point cloud chỗ nối" vẽ điểm LiDAR (thân vật sáng, mặt đất mờ), box hai
   đoạn và box ma nét đứt ở hai frame, đọc thẳng từ CVAT, không lưu.

Kết quả cả luồng: nhãn chuẩn 4 job **0 mục đứt track** (1 cặp bị loại nhờ point cloud: #61 → #3); đứt track cài vào 4 job
bắt **29/31 (94%)**; 27 edge case vẫn đúng. Thời gian quét thêm 3–7 s mỗi job 40 frame (AV2 16 s).

**Giới hạn.** Khác class ở chỗ đứt (pre-label đổi car → truck) chưa báo. `maxGapFrames` tính theo frame, nên với dữ liệu
10 Hz thì 5 frame chỉ là 0,5 s. Cảnh quá ít vật đứng yên thì chuyển động xe thu ước lượng có thể bám nhầm vào xe đang chạy.

### PP-21. Không biết box pre-label nào chưa ai sửa (26/10)

**Bằng chứng.** CVAT local: shape của job pre-label 73 có `source = auto`; track chỉ có `source` cho **cả track**
(job 69: 219 track `manual`, 3 900 keyframe không có `source`). Không biết annotator đã sửa frame nào trong track.

**Hướng.** Giữ bản pre-label gốc lúc nhập (trên máy dịch vụ QC) và so với nhãn hiện tại; kiểm xem sửa box `auto` thì
CVAT có đổi `source` thành `semi-auto` không. Chưa làm.

### PP-22. Luật chung báo nhầm trên nhãn chuẩn (26/10)

**Bằng chứng** (4 job công khai, chi tiết ở [qc-scan-phan-tich-thiet-ke.md](qc-scan-phan-tich-thiet-ke.md) mục 9.3):
- Lơ lửng / lún: 20/26 mục là người / xe máy ở 23–48 m, ≤ 20 điểm, độ tin cậy mặt đất 0,30–0,56.
- `z.range`: điểm nhiễu z = −24,5 m (phản xạ) thành ô đất, mặt đất chung tính ra −24,5 m.
- `heading.jump`: 14/14 mục ở keyframe đầu / cuối track; 5 là nón giao thông (yaw không có nghĩa).
- `overlap`: 13/41 cặp chồng < 1% (rào chắn nối nhau), vì spec hiện tại "cứ chồng là Lỗi".

**Hướng.** Sửa ở luật chung (extension), quét lại để đo; QC ghi Đúng / Báo nhầm để có precision thật theo luật.

### PP-23. Guideline đổi liên tục (26/10)

**Bằng chứng.** Chỉ trong 26/10, luật chồng lấn đổi từ "> 20% Cảnh báo, chỉ một số class" sang "cứ chồng là Lỗi, mọi
class": số box bị báo ở scene-0061 từ gần 0 lên 630 / 3 333. Kết quả quét cũ và mới không so được nếu không biết quét
theo guideline nào.

**Giải pháp.** Trình sửa guideline ngay trong trang QC, theo project: chỉnh ngưỡng bằng ô nhập / bật tắt, không sửa code;
mỗi lần lưu là một **phiên bản** (ai, khi nào, đổi gì); mỗi lần quét ghi phiên bản đã dùng; quay về phiên bản cũ được.

**Đã làm (26/10).** Tab **Guideline** của trang QC: chọn project (hoặc bản chung), bật / tắt từng luật, ô ngưỡng có đơn vị
(ô đã sửa tô xanh, ↺ để hoàn tác), bảng khoảng kích thước theo `Class/subtype`, thuộc tính bắt buộc, cặp được phép chồng,
nhập / xuất JSON (nhận cả file Export của trình sửa spec trong extension). Thanh lưu hiện số thay đổi và ô ghi chú; mỗi lần
lưu thành v1, v2…, khôi phục bản cũ tạo phiên bản mới. Chỉ lưu phần khác mặc định, nên khi mặc định được hiệu chỉnh, project
vẫn hưởng phần mình không sửa. Mỗi lần quét ghi guideline + phiên bản đã dùng; guideline đổi sau đó thì trang job nhắc quét
lại. Thử trên CVAT local: đặt chồng lấn < 2% không báo và tắt "box rỗng" → scene-0061 từ 35 xuống 21 mục chồng lấn, mất 45 mục
box rỗng; khôi phục bản cũ được.

**Chưa làm.** Ghi người sửa (dịch vụ chưa có đăng nhập riêng); dùng chung guideline với extension annotator (hiện annotator
vẫn nhập file Export ở ⚙ của extension).

### PP-24. Chữ "ĐẠT" khiến QC tưởng tool đã duyệt (26/10)

**Vấn đề.** Tool chỉ giảm việc lượt đầu, QC vẫn kiểm cả job. Gate ĐẠT / KHÔNG ĐẠT đọc như phán quyết, dễ làm QC lướt qua.

**Giải pháp.** Thay bằng mức ưu tiên xem (nhiều / ít vấn đề tự phát hiện); ghi ngay đầu trang phần tool không kiểm;
danh sách gọn, ít chữ, số đo trực quan để QC kiểm lại nhanh.

**Đã làm (26/10).** Trang job: ô **Mức ưu tiên** (cao / vừa / ít vấn đề) thay cho ĐẠT; dòng "Tool không kiểm: Sót vật · Sai
class · Camera / ảnh" ngay dưới; **dải frame** tô đậm nhạt theo số mục (bấm để lọc frame); **thanh theo luật** (bấm để lọc);
danh sách mỗi mục một dòng: object (cặp thì ghi cả hai), vấn đề + số đo, khoảng frame, ba nút ↗ mở CVAT / ✓ đúng / ✕ báo
nhầm; bấm dòng để xem chi tiết và link từng frame. Tiến độ duyệt hiện trên ô **Đã duyệt**. Sáng / tối, chạy được trên màn
hình hẹp.

---

## 5. Vấn đề của tool hiện tại cần sửa trước

| Nhóm | Vấn đề | Cách sửa |
|---|---|---|
| Dữ liệu | Backend chỉ đọc point cloud từ bản xuất nuScenes trên máy; dữ liệu thật trên CVAT thì các luật LiDAR bị bỏ qua | Annotator: **đã chuyển** sang tính trong extension. QC: đọc qua API CVAT trên server cạnh CVAT (chưa làm) |
| Extension | `sampleNearbyPoints` lấy mẫu cả point cloud xuống ~4000 điểm rồi mới lọc theo bán kính, nên quanh box còn rất ít điểm | **Đã sửa (0.4.0):** chỉ mục điểm theo ô nhìn từ trên, lấy toàn bộ điểm gần box |
| Extension | `sessionGroundZ` dùng mặt đất của box đầu cho mọi box; nút "Đất = Đáy" làm HUD luôn báo sát đất | **Đã sửa (0.4.0):** thay bằng bản đồ địa hình (PP-02) |
| Extension | `evaluateSpec` hardcode class nuScenes, mặc định `car`, nên `Pedestrian` bị chấm như ô tô | **Đã sửa (0.4.0):** khoảng kích thước đọc từ guideline (mặc định spec-vn + nuScenes, ghi đè ở Tùy chọn) |
| Extension | Lấy object `Points` đầu tiên trong scene; mỗi frame hình JSON.stringify 4 ma trận camera | **Đã sửa (0.4.0):** lấy object `isPoints` có mảng vị trí; overlay và panel chỉ vẽ lại khi dữ liệu đổi |
| Hiệu năng backend | Mỗi luật tự đọc lại PCD; `box_point_sets` tính hai lần; cache không giải phóng | Đọc một lần mỗi frame, tính một lần, dùng chung, giải phóng |
| Hiệu năng backend | Vòng lặp Python theo từng điểm (lưới min-Z, loang điểm, gom cụm); kiểm tra che khuất quét cả point cloud | Vector hóa numpy; range image (z-buffer) cho che khuất |
| Kiến trúc | Hai kiến trúc detector song song; ~500 dòng code sửa tự động v1 đã ngừng | Giữ một kiến trúc, xóa code chết |
| Portal | Không có người dùng/đăng nhập, một token CVAT chung, snapshot lưu toàn bộ nhãn ra đĩa | Không dùng portal trong luồng chính; chỉ giữ cho lead/admin sau khi bổ sung phân quyền |
| Bảo mật extension | Địa chỉ backend sửa được trong Tùy chọn; quyền host mở cho mọi địa chỉ | Khóa địa chỉ bằng managed storage, bỏ quyền host mở rộng, cài nội bộ qua chính sách |

---

## 6. Lộ trình demo

| Bước | Nội dung | Trạng thái |
|---|---|---|
| 0 | **Spike ghi box qua bộ nhớ CVAT:** sửa một keyframe, nhiều frame, xóa keyframe; kiểm hoàn tác. Thử tạo Issue qua API cho job 3D | **Xong phần ghi box** trên CVAT 2.75.1 (canvas vẽ lại, hoàn tác bằng nút riêng). Chưa thử Save rồi tải lại trang, chưa thử Issue |
| 1 | Sửa lỗi extension (mục 5) và thay thuật toán mặt đất (PP-02) | **Xong** trong extension |
| 2 | Tính năng không cần ghi: PP-03, PP-04, PP-06, PP-07, PP-09, PP-10 | **Xong** (PP-06 mới có cảnh báo trong frame) |
| 3 | Tính năng cần ghi: đồng bộ kích thước + tỉa keyframe (PP-01) | **Xong**, kèm làm mượt yaw và hạ đáy box |
| 4 | QC tối thiểu: độ phủ, mẫu issue, issue hiện ở annotator | Chưa làm |

**Dữ liệu demo.** Task nuScenes tạo bằng `to-cvat`, đặt keyframe ở mọi frame và chèn nhiễu kích thước/yaw/độ cao bằng `core/synthetic.py`, để mô phỏng đúng pre-label.

**Cách đo trước mặt mentor:**
1. Bấm giờ sửa cùng một track bằng tay và bằng tool, đếm số thao tác.
2. Số keyframe trước và sau khi tỉa, kèm sai số lớn nhất. Cần task có pre-label nhiễu: trên nhãn nuScenes gốc tỉa không bỏ được keyframe nào (PP-01).
3. Với thuật toán mặt đất: bias, p90, tỉ lệ thiếu bằng chứng trên box chuẩn nuScenes (đã có số cho bản mới ở mục 6.1; chưa so với thuật toán cũ của backend).

### 6.1. Kết quả đo trên CVAT thật

CVAT 2.75.1 local, task "PointSnap scene-0061" (39 frame, 219 track, nhãn chuẩn nuScenes, LiDAR 32 tia ~35k điểm mỗi
frame). Coi nhãn chuẩn là đúng, nên mọi cảnh báo trên đó là báo nhầm (hoặc chính nhãn chuẩn lệch).

| Hạng mục | Kết quả |
|---|---|
| Ghi box, đồng bộ 38 keyframe, hạ đáy box, hoàn tác | Đúng; canvas 4 view vẽ lại ngay; lịch sử Undo của CVAT không bị ghi đè |
| Overlay mặt đất / footprint | Nằm đúng trên box và point cloud ở cả 4 view (xác nhận điểm và box cùng hệ tọa độ) |
| Dựng bản đồ địa hình | 5–16 ms mỗi frame |
| Báo nhầm trên 840 box chuẩn (10 frame, mọi luật một-frame) | 14 Cảnh báo / Lỗi = **1,7 / 100 box**: 9 lơ lửng / lún (chủ yếu người đi bộ 20–45 m), 1 điểm dưới đáy box, 4 bề rộng xe buýt |
| Z ngoài ngưỡng / chồng lấn | Z: 0 báo nhầm (bản đầu: 55 Lỗi nhầm trên 210 box). Chồng lấn: từ 26/10 cứ chồng là Lỗi, xem PP-06 |
| Đo được mặt đất (độ tin cậy ≥ 0,3) | ~54% box trong 30 m; |ΔZ| trung vị 4 cm, p90 16 cm |
| Dải track trên 1395 keyframe chuẩn | Kích thước: 0 đánh dấu nhầm. Yaw: chỉnh ngưỡng theo dữ liệu (xe 15°, người 45°) |
| Làm mượt yaw trên nhãn chuẩn | Xe / rào chắn: đổi 1 keyframe (2°); người đi bộ: 25 keyframe nên đã tắt cho người / động vật |

### 6.2. Kết quả trên dữ liệu thứ hai: Argoverse 2

Để kiểm tool có áp dụng được ngoài nuScenes không: một log tập val của Argoverse 2 Sensor
(`02678d04-cc9f-3148-9f95-1ba66347dff9`, Pittsburgh, giấy phép CC BY-NC-SA 4.0). Dữ liệu gồm 40 sweep liên tiếp
10 Hz, LiDAR 2 × 32 tia (~91k điểm mỗi sweep), 48 track, 1515 box chuẩn, nạp vào CVAT local thành task 51 / job 72.
AV2 có **bản đồ độ cao mặt đất thật**, nên đo được sai số của thuật toán mặt đất mà không phụ thuộc nhãn.

| Hạng mục | nuScenes (32 tia, 2 Hz) | **Argoverse 2 (64 tia, 10 Hz)** |
|---|---|---|
| Đo được mặt đất trong 30 m | ~54% | **88%** (28/32) |
| Sai số mặt đất so với bản đồ thật, box trong 50 m | — (không có bản đồ) | p50 3–8 cm, p90 ≤ 10 cm, lớn nhất 17 cm |
| Sai số mặt đất, box 50–75 m | — | lớn nhất 1,37 m: lý do đặt `ground.maxRangeM = 50` |
| Báo nhầm lơ lửng / lún (sau khi đặt 50 m) | 9 / 840 box | **0** / 417 box |
| Báo nhầm trong 50 m (mọi luật) | 1,7 / 100 box | **2 / 83 box**: hai xe 46–48 m không có điểm LiDAR nào (`fit.empty`), đúng theo spec 4.2 |
| Báo trên toàn bộ box (tới 200 m) | — | 12,9 / 100, gần hết ở > 80 m: AV2 gán cả vật xa 100–200 m có 0–2 điểm, kích thước bất thường. Dự án đặt `maxDistanceM` theo spec thì các box này nằm ngoài phạm vi |
| Dải track trên 1508 keyframe chuẩn | 0 đánh dấu nhầm kích thước | **0** kích thước, **0** yaw |
| Làm mượt yaw / đồng bộ kích thước trên nhãn chuẩn | 1 keyframe đổi (xe) | **0** keyframe đổi |
| Tỉa keyframe trên nhãn chuẩn | 0 keyframe | **bỏ 32%** (giữ 1027/1508), sai lệch tâm ≤ 5 cm |
| Dựng bản đồ địa hình | 5–16 ms | 41–92 ms (frame đầu 214 ms) |
| Dựng chỉ mục + bản đồ địa hình (Node, đo lại 25/10) | — | p50 31 ms, lớn nhất 76 ms; nhân 3 số điểm (~270k, cỡ LiDAR 128 tia): lớn nhất 92 ms |
| Đo một box (tiếp đất + điểm của vật + mặt bị che + luật) | — | p50 0,1 ms, lớn nhất 8 ms; 1515 box, 0 lỗi, 0 kết quả NaN |

**Mô phỏng pre-label nhiễu** trên 26 track xe (1018 keyframe), chỉ tính trong bộ nhớ, không ghi vào CVAT:
- 25% keyframe bị sai kích thước 8–15%, mô phỏng detector canh theo mặt nhìn thấy.
- Mỗi track có 1 keyframe bị lật đúng 180°.

| Thao tác | Kết quả |
|---|---|
| Dải track bắt keyframe sai kích thước | **249/256** (97%), 0 báo nhầm |
| Đồng bộ kích thước theo trung vị | Sai số chiều dài từ p90 50 cm / lớn nhất 96 cm về **0** (vì mô phỏng cùng giả định "giữ mặt nhìn thấy" với thuật toán; pre-label thật sẽ kém hơn) |
| Làm mượt yaw sửa keyframe lật | **26/26**, 0 keyframe bị sửa nhầm |
| Dải track đánh dấu keyframe lật | Bản đầu chỉ **2/26**: unwrap qua chỗ lật đúng 180° biến nó thành bước lệch 360° kéo tới cuối track. Đã sửa bằng so góc trực tiếp với hướng trung bình tròn của lân cận → **26/26**; thuật toán hiện tại xem PP-04 |

**Thay đổi rút ra từ AV2:** giới hạn luật lơ lửng / lún và nút hạ đáy box trong 50 m (`ground.maxRangeM`); đổi cách
đánh dấu yaw trên dải track (PP-04).

Mục tiêu cũ của dự án là ≤ 2 Cảnh báo và ≤ 0,5 Lỗi trên 100 box; con số 1,7 ở trên gộp cả Cảnh báo và Lỗi, đo trên
một cảnh. Phím tắt thật, Save rồi tải lại: đã kiểm ở mục 6.3.

### 6.3. Dùng thật trên dữ liệu chọn ngẫu nhiên (25/10/2026)

Mục đích: dùng extension như annotator trên dữ liệu chưa từng dùng để chỉnh, xem có áp dụng được không. Ba task mới trên
CVAT local, nạp qua phiên đăng nhập của trình duyệt (dữ liệu không ra khỏi máy):

| Task | Dữ liệu | Vì sao chọn |
|---|---|---|
| 52 / job 73 | KITTI 000008 + **13 hộp pre-label thật của PointPillars** (lượt B, bài Day 13) | Pre-label do model sinh, có lỗi thật, không phải nhãn chuẩn |
| 53 / job 74 | nuScenes **scene-1077** (đêm, đường lớn, tốc độ cao), 67 track | Bốc ngẫu nhiên (seed 20261025) trong 9 cảnh chưa dùng |
| 54 / job 75 | nuScenes **scene-1100** (đêm, nhiều người đi bộ, xe tay ga, PMD), 32 track | Như trên |

**Kết quả trên pre-label PointPillars (KITTI):**
- Bắt đúng xe bị model cắt ngắn (dài 3,14 m, *Kích thước ngoài ngưỡng*) và cặp hộp xe + xe hai bánh chồng lên nhau.
- Hộp đặt trên nền cao hơn mặt đường ~0,45 m (vỉa hè cao / nền dốc): mặt đất đo ra khoảng [0,37; 0,78] m, không báo
  lơ lửng / lún nhầm.
- Hai hộp dưới tán cây có 373 và 96 điểm đỏ: phần lớn là tán cây / vật bên cạnh nối liền với xe, không phải xe lòi ra.
  Đã thử dừng loang trên nóc box và bỏ điểm trên nóc: không giảm trên cả 3 bộ dữ liệu nên **không đổi**. Annotator cần
  biết điểm đỏ dưới tán cây là gợi ý, không phải kết luận. Không có luật nào tự báo lỗi từ điểm đỏ.
- Hộp cách LiDAR 4,6 m và người đi bộ 18,7 m không đo được mặt đất: point cloud KITTI demo chỉ có vùng trước camera.

**Báo nhầm trên nhãn chuẩn, đi qua từng frame như annotator (chọn từng box, đọc panel):**

| Cảnh | Box | Trước | Sau khi chỉnh | Còn lại |
|---|---|---|---|---|
| scene-1100 | 248 | 45 (18%): 41 *Kích thước ngoài ngưỡng* ở 4 track (xe tay ga 1,27 m, người rộng 0,41 m) | **4 (1,6%)** | 1 người chuẩn lơ lửng thật ~15 cm (điểm LiDAR dưới chân thấp hơn đáy box 10–17 cm); 2 vật 28 m chỉ 6 điểm; 1 xe 0 điểm (*Box rỗng*, đúng spec) |
| scene-1077 | 141 | — | **1 (0,7%)** | 1 xe 0 điểm ở 30 m |
| Dải track, 99 track / 1487 keyframe | | 10 đánh dấu yaw nhầm (xe rẽ gắt) | 0 kích thước | xem PP-04 |

**Thao tác ghi, đo trên scene-1100 (CVAT 2.75.1):**
- Annotator kéo dài một keyframe 30 cm → panel báo ngay *Scale không đồng bộ, lệch 30 cm so với trung vị track*.
- **Cỡ = frame này**: 39 keyframe về 5,04 m, mặt LiDAR thấy giữ nguyên (tâm dời tối đa 15 cm = nửa 30 cm).
- **Tỉa keyframe**: giữ 14/40 keyframe, vị trí nội suy lệch tối đa 4,5 cm (dung sai 5 cm).
- **Save bằng Ctrl+S thật, tải lại trang**: 40/40 frame khớp với trước khi Save (lệch lớn nhất 0,05 mm), 14 keyframe.
- **Phím thật**: Alt+Shift+F bật camera theo track, phím F của CVAT qua frame vẫn giữ track; Alt+Shift+G hạ box nâng
  30 cm về cách nhãn chuẩn 3 cm (bản dời ít nhất: 7 cm).
- **Khoá box (26/10/2026, job 75, xe thu đang chạy)**:
  - car #8 từ frame 0 tới 12 và khi bấm ô keyframe 7 / 13 / 1: tâm box đứng yên trên màn hình, lệch ≤ 1 px.
  - Tắt khoá: tới frame 10, box ra ngoài màn hình hơn 1500 px.
  - Box ra khỏi track ở frame 15: báo "không có mặt"; về frame 9 thì chọn lại đúng box, vẫn ở vị trí cũ.
- **Bỏ qua cảnh báo**: pedestrian #30 "27 điểm đỏ lòi ra ngoài box" → ✕: dòng xám, số mục cần xem về 0, chấm xanh, sang frame 5 cùng track vẫn đã bỏ qua; ↺ hiện lại.

**Đo thêm trên dữ liệu thật:**
- Box chuẩn nuScenes scene-1077 dư so với điểm ở mặt LiDAR thấy: p50 19 cm, p90 33 cm (scene-1100: 10 / 25 cm). Vì vậy co
  box 15% ở cảnh này nhiều khi vẫn chứa hết điểm, không lòi ra (tool đúng). Có thể do point cloud méo khi xe thu chạy
  nhanh (chưa kiểm). Nhãn "dư" chỉ tô cam khi > 30 cm.
- Tốc độ trên 40 frame AV2 (1515 box): dựng chỉ mục + mặt đất mỗi lần đổi frame p50 31 ms, lớn nhất 76 ms; nhân 3 số
  điểm (~270k, cỡ LiDAR 128 tia) lớn nhất 92 ms; đo một box lớn nhất 8 ms; 0 lỗi, 0 kết quả NaN.

**Thay đổi rút ra:** nới khoảng kích thước (PP-07), viết lại luật yaw của dải track (PP-04), hạ đáy đặt giữa khoảng mặt
đất (PP-02). Kèm các lỗi sửa khi kiểm edge case: point cloud có NaN / Infinity, guideline ghi đè sai kiểu, box bị khóa
trong CVAT, đổi job trong cùng tab, keyframe ngoài đoạn của job.

Sửa thêm sau khi dùng thật: phóng to một view (nút fullscreen của CVAT) thì đường mặt đất / nhãn của 3 view kia không còn
vẽ đè lên view đang phóng to. CVAT chỉ đặt view phóng to đè lên, 3 view kia vẫn giữ chỗ cũ bên dưới; lớp vẽ giờ thử
xem view có bị che không trước khi vẽ.

**Chưa kiểm:** độ mượt khi kéo chuột ở frame đông điểm (khung trình duyệt thử quá hẹp); dữ liệu Việt Nam.

---

### 6.4. Kiểm tới 80 m: bước 0–1 (28/10/2026)

Kế hoạch dài hạn: dựng lại cảnh 4D của cả job (tư thế xe, bản đồ tĩnh, mặt đất có sai số, mô hình từng vật gộp nhiều
frame) rồi mọi luật so nhãn với cảnh đó. Bước 0–1 đo nền và đo phần quyết định là tư thế xe. Code đo ở `extension/bench/`
(không nạp vào extension, chạy bằng Node trên dữ liệu công khai trên máy).

**Bước 0: luật hiện tại theo khoảng cách** (`bench/rules-bench.js`; nuScenes mini 10 cảnh, keyframe 2 Hz, bỏ box không có
điểm LiDAR như bộ đánh giá nuScenes; Argoverse 2 một log 40 frame). Lỗi cài từng cái vào box nhãn chuẩn.

| | nuScenes 0–30 m | 30–50 m | 50–80 m | AV2 0–30 m | 30–50 m | 50–80 m |
|---|---|---|---|---|---|---|
| Box | 9 098 | 3 610 | 1 422 | 151 | 139 | 321 |
| Đo được mặt đất | 62% | 9% | 0% | 93% | 52% | 0% |
| Bắt nâng / hạ 30 cm | 43% / 35% | 7% / 4% | 0 | 83% / 82% | 35% / 41% | 0 |
| Bắt nâng / hạ 50 cm | 58% / 58% | 8% / 7% | 0 | 94% / 93% | 50% / 50% | 0 |
| Bắt lật hướng 180° (một keyframe) | 100% | 100% | 100% | 100% | 100% | 100% |
| Báo nhầm lơ lửng / lún | 3,1% | 3,0% | 0 | 0 | 1,4% | 0 |
| Báo nhầm chồng lấn | 7,4% | 5,8% | 1,8% | 43,7% | 10,1% | 0 |

Luật mặt đất mất tác dụng từ 30 m (nuScenes, LiDAR 32 tia) hoặc 50 m (giới hạn `ground.maxRangeM`); hướng không phụ
thuộc khoảng cách. Báo nhầm chồng lấn cao do quy ước "cứ chồng là Lỗi" (rào nối nhau, người – xe lăn ở AV2).

**Bước 1: tự khớp tư thế xe 6 bậc từ point cloud** (`bench/odometry.js`: ICP điểm – mặt phẳng, bỏ điểm trong box đã
gán, giữ mặt đất; `bench/pose-bench.js`). Phép đo chính: điểm mặt đất ngay dưới xe ở frame sau đổi về frame trước (cách
hướng 3 "mặt đất xe sắp đi qua" sẽ dùng), so với pose thật. nuScenes ghi z của xe luôn bằng 0 nên chỉ AV2 đo được độ cao.

| | Một cặp frame | 0–20 m | 20–40 m | 40–60 m | 60–80 m |
|---|---|---|---|---|---|
| AV2 nối chuỗi: lệch độ cao p50 / p90 | 0,4 / 1,7 cm | 2,0 / 5,5 cm | 11 / 23 cm | 27 cm (1 cặp) | chưa có dữ liệu |
| AV2 khớp thẳng frame xa vào frame gốc | | 1,3 / 2,9 cm | 4,1 / 8,6 cm | 11 cm (1 cặp) | chưa có dữ liệu |
| nuScenes khớp thẳng: cặp hỏng | 6 / 394 cặp liền nhau | 16 / 408 | 52 / 159 | 69 / 112 | 61 / 68 |
| nuScenes khớp thẳng: sai pitch p50 / p90 | 0,04° / 0,17° | 0,06° / 0,70° | 0,14° / 0,97° | 0,49° / 0,96° | 0,59° / 3,6° |

Kết luận bước 1:
- Khớp từng cặp đủ tốt (AV2: cm và 0,04°). Nối chuỗi thì độ cao trôi (AV2 20–40 m: p90 23 cm); khớp thẳng frame xa vào
  frame gốc giảm còn p90 8,6 cm.
- **Chưa đạt mục tiêu ≤ 5–10 cm ở 80 m.** AV2 trên máy chỉ có 41 m đường; nuScenes (2 Hz, 32 tia) khớp thẳng hỏng gần
  hết từ 60 m vì hai frame cách xa chồng lấn quá ít, và 1,5% cặp liền nhau khớp hỏng làm hỏng mọi chuỗi đi qua.
- So keyframe 2 Hz với sweep 20 Hz của nuScenes (cảnh 0796, 0916, 1077): cặp liền nhau hỏng 5 / 119 → 0 / 1 188, sai một
  cặp 3,3 → 1,2 cm và pitch 0,07° → 0,04° (p50). Nhưng nối chuỗi 20 Hz trôi nhiều hơn (lệch ngang p50 ở 40–60 m: 22 →
  88 cm): gấp 10 lần số bước, mỗi bước lệch nhỏ cùng chiều (sweep nuScenes chưa bù chuyển động trong lúc quét). Khớp
  thẳng hai frame cách 60–80 m vẫn hỏng gần hết ở cả hai tần số. Vậy cặp hỏng là do frame thưa (cần tìm thô quanh dự
  đoán, vì CVAT thường chỉ có keyframe), còn trôi phải xử lý bằng đồ thị tư thế, không phải tăng tần số.
- Việc tiếp trước khi sang bước 2: (1) phát hiện và khớp lại cặp hỏng (tìm thô quanh dự đoán); (2) đồ thị tư thế: mỗi
  frame khớp với nhiều frame trong tầm chồng lấn rồi tối ưu cả chuỗi, thay vì nối chuỗi hoặc khớp thẳng đơn lẻ; (3) neo
  mặt đất dưới xe (độ cao lắp cảm biến cố định); (4) dữ liệu đo có pose 6 bậc và quãng đường ≥ 80 m (thêm log AV2).

### 6.5. Lơ lửng / lún tới 80 m không cần tư thế xe cả chuỗi: thử A, B, C (28/10/2026)

Tư thế xe cả chuỗi khó tự khớp với dữ liệu keyframe thưa (mục 6.4), nên thử ba cách chỉ cần frame đang xét hoặc vài
frame liền kề (`extension/bench/far-ground-bench.js`). Cài lỗi nâng / hạ đáy 30 và 50 cm từng box nhãn chuẩn; chỉ tính
là bắt khi báo đúng chiều; ngưỡng 20 cm như luật hiện tại.
- **A, theo chính vật:** đáy box ≥ điểm cao nhất của vật − chiều cao track, và ≤ điểm thấp nhất trong footprint.
- **B, mặt đường quanh box:** mặt phẳng bền qua điểm thấp nhất mỗi ô 1 m và đáy các box lân cận, bán kính
  max(5 m, 0,15 × khoảng cách); chỉ kết luận khi khớp tốt (độ lệch ≤ 15 cm, có điểm ở ≥ 2 góc phần tư).
- **C, gộp ±2 frame:** khớp từng cặp frame liền nhau (ICP 6 bậc tự khớp, không dùng pose thật), gộp điểm ngoài box vào
  frame đang xét, chạy luật hiện tại tầm 80 m.

| Bắt ±50 cm / báo nhầm | nuScenes 0–30 m | 30–50 m | 50–80 m | AV2 0–30 m | 30–50 m | 50–80 m |
|---|---|---|---|---|---|---|
| Hiện tại (tầm 50 m) | 58% / 3,1% | 7–8% / 3,0% | 0 | 93–94% / 0 | 50% / 1,4% | 0 |
| Hiện tại nới tầm 80 m | như trên | như trên | 0,5% / 0,4% | như trên | như trên | 22–26% / 4,7% |
| A: theo chính vật | 47–64% / 8,3% | 7–15% / 3,4% | 2–3% / 1,9% | 33–51% / 0 | 35–43% / 0 | 27–34% / 1,2% |
| B: mặt đường quanh box | 81–83% / 4,8% | 33–40% / 12,1% | 9–17% / 10,7% | 99–100% / 0 | 68–88% / 10,8% | 44–66% / 20,9% |
| C: gộp ±2 frame | 70% / 3,5% | 20–23% / 7,1% | 1,5–1,8% / 1,8% | 100% / 0 | 71–77% / 5,8% | 37–43% / 9,0% |

Kết luận:
- **Mật độ LiDAR quyết định.** Với 32 tia, 2 Hz (nuScenes) không cách nào kiểm được 50–80 m: cách tốt nhất (B) bắt
  9–17% mà báo nhầm 11%. Với 64 tia, 10 Hz (AV2) thì cả bốn cách đều có tác dụng ở 50–80 m.
- **A ít báo nhầm nhất ở xa** (AV2 1,2%, nuScenes 1,9% ở 50–80 m) nhưng báo nhầm 8,3% ở gần trên nuScenes (đất dốc dưới
  mép box làm điểm thấp nhất thấp hơn đáy): chỉ hợp dùng ngoài tầm luật hiện tại.
- **C cải thiện gần như không tốn báo nhầm ở 0–50 m** (nuScenes 0–30 m: 58 → 70%, báo nhầm 3,1 → 3,5%; AV2 30–50 m:
  50 → 74%). Cần đọc point cloud frame kề và khớp từng cặp: hợp với QC (đọc mọi frame), extension tải thêm frame thì chậm
  trên CVAT công ty.
- **B bắt nhiều nhưng báo nhầm 11–21% ở xa:** chưa dùng được; số đo còn lạc quan vì đáy box lân cận là nhãn chuẩn.
- Chiều cao track (A) và đáy box lân cận (B) lấy từ nhãn chuẩn: trên dữ liệu thật, các giá trị này cũng có thể sai.
- Cần biết LiDAR của dữ liệu công ty (số tia, tần số frame) để chọn cách.

## 7. Rủi ro và câu hỏi mở

| Rủi ro / câu hỏi | Ảnh hưởng |
|---|---|
| ~~Canvas 3D của CVAT không vẽ lại được sau khi plugin ghi box~~ | **Đã giải quyết:** vẽ lại đúng trên CVAT 2.75.1 |
| ~~Undo của CVAT tách thao tác hàng loạt thành nhiều bước~~ | **Đã giải quyết:** CVAT cũ dùng nút Hoàn tác của PointSnap; còn lại rủi ro người dùng quen tay bấm Ctrl+Z, sẽ hoàn tác thao tác trước đó của chính họ chứ không phải thao tác của PointSnap |
| CVAT nâng phiên bản đổi cấu trúc store/canvas | Gom phần bám nội bộ CVAT vào một file (`cvat-adapter.js`); cần thử lại mỗi lần nâng CVAT |
| ~~Tọa độ điểm trong scene three.js có cùng hệ với box không~~ | **Đã xác nhận** cùng hệ (đối chiếu mã nguồn canvas3d và overlay trên CVAT thật) |
| LiDAR thưa: ~54% box trong 30 m đo được mặt đất trên nuScenes 32 tia, 88% trên Argoverse 2 64 tia | Box xa chỉ nhận "không đủ điểm mặt đất"; ngoài 50 m không đánh giá cao độ. Cần đo lại trên LiDAR của dự án |
| Mới thử trên 2 cảnh (Singapore, Pittsburgh) | Ngưỡng đã chỉnh theo 2 cảnh này; dữ liệu VN (xe máy dày đặc, đường hẹp) có thể cần chỉnh tiếp |
| Chỉ có point cloud của frame đang mở | Không so được ΔZ với các frame khác của track trong extension; hạ đáy box chỉ áp cho frame đang mở |
| Service chạy cạnh CVAT có được coi là "không rời CVAT" không | Nếu không, tầng scan chuyên sâu chỉ còn những gì chạy được trong trình duyệt |
| Khoảng kích thước, ngưỡng và tần số dữ liệu thật khác nuScenes | Phải chỉnh lại trên dữ liệu VN; demo chỉ chứng minh cơ chế |
| Phạm vi gán nhãn tối đa theo spec | Cần để chốt PP-10 |
| Số liệu thật: giờ công từng khâu, top 5 lỗi bị trả về, tỉ lệ thời gian sửa pre-label | Quyết định ưu tiên annotator hay QC có đúng không |

---

*Tài liệu tham khảo cho thuật toán mặt đất: GroundGrid (Steinke và cộng sự, RA-L 2024, arXiv 2405.15664); Patchwork++
(Lee và cộng sự, 2022, arXiv 2207.11919). Khớp hình chữ L: Zhang và cộng sự, 2017 (tiêu chí closeness).*
