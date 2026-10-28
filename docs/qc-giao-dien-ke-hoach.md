# Giao diện QC: vì sao rối và hướng phát triển (28/10/2026)

Tài liệu này xem lại web QC (`qc/public/app.js`, `tickets.js`, `plugin.js`) và thiết kế Figma "Duyệt Job · Quét lỗi tự động",
"Mọi Object & Tiến độ". Code hiện tại làm gần đúng Figma, nên chỗ rối nằm ở **cách chia luồng làm việc**, không phải ở chi tiết
giao diện. Chưa xem bản đang chạy với dữ liệu thật, chưa phỏng vấn QC: các nhận xét dưới đây suy từ code, thiết kế và báo cáo
[thử nghiệm 2 vòng](qc-thu-nghiem-2-vong.md).

## 1. Việc thật của QC

QC phải xem **100% object** của job. Mỗi object chỉ cần một kết luận: **Đạt** hoặc **Trả lỗi** (kèm lý do). Tool chỉ xếp thứ tự xem
và chỉ chỗ nghi ngờ. Sau đó là vòng: gửi lỗi → annotator sửa → nghiệm thu → quét lại → hoàn thành.

Mọi thứ trên màn hình nên phục vụ đúng câu hỏi: **"object tiếp theo là gì, nó có gì đáng ngờ, Đạt hay Trả lỗi?"**

## 2. Vì sao đang rối

| # | Vấn đề | Chỗ trong code / thiết kế |
|---|---|---|
| 1 | **Hai màn cho cùng một việc.** "Duyệt Job" xoay quanh *mục tool báo*, "Mọi Object" xoay quanh *object*. QC phải chạy qua lại. | `renderReview()`, `renderObjects()` |
| 2 | **Hai loại kết luận song song.** Mục tool báo có Đúng / Báo nhầm, object có OK / Trả lỗi. Màn Duyệt Job có tới 3 tiến độ: "Đã xác minh 16/16", "42/67 object", và mức ưu tiên. QC dễ tưởng 16/16 là xong. | `findingsHtml()`, ô "Đã xác minh mục tool báo" |
| 3 | **Phải kéo qua cả một dashboard mới tới việc chính.** Trên danh sách lỗi có 4 ô số, 1 dòng ghi chú, heatmap, phân bố quy tắc, phạm vi kiểm tra. Tất cả hữu ích để *hiểu job*, nhưng chắn đường khi *duyệt*. | `renderReview()` dòng 367–375 |
| 4 | **Bảng quá dày.** Bảng object 8 cột, 7 tab lọc, tới 5 nút lớn ở khối tiến độ (Xem tiếp, Hoàn thành, Gửi lỗi, Quét lại, Duyệt lại), cộng banner "vật đứng yên". Mỗi dòng mục lỗi có 4 thao tác. | `renderObjects()`, `objectRows()` |
| 5 | **Chế độ làm việc chính bị giấu.** "Xem tiếp" (đi lần lượt từng object, phím 1/2/3/J/K) là cách duyệt nhanh nhất, nhưng chỉ là thanh nổi ở tab thứ hai. | `walkHtml()` |
| 6 | **Nhảy cửa sổ liên tục.** Mọi lần xem box đều là "Mở CVAT ↗" sang tab khác. Bảng nổi (PiP) chỉ có trên Chrome và chỉ trong Xem tiếp. | `cvatLink()`, `openFloat()` |
| 7 | **Vòng sửa lỗi nhiều trạng thái mà không có bản đồ.** OK, Trả lỗi (chưa gửi), Trả lỗi (đã gửi), Bị sửa sau duyệt, Đã nghiệm thu chờ quét lại. QC phải tự nhớ bước tiếp theo. | `objState()`, các nút ở `renderObjects()` |
| 8 | **Chỗ trống bị lãng phí.** Khối "Phiên kiểm duyệt" ở cột trái là chữ cố định. | `renderSession()` |
| 9 | **Thiếu cách ghi "thiếu vật".** Thử nghiệm: còn thiếu 3 vật mà job vẫn hoàn thành được, vì lỗi phải gắn với một object có sẵn. | [thử nghiệm §5.4](qc-thu-nghiem-2-vong.md) |

## 3. Hướng đi: một hàng đợi, một quyết định cho mỗi object

1. **Đơn vị duyệt là object.** Mục tool báo trở thành *bằng chứng nằm trong object*, không còn là danh sách riêng phải xác minh.
   "Báo nhầm" là một nút trên từng bằng chứng, chỉ để đo độ chính xác của luật (PP-18), không tính vào tiến độ.
2. **Một con số tiến độ:** `object đã duyệt / tổng object`. Mức ưu tiên và số lỗi chỉ là thông tin phụ.
3. **Chế độ duyệt là mặc định.** Mở job là vào ngay object cần xem tiếp; danh sách là phần phụ để nhảy tới.
4. **Phân tích tách khỏi duyệt.** Heatmap, phân bố quy tắc, phạm vi kiểm tra chuyển vào một tab hoặc khối gập "Tổng quan job".
5. **Bước tiếp theo luôn hiện.** Một thanh tiến trình theo bước: Quét → Duyệt → Gửi lỗi → Chờ sửa → Nghiệm thu → Hoàn thành.
   Chỉ nút của bước hiện tại là nút chính.
6. **Làm ngay trong CVAT khi có thể.** `plugin.js` đã có hàng đợi QC chạy trong CVAT; đưa nó thành nơi làm việc chính, còn web QC
   dùng để xem tổng quan và quản lý phiếu.

### Bố cục đề xuất cho màn "Duyệt job"

```
┌ Job #69 · scene-0061 ───────────── [Quét ✓]─[Duyệt 42/67]─[Gửi lỗi]─[Nghiệm thu]─[Hoàn thành] ┐
├──────────────── Hàng đợi ────────────────┬──────────── Object đang xem ───────────────────────┤
│ Tìm…   [Cần xem 25] [Đã duyệt 42] [Lỗi 5] │ car #129 · frame 10–18 · 9 box                     │
│ ● car #129      1 lỗi      10–18        ◀ │ Tool nghi ngờ:                                     │
│ ● truck #104    1 lỗi      0–39           │  ● Mặt đất lơ lửng +32 cm · frame 10–18  [Báo nhầm] │
│ ○ ped #208      thiếu đất  12–27          │    (point cloud / số đo kèm theo)                  │
│ ○ barrier #156  đứng yên   0–39           │ Dữ liệu: đủ điểm đất · cách xe 18 m                │
│ …                                         │                                                    │
│                                           │ [1] Đạt   [2] Trả lỗi…   [J] Tiếp  [K] Lùi  CVAT ↗  │
└───────────────────────────────────────────┴────────────────────────────────────────────────────┘
  ▸ Tổng quan job (heatmap · quy tắc · phạm vi kiểm tra)       ← gập mặc định
```

## 4. Lộ trình

Mỗi giai đoạn tự dùng được và không phá dữ liệu đã lưu: `reviews`, `objectReviews` và phiếu đều giữ nguyên định dạng.

### Giai đoạn 1: dọn gọn, không đổi luồng (2–3 ngày)

**Đã làm (28/10/2026).** Khác so với dự kiến:
- Nút phụ của khối tiến độ để thành hàng nút nhỏ dưới nút chính, không giấu vào menu "⋯".
- Bảng giữ 5 tab (thêm "Tất cả"). "Chưa kiểm được" và "Đứng yên chưa xem" thành bộ lọc phụ.
- "Trả lỗi" trên một mục tool báo tự ghi mục đó là "Lỗi thật". Bỏ nút ✓ "Đúng" riêng.
- Kết luận cho mục tool báo đổi tên thành "Lỗi thật / Báo nhầm", để không lẫn với "Đạt" của object.

Chưa bấm giờ trước / sau (§5).

- Gộp 4 ô số + dòng ghi chú thành **một dải tóm tắt** gồm tiến độ object, số lỗi / cảnh báo, mức ưu tiên.
- Bỏ ô "Đã xác minh mục tool báo" khỏi vị trí chính; giữ số đó trong khối phân tích.
- Gập heatmap / phân bố quy tắc / phạm vi kiểm tra vào khối "Tổng quan job", nhớ trạng thái gập theo người dùng.
- Bảng object: bớt từ 8 xuống 6 cột (gộp "Xa / thiếu điểm đất" vào cột vấn đề; gộp người duyệt vào cột trạng thái, hiện khi rê chuột),
  và từ 7 xuống 4 tab (Cần xem · Có vấn đề · Đã duyệt · Bị sửa sau duyệt). "Chưa kiểm được" và "Đứng yên" thành bộ lọc.
- Khối tiến độ: một nút chính theo bước hiện tại; các nút khác vào menu "⋯".
- Thay khối "Phiên kiểm duyệt" bằng thông tin có ích (guideline đang dùng, lần quét cuối, phiếu đang mở).
- Thống nhất từ ngữ: "Đạt / Trả lỗi" ở mọi nơi (hiện lẫn "OK", "Đúng", "Giao lỗi", "Trả lỗi").

### Giai đoạn 2: một màn duyệt theo object (1–1,5 tuần)

**Đã làm (28/10/2026).** Tab QC giờ là: Duyệt job · Tổng quan · Giao việc Lỗi · Guideline.
- **Duyệt job:**
  - Hàng đợi bên trái, xếp theo lỗi → cảnh báo → tool chưa kiểm → còn lại, có tìm, lọc class, tab và bộ lọc phụ.
  - Bên phải là object đang xem: mục tool báo (mở ra để xem chi tiết, link frame, point cloud chỗ nối), lưu ý dữ liệu, lỗi đã ghi.
  - Thanh phím 1 Đạt · 2 Trả lỗi · 3 Đạt + báo nhầm · K Lùi · J Bỏ qua luôn bật. Bỏ thanh "Xem tiếp" nổi.
- **Tổng quan:** dải số, heatmap, quy tắc, phạm vi, danh sách mục tool báo, bảng mọi object (bấm tên object để sang duyệt).
- **Thanh bước** Quét → Duyệt → Gửi lỗi → Chờ sửa → Quét lại → Hoàn thành ở cả hai màn, với một nút chính cho bước hiện tại.
- Form trả lỗi đã có sẵn nhãn một chạm; thêm Ctrl+Enter để lưu.

Chưa làm: tự điền điều khoản spec vào lỗi; tự chọn nhãn theo luật khi object có nhiều mục tool báo.

- Màn mới theo bố cục ở §3: hàng đợi bên trái, chi tiết object bên phải, phím tắt luôn bật (không cần "Bắt đầu Xem tiếp").
- Mục tool báo hiện trong chi tiết object, kèm bằng chứng (số đo, point cloud chỗ nối đã có ở `evidenceHtml()`).
- Hộp "Trả lỗi" một chạm theo mẫu (lơ lửng, sai kích thước, sai hướng, sai class, sai ID, khác), tự điền frame và luật (PP-16).
- Thanh bước Quét → … → Hoàn thành thay cho các nút rời.
- "Duyệt Job" và "Mọi Object" gộp thành một tab; tab "Tổng quan" giữ phần phân tích.

### Giai đoạn 3: duyệt trong CVAT và bịt lỗ hổng (2 tuần)

**Đã làm (28/10/2026):**
- **Phiếu thiếu vật**
  - Nút "+ Thiếu vật" (phím N) trên thanh bước, và "+ Thiếu vật ở frame này" trong bảng CVAT.
  - Phiếu ghi class, frame, vị trí, ghi chú và gửi annotator ngay (`POST /api/tickets/missing`).
  - Job không hoàn thành được khi còn phiếu này. Nộp / nghiệm thu không đọc object trên CVAT.
- **Duyệt lại (PP-17)**
  - Quét lại thì giữ lần quét trước (`job-N-prev`).
  - Object khác lần trước có khối "So với lần quét trước" (khoảng frame, số box, mục tool hết báo / báo mới) và bộ lọc "Đổi so với lần quét trước".
- **Kết luận ổn định (PP-18)**
  - Khoá mục tool báo đã là `object|luật` nên kết luận vẫn giữ qua quét lại.
  - Thêm: mục đã ghi Báo nhầm không còn đẩy object lên đầu hàng đợi (web và bảng CVAT).
  - Mỗi luật ở Tổng quan hiện "x lỗi thật · y báo nhầm · đúng z%".
- **Bảng CVAT:** cùng cách xếp hàng đợi với web, hiện và nhảy tới được phiếu thiếu vật.

Chưa làm: gợi ý cụm điểm LiDAR không nằm trong box nào; so sánh box từng frame (mới so ở mức object).

- Đưa hàng đợi + nút Đạt / Trả lỗi của `plugin.js` thành cách làm chính: QC đứng trong CVAT, tool tự nhảy tới object và frame
  (`goTo()` đã có). Web QC chỉ để xem tổng quan và quản lý phiếu.
- **Phiếu "thiếu vật"** theo frame + vị trí, không gắn object; job không hoàn thành được khi còn phiếu thiếu vật mở.
- **Duyệt lại (PP-17):** vòng 2 chỉ hiện object bị sửa và phiếu cũ, kèm so sánh trước / sau.
- **Kết luận ổn định (PP-18):** "Báo nhầm" gắn với (job, track, luật) để quét lại không hiện lại.

## 5. Đo để biết có tốt hơn không

Trước khi làm giai đoạn 1, bấm giờ với 1–2 QC trên cùng một job (vd job #69, 67 object):

| Chỉ số | Cách đo |
|---|---|
| Thời gian trung bình mỗi object | Từ lúc mở object tới lúc chọn Đạt / Trả lỗi |
| Số lần bấm và số lần đổi cửa sổ mỗi object | Ghi lại trong lúc làm, hoặc thêm log phía client |
| Số lần QC hỏi "giờ làm gì tiếp" hoặc bấm nhầm | Quan sát |
| Lỗi cài sẵn bị sót | So với bộ 36 lỗi cài của lần thử 2 vòng |

Làm lại cùng phép đo sau mỗi giai đoạn.

## 6. Việc cần chốt trước khi làm

1. **Gộp hai màn thành một** (giai đoạn 2), hay giữ hai màn và chỉ dọn gọn?
2. **Nơi làm việc chính** là web QC hay bảng trong CVAT (giai đoạn 3)? Điều này quyết định nên đầu tư giao diện ở đâu.
3. **Cần cả bản Light và Dark** cho màn mới không? Figma hiện có cả hai cho các màn cũ.
4. Vẽ màn mới trong Figma trước (khuyến nghị: cùng file "PointSnap 3D — Landing Page", dùng biến `PointSnap Color`) rồi mới code.
