# Thử nghiệm QC ↔ annotator 2 vòng trên CVAT (28/10/2026)

Mục đích: đo trên dữ liệu thật xem tool QC bắt lỗi đúng tới đâu, báo nhầm bao nhiêu, và vòng trả lỗi / sửa / nghiệm thu
chạy ra sao. Mọi con số dưới đây đo từ lần chạy này; chỗ nào là giả định thì ghi rõ.

## 1. Cách làm

| | |
|---|---|
| CVAT | 2.75.1 local, project 9 → task 55 → job 76 (project giao `qc1`, job giao `annotator1`) |
| Dữ liệu | nuScenes scene-1077: 41 frame LiDAR thật + 6 camera mỗi frame; nhãn chuẩn của nuScenes: 67 vật, 651 box |
| Tài khoản | `qc1` và `annotator1`, nhóm `worker` của CVAT; dịch vụ QC chạy bằng token của `qc1` |
| Annotator | Script ghi nhãn qua API bằng token của `annotator1`: nhãn chuẩn **có cài 36 lỗi biết trước** (12 loại × 3, chọn ngẫu nhiên với seed cố định) |
| QC | Script gọi API của dịch vụ QC (quét, duyệt object, trả lỗi, gửi phiếu, nghiệm thu). QC quyết định theo danh sách lỗi đã cài, để đo riêng phần của tool |

**Giới hạn:** không có người thật gán nhãn hay duyệt. Bước đăng nhập của dịch vụ QC được bỏ qua trong lần thử (không dùng mật
khẩu), mọi bước khác là dịch vụ thật. Tỉ lệ lỗi cài là do người thử chọn, không phải tỉ lệ lỗi thật của annotator.

Lỗi cài:

| Loại | Cách cài | Số |
|---|---|---|
| Lơ lửng | nâng box 0,4 m ở 3 frame liền | 3 |
| Lún | hạ box 0,4 m ở 3 frame liền | 3 |
| Sai kích thước cả track | dài thêm 35% | 3 |
| Sai kích thước 1 frame | dài, rộng thêm 40% ở 1 frame | 3 |
| Quay ngược một đoạn | yaw +180° ở 3 frame | 3 |
| Quay ngược cả track | yaw +180° mọi frame | 3 |
| Box nhảy | lệch ngang 1,2 m ở 1 frame | 3 |
| Đứt track | tách một vật thành 2 ID | 3 |
| Đổi ID | hai vật cùng class cách 2–7 m đổi ID giữa chừng | 3 |
| Vẽ trùng | chép một vật 4 frame, lệch 0,2 m | 3 |
| Sai class | car → truck (2), barrier → traffic_cone (1) | 3 |
| Thiếu box | bỏ cả một vật | 3 |

Chấm điểm:

- Một mục tool báo **"trỏ đúng chỗ"** khi nó nằm trên đúng object bị cài lỗi và frame lệch không quá ±1.
- Mục đó **"đúng loại lỗi"** khi luật báo nằm trong danh sách luật hợp với loại lỗi, khai báo trước khi chấm.
- Mục nào lần quét nhãn chuẩn (chưa cài lỗi) cũng báo, cùng luật và cùng vật, thì tính là **có sẵn**, không tính là bắt được.

## 2. Tool bắt lỗi (vòng 1, 36 lỗi cài)

| Loại lỗi | Trỏ đúng chỗ | Đúng loại | Luật báo |
|---|---|---|---|
| Lơ lửng | 3/3 | 3/3 | ground.gap, ground.points_below |
| Lún | 3/3 | 3/3 | ground.gap |
| Sai kích thước 1 frame | 3/3 | 3/3 | size.class_range, size.in_track, track.jump |
| Đứt track | 3/3 | 3/3 | track.fragment |
| Vẽ trùng | 3/3 | 3/3 | track.duplicate, overlap |
| Sai class | 3/3 | 3/3 | size.class_range |
| Đổi ID | 3/3 | 2/3 | track.swap |
| Quay ngược một đoạn | 2/3 | 2/3 | heading.jump |
| Sai kích thước cả track | 2/3 | **0/3** | (chỉ báo phụ: chồng lấn…) |
| Quay ngược cả track | 1/3 | **0/3** | — |
| Box nhảy 1,2 m | **0/3** | **0/3** | — |
| Thiếu box | **0/3** | **0/3** | tool không có model, không thấy vật chưa gán |
| **Tổng** | **26/36 (72%)** | **22/36 (61%)** | Bỏ 3 lỗi thiếu box: 26/33 (79%) và 22/33 (67%) |

**Độ chính xác:**

- Qua 3 lần quét job, tool báo 43 mục không có sẵn trên nhãn chuẩn. **39 mục trỏ đúng lỗi cài (91%)**, 4 mục là báo nhầm.
  4 mục này thực ra chỉ là 2 mục giống nhau lặp lại ở vòng 2 và vòng 3: "lún 25–36 cm" ở 2 barrier, frame 37.
  Hai barrier này cách vật bị bỏ (lỗi thiếu box) 5,7–6,7 m. Có thể điểm LiDAR của vật thiếu box bị tính vào mặt đất,
  nhưng chưa kiểm chắc.
- Trên **nhãn chuẩn nuScenes**, tool báo 11 mục. Phân loại sau khi xem số liệu:
  - **3 báo nhầm của tool:**
    - 2 mục "box nhảy 3,1 và 4,8 m" ở frame 7. Ở frame 7 xe thu đi 9,3 m, frame trước và sau đi 7,2 và 8,9 m. Lúc đầu nghĩ
      nguyên nhân là frame cách nhau không đều, nhưng khử lệch thời điểm frame (mục 6) không làm hết báo nhầm, nên
      **nguyên nhân chưa xác định**.
    - 1 mục "đáy lệch mặt đất vùng 22 m": ước lượng mặt đất sai.
  - **5 mục đúng về mặt số liệu:** 3 cặp barrier chồng nhau 17%, 6%, <1%, và 2 box không có điểm LiDAR nào. Theo guideline
    hiện tại, mọi chồng lấn đều là lỗi.
  - **3 mục chưa xác minh:** lơ lửng / lún 24 cm (2 mục) và hướng đổi 33° trong 1 frame.

## 3. Vòng trả lỗi / sửa / nghiệm thu

| Vòng | Việc | Số liệu |
|---|---|---|
| 1 | QC quét | 6,8 s cho 632 box / 70 object |
| 1 | QC duyệt | 70/70 object; trả 42 object, trong đó 36 có tool báo, 6 QC tự thấy; gửi 42 phiếu; CVAT: job → annotation / rejected |
| 1 | Không tạo phiếu được | 3 lỗi thiếu box: hệ thống chỉ tạo phiếu theo object có sẵn |
| 2 | annotator1 sửa | Sửa 31 lỗi (34 track cập nhật, 6 track xoá) trong 4,4 s ghi API. Cố ý để sót 2 lỗi, và sinh 1 lỗi mới lúc sửa (nâng 0,5 m ở 1 frame). Nộp 42 phiếu |
| 2 | Báo "CVAT chưa đổi" | 5/42 phiếu: **2 đúng** (2 lỗi cố ý để sót), **3 gây hiểu nhầm** (lỗi vẽ trùng sửa bằng cách xoá bản chép, nên object gốc không đổi) |
| 2 | QC quét lại | 5,9 s; nghiệm thu 39 phiếu, trả lại 3 |
| 2 | Lỗi mới sinh lúc sửa | **Tool không bắt được.** Barrier này có 4/10 box tool không đo được mặt đất, frame bị nâng có thể là một trong số đó |
| 3 | annotator1 sửa nốt | 3 phiếu; QC quét 5,1 s, nghiệm thu 3/3 |
| 3 | Hoàn thành job | Dịch vụ QC: hoàn thành, 64 object; CVAT: job → acceptance / completed |

**Kết quả cuối, so với nhãn chuẩn nuScenes:**
- 64/64 track trên CVAT khớp hoàn toàn nhãn chuẩn.
- **Còn thiếu 3 vật (30 box)**, nhưng job vẫn hoàn thành được. Đây là lỗ hổng lớn nhất lần thử này cho thấy.

## 4. Công sức của QC

| Con số | Có tool | Không có tool (cùng job) |
|---|---|---|
| Duyệt theo thứ tự, mở bao nhiêu object thì gặp 50% lỗi | 20 / 70 | 31 / 70 (thứ tự mặc định của CVAT) |
| … gặp 75% lỗi | 34 | 45 |
| Lỗi nằm trong 20 object đầu | 17 / 33 | 11 / 33 |
| Gặp lỗi cuối cùng | object thứ 70 | object thứ 62 |
| Lượt mở object qua 3 vòng QC | 115 (70 + 42 + 3), xem ghi chú bên dưới | 198 (70 × 1 + 64 × 2), nếu mỗi vòng QC xem lại cả job |
| Thời gian máy quét | 5–7 s mỗi lần cho ~630 box | 0 |

**Cách đọc bảng:**

- Với các lỗi tool trỏ được (26), QC gặp hết trong **39 object đầu**: đúng 39 object có lỗi / cảnh báo mà tool xếp lên đầu.
- Với lỗi tool **không** thấy, thứ tự của tool không giúp gì. Chúng nằm rải trong phần còn lại, nên QC vẫn phải xem đủ 100%.
- **Vòng 1, QC tự xem đủ 100% object (70/70)**, kể cả object tool không báo gì. Tool chỉ xếp thứ tự, không bỏ qua object nào.
- Con số 115 lượt **không có nghĩa là bỏ qua object không lỗi**:
  - Ở vòng 2 và 3, object QC đã tự xem ở vòng 1 mà nội dung không đổi một chút nào thì giữ kết luận của QC.
  - Việc "không đổi" là so sánh nguyên văn dữ liệu box (dấu vân tay SHA-1 của cả track). Đây không phải thuật toán đoán lỗi,
    nên không có chuyện "phát hiện sót".
  - Object bị sửa, kể cả sửa ngoài phiếu, tự về "chưa xem", và job không hoàn thành được cho tới khi QC xem lại.
- Nếu quy trình của nhóm yêu cầu **mỗi vòng xem lại cả job** (để có lượt nhìn thứ hai, bắt lỗi QC tự bỏ sót ở vòng trước),
  thì không còn khoản giảm 42% này (115 so với 198). Đây là lựa chọn quy trình, không phải giới hạn của tool.
- **Số phút** QC tiết kiệm được chưa đo: cần người thật bấm giờ mỗi lượt mở object. Lấy con số đó nhân với số lượt ở trên là
  ra.

## 5. Điểm yếu tìm ra (việc cần sửa)

1. **Box nhảy 1,2 m ở 1 frame: 0/3.** Đã sửa một phần, xem mục 6: còn bắt 2/3.
2. **Quay ngược cả track: 0/3.** Box quay 180° quanh tâm có hình dạng y hệt, nên luật hình học không thấy. Cần so hướng box
   với hướng di chuyển, chỉ áp dụng cho vật đang chạy.
3. **Sai kích thước cả track (+35%): 0/3 đúng loại.** Kích thước vẫn nằm trong khoảng cho phép của class. Cần so box với
   phần bao của điểm LiDAR.
4. **Thiếu box: 0/3, và job vẫn hoàn thành được.** Cần cho QC tạo phiếu "thiếu vật" theo frame và vị trí, không gắn với
   object. Cũng có thể gợi ý cụm điểm LiDAR không nằm trong box nào.
5. **Báo "CVAT chưa đổi"** gây hiểu nhầm với lỗi theo cặp (vẽ trùng, đứt track), vì cách sửa là xoá object kia. Nên kiểm cả
   object kia khi phiếu thuộc loại lỗi theo cặp.
6. **Lỗi nâng 0,5 m ở 1 frame** không bị bắt ở box tool không đo được mặt đất. Cần dùng thêm so sánh trong track: đáy box
   so với các frame bên cạnh.

## 6. Sửa luật "box nhảy" (28/10/2026)

**Nguyên nhân bỏ sót.** Luật cũ chỉ báo khi cả hai hệ toạ độ cùng thấy lệch: toạ độ xe thu (như CVAT lưu) và toạ độ đã bù
chuyển động xe thu. Trong toạ độ xe thu, mọi vật trôi 7–9 m mỗi frame theo xe thu, nên ngưỡng nới thành khoảng 2,7 m:
- box lệch dọc đường 1,2 m bị coi như xe thu đổi tốc độ;
- box lệch ngang cũng bị nới theo quãng đường đó.

**Đã đổi:**
1. Tách lệch dọc hướng đi (được nới theo quãng đường như cũ) và lệch ngang (gần như không nới: 0,05 × quãng đường, tối
   thiểu 1 m). Vùng cho phép là hình elip. Với vật chạy chậm, elip là hình tròn 1 m, giống luật cũ.
2. Vật đứng yên trong toạ độ đã bù thì chỉ cần hệ toạ độ đã bù báo, khi có chuyển động xe thu từ point cloud. Nếu ước
   lượng chuyển động xe thu sai ở một frame thì mọi vật ở frame đó cùng lệch, và trường hợp này đã bị lọc "nhiều track cùng
   nhảy".

**Đo lại**, cùng dữ liệu và cùng seed với lần trước:

| | Luật cũ | Luật mới |
|---|---|---|
| 4 job thật (75, 74, 72, 69), cài 12 box nhảy mỗi job: bắt lệch 1,0 m | 18/48 | **29/48** |
| … lệch 1,5 m | 31/48 | **39/48** |
| … lệch 2,0 m | 35/48 | **42/48** |
| Báo nhầm "box nhảy" trên nhãn chuẩn của 4 job | 3 | **5** |
| Job 76 vòng 1: lỗi box nhảy 1,2 m | 0/3 | **2/3** |
| Job 76 vòng 1: tổng lỗi cài trỏ đúng chỗ / đúng loại | 26 / 22 trên 36 | **28 / 25** trên 36 |
| Job 76 vòng 1: báo nhầm trên nhãn có lỗi cài | 0 | 0 |

- Bắt được nhiều hơn rõ ở cả 3 cỡ, nhưng báo nhầm trên nhãn chuẩn tăng thêm 2 mục: cả hai ở frame 36 của job 74, lệch 1,1 và
  1,6 m, chưa rõ là lỗi nhãn thật hay báo nhầm.
- Còn lỗi bị bỏ sót: lệch 1,0 m nằm sát ngưỡng 1 m nên chỉ bắt khoảng 60%. Một xe đang chạy lệch ngang 1,1 m ở frame gần
  cuối track (E18) vẫn sót.

**Đã thử nhưng bỏ:**

| Cách | Bắt 1,0 / 1,5 / 2,0 m | Báo nhầm | Vì sao bỏ |
|---|---|---|---|
| Chỉ dùng toạ độ đã bù cho mọi vật | 14 / 43 / 44 | 14 | Đường cao tốc ít vật đứng yên, ước lượng chuyển động xe thu sai ở vài frame |
| Khử lệch thời điểm frame (trung vị theo các track đang chạy) | 20 / 35 / 39 | 5 | Không làm hết báo nhầm ở frame 7 mà còn làm giảm số bắt được |
| Tách dọc / ngang theo hai ngưỡng riêng (không phải elip) | 7 / 38 / 42 | 4 | Lệch chéo 1 m tách thành 0,7 + 0,7, nên dưới cả hai ngưỡng |
