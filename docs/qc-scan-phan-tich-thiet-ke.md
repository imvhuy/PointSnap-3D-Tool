# Tool scan QC — phân tích hiện trạng và thiết kế lại

*Ngày 25/10/2026. Phân tích dựa trên mã trong `pointsnap/` (backend Python ~18 000 dòng) và kiểm tra trực tiếp trên CVAT
2.75.1 local. Tài liệu đi cùng: [pain point và giải pháp](pain-points-va-giai-phap.md) (phần annotator).*

> **Cập nhật 26/10/2026.** Mentor cho phép chạy dịch vụ QC trên máy trong mạng công ty, nên tầng C được làm trước tầng B,
> dưới dạng dịch vụ Node `qc/` dùng lại nguyên bộ luật JS của extension (không qua backend Python). Đã làm gì và kết quả
> đo trên dữ liệu thật: mục 9.

## 1. Tóm tắt

- Tool QC hiện tại **chạy tốt trên dữ liệu demo nuScenes**, nhưng **chưa dùng được trên CVAT của công ty**. Có ba lý do:
  1. chỉ lấy được point cloud từ bản xuất nuScenes do chính tool tạo;
  2. gắn cờ lỗi cần một thuộc tính trong schema label, mà sửa schema thì phải có quyền sửa project;
  3. nhiều luật cần pose, camera hoặc GPU, những thứ một CVAT bình thường không có.
- Luật của QC và luật của extension annotator **đã lệch nhau** (mặt đất, khoảng kích thước, luật yaw, ngưỡng). Annotator thấy
  "ổn" mà QC báo lỗi, hoặc ngược lại, là cách nhanh nhất để cả hai bên mất tin tool.
- Hai điều **đã kiểm trên CVAT thật** mở ra hướng khác:
  - CVAT trả point cloud của job qua API (`/api/jobs/<id>/data?type=chunk`, zip các file `.pcd`), bằng tài khoản thường;
  - trong trình duyệt, extension đọc được point cloud của **frame bất kỳ** trong 1–2 ms.
- **Đề xuất:** làm **"chế độ QC" ngay trong extension**. QC mở job trên CVAT, bấm "Quét cả job"; extension chạy **cùng bộ luật**
  với annotator trên mọi box của mọi frame, ra danh sách vấn đề, bấm để nhảy tới box, ghi Đúng / Báo nhầm, xuất báo cáo.
  Cách này không cần server, không cần token, không cần quyền sửa schema, và dữ liệu không rời CVAT. Phần nặng (quét hàng
  loạt nhiều job, camera / ML, gộp nhiều frame theo pose) để ở tầng server tùy chọn, làm sau.

## 2. Hiện trạng: tool đang làm gì

### 2.1 Luồng

```mermaid
flowchart LR
  P[Web portal: dự án, CVAT URL + token] --> S[Chọn task / job, bấm Quét]
  S --> R[ScanRunner: đọc nhãn qua REST, tìm manifest, nạp point cloud]
  R --> D[Scanner: 23 luật, evidence gate]
  D --> F[Findings + coverage]
  F --> W[Web: bảng lỗi, Duyệt Đúng / Báo nhầm, gate ĐẠT / KHÔNG ĐẠT]
  F --> H[Báo cáo HTML / CSV]
  W --> C[Gắn cờ: ghi thuộc tính pointsnap_error lên box trong CVAT]
  W --> L[learn: precision theo luật từ kết luận duyệt]
```

- Điểm vào: `pointsnap ui` (FastAPI, cổng 8765), `pointsnap scan / gate` (CLI, mã thoát cho CI).
- Lưu trữ: file JSON theo dự án trong `POINTSNAP_HOME`; hàng đợi là thread trong tiến trình, không bền.
- Tốc độ đã đo: 7–20 s một cảnh khoảng 40 keyframe.

### 2.2 Các luật (`pointsnap/config.yaml`, `core/scanner.py`)

| Nhóm | Luật | Cần |
|---|---|---|
| Mặt đất | `floating` (RANSAC vành đai quanh box, so với trung vị track, gộp 4 sweep) | Point cloud |
| Kích thước | `size.class_range`, `size.in_track` | Chỉ box |
| Hướng | `heading.flip`; `heading.motion`, `heading.static` | Box; hai luật sau cần pose |
| Độ khít | `heading.points`, `fit.empty`, `fit.outside`, `fit.loose`, `fit.overlap`, `fit.offset/yaw` (SAM) | Point cloud (SAM: GPU) |
| Spec / thuộc tính | `attr.missing/invalid/height`, `spec.inside`, `spec.rider_double`, `attr.rider_state` | Box; `rider_state` cần pose |
| Sót vật | `lidar.missing` (cụm điểm chuyển động không có box) | Point cloud + pose |
| Camera / ML | `cam.mismatch/class/missing/sparse`, `cam.face` (CLIP), `critic.box` (PyTorch) | Ảnh + calibration + model |

Kèm theo: evidence gate (hạ mức khi box ít điểm), coverage (ghi rõ luật nào không chạy vì thiếu dữ liệu), learn
(Beta / logistic theo kết luận duyệt), và nhánh sửa tự động v1 (route trả HTTP 410, bỏ từ QĐ-010).

## 3. Vấn đề khi đem dùng thật

| # | Vấn đề | Bằng chứng | Hậu quả |
|---|---|---|---|
| Q1 | **Point cloud chỉ lấy từ bản xuất nuScenes** của tool (`ManifestFrames` đọc `manifest.json` + thư mục nuScenes gốc) | `cli/common.py: frames_for_job`, `adapters/cvat/reader.py: ManifestFrames` | Trên CVAT công ty, mọi luật cần LiDAR bị bỏ qua: mặt đất, độ khít, `heading.points`, `lidar.missing`. Chỉ còn luật kích thước, hướng, thuộc tính |
| Q2 | **Gắn cờ ghi vào thuộc tính `pointsnap_error`**, chỉ có khi task được tạo bằng `to-cvat` | `adapters/cvat/writer.py`, `datasets/nuscenes/to_cvat.py: label_specs` | Trên project có sẵn phải thêm thuộc tính vào schema label (cần quyền sửa project). Ghi qua PATCH vào nhãn của annotator, nên dễ xung đột khi họ đang mở job |
| Q3 | **Pose**: CVAT không lưu pose xe thu | `scan_coverage_gaps` | `heading.motion`, `heading.static`, `attr.rider_state`, `lidar.missing` chạy một phần hoặc không chạy |
| Q4 | **Luật QC lệch luật annotator** | So `config.yaml` với `extension/src/annotator/guideline.js` | Hai nơi ra kết luận khác nhau trên cùng một box (chi tiết ở 3.1) |
| Q5 | **Camera / ML** cần calibration, model, GPU; mặc định nhiều luật đang bật | `config.yaml` (`cam_*: true`, `critic_box: true`) | Trên CVAT thường, báo cáo luôn kèm "kiểm tra một phần", gây khó hiểu |
| Q6 | **Annotator phải đổi ứng dụng** để xem lỗi (web portal); cờ là chuỗi chữ trong thuộc tính, không bấm để nhảy tới được | `web/static`, writer | Vòng QC → annotator chậm, dễ bỏ sót |
| Q7 | **Hiệu năng và mã**: mỗi luật đọc lại PCD; hai kiến trúc detector song song; ~500 dòng sửa tự động v1 chết; `web/app.py` 1 200 dòng | Ghi chú rà soát 24/10 | Khó sửa, khó mở rộng |
| Q8 | **Precision chưa nghiệm thu trên dữ liệu thật của đội** | `docs/bao-cao-du-an.md` | Chưa biết bao nhiêu % báo là đúng |

### 3.1 Chỗ lệch giữa QC và annotator (Q4)

| Mục | QC (`config.yaml`) | Annotator (extension 0.5.0) | Dữ liệu chọn bên nào |
|---|---|---|---|
| Mặt đất | RANSAC vành đai 0,1–0,8 m quanh footprint, so với trung vị track | Bản đồ địa hình cả frame (GroundGrid), dải ±1 m, khoảng [thấp, cao] dưới 4 góc, ≤ 50 m | Extension: đo trên AV2 có bản đồ thật, p90 ≤ 10 cm trong 50 m |
| Ngưỡng lơ lửng / lún | 15 / 22 cm | 20 / 35 cm | Extension: chỉnh trên nhãn chuẩn nuScenes |
| Khoảng kích thước | 5 cảnh nuScenes | 10 cảnh, nới người / xe máy / nón / bus | Extension: báo nhầm 3,4% → 0,5% |
| Hướng nhảy | So lân cận | Đoán từ lân cận (nội suy + ngoại suy) | Extension: 0,02% báo nhầm, bắt 98% lật 180°, cả ở hai đầu track |
| Độ khít | Tỉ lệ điểm ngoài box so với trung vị track | Mặt lòi > 10 cm hoặc ≥ 20 điểm đỏ chiếm ≥ 15% | Chưa so trực tiếp |

## 4. QC thật sự cần gì (khác annotator ở đâu)

| | Annotator | QC |
|---|---|---|
| Đơn vị | Một box, ngay lúc đang sửa | Cả job (hàng chục track, hàng trăm đến hàng nghìn box) |
| Câu hỏi | "Box này đúng chưa, sửa thế nào?" | "Job này đạt chưa? Xem box nào trước? Lỗi nào trả về annotator?" |
| Cần thêm | Số đo, nút sửa | Danh sách xếp hạng, lọc theo luật / track / frame, kết luận Đúng / Báo nhầm, gate, báo cáo, gửi lỗi về annotator |
| Luật chỉ QC làm được | — | Cấp job: box trùng giữa hai track, sót vật (`lidar.missing`), thống kê lỗi theo annotator / luật |

Nguyên tắc giữ nguyên: **tool đề xuất, người quyết** (QĐ-010). QC không tự sửa nhãn; chỉ gửi vấn đề về annotator.

## 5. Thiết kế đề xuất

### 5.1 Nguyên tắc

1. **Một bộ luật cho cả annotator và QC.** Các module JS trong `extension/src/annotator/` (`box`, `terrain`, `checks`,
   `object-points`, `track-ops`, `guideline`) là hàm thuần, đã có test Node, nên dùng lại nguyên cho QC.
2. **Dữ liệu lấy từ chính CVAT**, không từ bản xuất riêng.
3. **Không cần quyền đặc biệt**: không sửa schema, không token cho luồng chính.
4. **Rõ phần nào không kiểm được** (coverage), không im lặng bỏ qua.

### 5.2 Ba tầng

| Tầng | Chạy ở đâu | Làm gì | Cần |
|---|---|---|---|
| **A. Annotator** (đã có, 0.5.0) | Extension, box đang chọn | Kiểm tra trực tiếp + nút sửa | — |
| **B. QC trong extension** (đề xuất làm trước) | Extension, cả job, trong tab CVAT của QC | Quét mọi box mọi frame bằng cùng luật; luật cấp job; danh sách, nhảy tới box, Đúng / Báo nhầm, gate, xuất báo cáo; gửi vấn đề về annotator | Tài khoản CVAT mở được job |
| **C. Server cạnh CVAT** (tùy chọn, sau) | Máy chủ trong mạng CVAT | Quét hàng loạt nhiều job theo lịch; camera / ML; gộp nhiều frame theo pose; mặt đất ở xa | Token, pose, GPU; cần mentor chốt có được coi là "dữ liệu không rời CVAT" |

```mermaid
flowchart TB
  subgraph Ext["Extension trong trang CVAT"]
    Core["Bộ luật chung (JS thuần): mặt đất, kích thước, hướng, độ khít, chồng lấn, thuộc tính"]
    Ann["A. Bảng annotator (box đang chọn)"]
    QC["B. Chế độ QC (cả job)"]
    Core --> Ann
    Core --> QC
  end
  CVAT[("CVAT: nhãn + point cloud từng frame")] --> Ann
  CVAT --> QC
  QC -->|"vấn đề + gợi ý sửa"| Out{{"Gửi về annotator"}}
  Out --> I1["CVAT Issues (có sẵn trong CVAT)"]
  Out --> I2["File kết quả QC, annotator nhập vào bảng"]
  Srv["C. Server tùy chọn: hàng loạt, camera, pose"] -.-> Out
```

### 5.3 Chế độ QC trong extension (tầng B)

**Luồng của QC:**
1. Mở job trên CVAT → bảng PointSnap → **Quét cả job**.
2. Extension đọc nhãn mọi frame (`job.annotations.get`) và point cloud mọi frame (`job.frames.get(n).data()`, đã kiểm), rồi
   chạy bộ luật chung trên từng box và các luật cấp job trên cả job.
   - Ước lượng tốc độ từ số đo AV2: dựng bản đồ mặt đất 30–90 ms mỗi frame, đo một box ≤ 8 ms. Khoảng 5–10 s cho 40 frame,
     1–2 phút cho 1 000 frame; có thanh tiến độ, dừng được.
3. **Bảng QC**:
   - gate ĐẠT / KHÔNG ĐẠT theo ngưỡng dự án;
   - số vấn đề trên 100 box theo luật;
   - danh sách gộp theo track (một track lệch kích thước 30 keyframe là một mục, không phải 30 mục), lọc theo luật / mức /
     class.
4. Bấm một mục → CVAT nhảy tới frame và chọn đúng box; bảng annotator hiện số đo của box đó.
5. QC ghi **Đúng / Báo nhầm** cho từng mục. Kết luận lưu theo job trong trình duyệt và xuất được ra file, dùng để đo
   precision từng luật (nối với `learn` sau này).
6. **Xuất**: CSV / JSON kết quả và báo cáo tóm tắt.

**Luật cấp job cần thêm** (chỉ QC làm, vì cần nhìn cả job):
- box trùng giữa hai track khác nhau (chồng > 50% nhiều frame liền);
- track có keyframe "rơi" giữa chừng (outside xen kẽ bất thường);
- chặn đáy bằng điểm của chính vật cho box ở xa (đã đo trên AV2: 50–100 m bắt 52–78% box lơ lửng 0,5–1 m, báo nhầm 1,6%);
- `lidar.missing` (sót vật): chuyển dần từ Python sang sau, vì cần pose mới chính xác.

### 5.4 Gửi vấn đề về annotator

| Cách | Ưu | Nhược | Trạng thái |
|---|---|---|---|
| **CVAT Issues** (tính năng review có sẵn) | Có sẵn trong CVAT; annotator thấy trong giao diện quen; không sửa schema | Chưa biết giao diện job 3D có hiện issue không | API `/api/issues` trả 200 trên CVAT local; **chưa thử tạo issue cho job 3D** |
| **File kết quả QC** → annotator nhập vào bảng PointSnap | Không phụ thuộc CVAT; hiện ngay trên checklist và dải track ("QC báo"), có nút sửa | Phải chuyển file (chat, ổ chung) | Cần làm |
| Cờ `pointsnap_error` (cách hiện tại) | Đã có, có bảo vệ hình học | Cần sửa schema; ghi vào nhãn | Giữ cho project đã có thuộc tính này |

Đề xuất: thử CVAT Issues trên job 3D trước. Nếu hiện được thì dùng làm kênh chính, còn file là phương án dự phòng.

### 5.5 Backend Python hiện tại

- **Giữ**: đánh giá / benchmark trên nuScenes (`eval`), học từ kết luận (`learn`), các luật camera / ML. Đây là nguyên liệu
  cho tầng C.
- **Sửa** khi tầng C được làm: thêm `CvatFrames` đọc point cloud từ CVAT (`/api/jobs/<id>/data?type=chunk`) thay cho
  `ManifestFrames`; đọc mỗi frame một lần; bỏ nhánh sửa tự động v1; chọn một kiến trúc detector.
- **Không** tiếp tục chỉnh ngưỡng song song ở `config.yaml`: ngưỡng và luật chung lấy từ một nguồn (guideline của extension),
  để tránh lệch như mục 3.1.
- *Thực tế (26/10):* tầng C làm bằng Node (`qc/`) chứ không thêm `CvatFrames` vào Python. Lý do: chạy được ngay bộ luật JS
  của extension, một nguồn luật duy nhất, không phải dịch luật sang Python. Backend Python vẫn giữ cho `eval`, `learn`,
  luật camera / ML; chưa chuyển sang `qc/`: `lidar.missing`, camera / ML, gắn cờ `pointsnap_error`, CLI gate cho CI.

## 6. Lộ trình

| Giai đoạn | Việc | Công sức | Xong khi |
|---|---|---|---|
| 1 | Chế độ QC trong extension: quét cả job, danh sách gộp theo track, nhảy tới box, Đúng / Báo nhầm, gate, xuất CSV / JSON | Vừa (khoảng 1–2 tuần) | Quét được job 3D bất kỳ trên CVAT local và một CVAT khác, không cần server |
| 2 | Gửi về annotator: thử CVAT Issues trên job 3D; nếu không được thì làm nhập file QC vào bảng annotator | Nhỏ đến vừa | Annotator thấy vấn đề QC ngay trong CVAT, bấm tới box |
| 3 | Luật cấp job (box trùng giữa track, chặn đáy ở xa), đo precision thật trên job của đội | Vừa | Có precision theo luật trên dữ liệu thật |
| 4 | Tầng C (tùy chọn): server cạnh CVAT, `CvatFrames`, quét hàng loạt, camera / pose | Lớn | Chỉ làm nếu mentor xác nhận cần và được phép |

## 7. Câu hỏi cần chốt với mentor

1. **QC hiện làm thế nào?** Xem 100% job hay lấy mẫu? Một người QC một job mất bao lâu? Lỗi hay bị trả về nhất là loại gì?
2. **Gửi lỗi về annotator bằng gì?** Đang dùng CVAT Issues, bảng tính, hay chat? Kênh nào annotator sẽ thật sự đọc?
3. **Tiêu chí ĐẠT của một job**: bao nhiêu lỗi trên 100 box, loại lỗi nào chặn ngay?
4. Có cần **quét hàng loạt nhiều job** (tầng C) không, hay QC mở từng job là đủ?
5. **Server cạnh CVAT** có được coi là "dữ liệu không rời CVAT" không?
6. Dự án có **ảnh camera + calibration, pose xe thu** không? Nếu không, bỏ hẳn nhóm luật camera / pose khỏi phạm vi.

## 8. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Job rất dài (hàng nghìn frame) làm tab chậm | Quét theo lô frame, nhường luồng giữa các lô, dừng / tiếp tục; giữ ≤ 1 point cloud trong bộ nhớ |
| CVAT khác phiên bản đổi API nội bộ | Mọi chỗ chạm CVAT nằm trong `cvat-adapter.js`; popup đã báo phiên bản chưa thử |
| CVAT Issues không hiện trên job 3D | Dùng file kết quả QC (giai đoạn 2) |
| Precision thật thấp hơn trên nhãn chuẩn | Giai đoạn 3 đo trên job của đội; luật nào precision thấp thì hạ xuống Thông tin |
| Mất phần đã làm ở backend Python | Không xóa; giữ cho đánh giá và tầng C |

## 9. Dịch vụ QC `qc/`: đã làm và kết quả đo (26/10/2026)

### 9.1 Đã làm

- Dịch vụ Node ≥ 20, không thư viện ngoài, chạy trên một máy trong mạng công ty (thử trên localhost). Đọc CVAT bằng access
  token **chỉ đọc**; token nằm ở máy chủ, không xuống trình duyệt; point cloud đọc xong bỏ, không lưu.
- Một lượt quét: đọc nhãn → dựng box mọi frame như CVAT (nội suy keyframe) → tải point cloud theo gói frame
  (`/api/jobs/<id>/data?type=chunk`) → chạy `measure.js` + `checks.js` của extension trên mọi box, thêm `heading.jump`
  cấp track → gộp theo object + luật (luật theo cặp gộp theo cặp) → coverage (frame thiếu point cloud, box không đo được
  mặt đất, nhóm luật không kiểm).
- Trang web: danh sách job, tiến độ, bảng theo luật, lọc, Đúng / Báo nhầm (lưu theo khoá ổn định, quét lại không mất),
  Mở CVAT tới frame + object, xuất CSV / JSON. Chi tiết chạy: [qc/README.md](../qc/README.md).
- Nguyên tắc: tool chỉ giảm việc lượt đầu, QC vẫn kiểm cả job. Không dùng model; mỗi mục kèm số đo để QC kiểm lại ngay.

### 9.2 Kết quả trên CVAT local (nhãn chuẩn nuScenes / Argoverse 2)

| Job | Dữ liệu | Frame | Box | Thời gian | Mục lỗi + cảnh báo |
|---|---|---|---|---|---|
| 75 | nuScenes scene-1100 | 40 | 906 | 3,5 s | 6 |
| 74 | nuScenes scene-1077 | 41 | 651 | 2,8 s | 7 |
| 72 | Argoverse 2 | 40 | 1 515 | 9,6 s | 19 |
| 69 | nuScenes scene-0061 (công trường) | 39 | 3 333 | 5,0 s | 112 |

Sửa trong `qc/` sau lần chạy đầu: CVAT 2.75 trả 406 cho `Accept: application/json` (dùng `application/vnd.cvat+json`);
luật `overlap` không được gộp theo cặp nên mỗi cặp thành hai mục (41 cặp thay vì 82 mục); mục theo cặp giữ lời nhắn của
frame chồng nhiều nhất; `ground.no_evidence` (≈ 1 300 box ở job 69) chuyển thành một dòng coverage.

### 9.3 Từng luật: báo đúng hay nhầm

Kiểm bằng số đo point cloud từng mục (điểm trong footprint so với đáy box, ô mặt đất quanh, độ tin cậy) và mở CVAT bằng
link của tool (link đúng frame, lọc đúng object). Nhãn chuẩn nên "đúng" ở đây là đúng theo spec, không phải nhãn sai.

| Luật | Mục (4 job) | Kết luận | Nguyên nhân | Đề xuất (luật chung, thuộc extension) |
|---|---|---|---|---|
| `overlap` | 41 cặp | Tool tính đúng; khác quy ước | Spec hiện tại: cứ chồng là Lỗi (`overlap.error = 0`). 13 cặp chồng < 1%, 8 cặp 1–5% (rào / nón sát nhau); còn lại rào chồng xe công trình, người – xe lăn (AV2) | Chồng < 2% (vài cm) hạ xuống Thông tin; hỏi mentor cặp người – xe lăn có được chồng |
| `ground.gap`, `ground.points_below` | 26 | Phần lớn báo nhầm | 20/26 là người / xe máy ở 23–48 m, ≤ 20 điểm trong footprint, độ tin cậy mặt đất 0,30–0,56; ví dụ job 69 track 97 frame 10: chân người chạm đáy box, ô đất quanh thấp hơn 44 cm (đứng trên bệ) | Dùng điểm của chính vật: điểm thấp nhất của vật sát đáy box thì không báo lơ lửng; xa > 25 m cần độ tin cậy cao hơn |
| `z.range` | 1 | Báo nhầm, lỗi thuật toán | Job 74 frame 6: điểm nhiễu ở z = −24,5 m (phản xạ) thành ô đất; `coarseHeightAt` lấy phân vị 20% của 14 ô nên ra mặt đất −24,5 m | `terrain.js`: bỏ ô đất thấp hơn hẳn mặt đất chung của frame (ví dụ > 5 m) |
| `fit.empty` | 59 | Đúng theo spec, ít giá trị | nuScenes: nón / rào bị che 1–5 frame, không đánh occluded; AV2: box ở 40–162 m, LiDAR thưa | Không báo ngoài tầm đo đáng tin; QC xem cả tỉ lệ frame rỗng của track |
| `heading.jump` | 14 | Báo nhầm | Cả 14 ở keyframe đầu / cuối track (chỉ có ngoại suy); 5 là nón giao thông (yaw không có nghĩa) | Đầu / cuối track cần lệch ≥ 3 × ngưỡng (45° với vật cứng), vẫn bắt lật 180° / quay 90°; bỏ nón. Mô phỏng: 14 → 5 |
| `size.class_range` | 3 | Đúng theo spec | AV2: "car" dài 6,88 m, rộng 2,80 m; bicycle rộng 1,14 m (REGULAR_VEHICLE của AV2 gồm cả xe van) | Giữ |

Chưa đo được precision thật: cần job do đội gán và QC bấm Đúng / Báo nhầm (giai đoạn 3).

### 9.4 Luật chỉ QC, guideline theo phiên bản, giao diện mới (26/10, tối)

- **Luật cấp track** (`qc/lib/trackrules.js`, cho nhãn pre-label: keyframe ở mọi frame, tracker đứt / đổi ID):
  `track.jump` (box nhảy vị trí / kích thước trong một frame, hoặc track nhảy chỗ), `track.swap` (đổi ID), `track.fragment`
  (đứt track), `track.duplicate` (vẽ hai lần). Chuyển động xe thu ước lượng từ chính nhãn (RANSAC trên tâm các track), luật
  chuyển động chỉ báo khi toạ độ xe thu và toạ độ đã bù cùng báo. Trên 4 job: 289 → 8 box báo trên nhãn chuẩn; bắt lỗi cài
  77–93% tuỳ loại. Số đo và lý do từng bước: [pain-points-va-giai-phap.md](pain-points-va-giai-phap.md) PP-20.
- **Guideline theo project có phiên bản** (tab Guideline, `qc/lib/rules.js`): ghi đè = phần khác mặc định của guideline
  extension + nhánh `qc` (ngưỡng luật chỉ QC, luật tắt). Kết quả quét ghi guideline + phiên bản đã dùng. PP-23.
- **Giao diện**: mức ưu tiên thay cho ĐẠT, phần tool không kiểm hiện ngay đầu, dải frame, thanh theo luật, danh sách một
  dòng mỗi mục với ↗ / ✓ / ✕. PP-24.

- **Đứt track làm lại (27/10)**: chuyển động xe thu khớp từ point cloud (ICP), ghép đoạn Hungarian, bằng chứng point cloud
  ở chỗ nối, hình nhìn từ trên trên trang. Nhãn chuẩn 0 báo nhầm, bắt 94% đứt track cài. Chi tiết: PP-20.

### 9.5 Việc tiếp

1. Đổi luật chung theo cột "Đề xuất" ở 9.3 ở phiên extension annotator (luật đổi thì bảng annotator đổi theo), quét lại.
2. Mở xem 5 mục luật chỉ QC còn lại trên nhãn chuẩn (tách ID thật hay báo nhầm); thử trên job pre-label thật (job 73 và job
   pre-label của đội) để đo precision.
3. Danh sách mọi object có ô Đã xem (QC kiểm hết, không chỉ mục tool báo); dùng chung guideline giữa trang QC và extension.
4. Chạy trên job thật của đội, đo precision theo luật và thời gian QC có / không có tool.
