# Nghiên cứu thuật toán LiDAR và kế hoạch kiểm chứng

**Ngày truy cập nguồn:** 26/10/2026. **Phạm vi:** mặt đất, độ khít cuboid, yaw/thời gian, dữ liệu đánh giá. Đây là ghi chú nghiên cứu thành phần; các khuyến nghị là thiết kế/giả thuyết cần kiểm chứng trên PointSnap.

## Kết luận cho người phát triển

1. Giữ giải pháp lưới địa hình JS hiện có làm baseline triển khai; đo và sửa các ca thất bại trước khi thay thuật toán.
2. Gọi đúng tên: **heuristic lưới cao độ một frame, lấy cảm hứng từ GroundGrid**. Mã hiện tại không tương đương triển khai trong bài báo; độ chính xác và tốc độ bài báo không chuyển thành cam kết của extension.
3. Ground segmentation, ước lượng cao độ và chất lượng cuboid là ba bài toán khác nhau; cần ba nhóm phép đo.
4. Box bị che/ít điểm phải có trạng thái chưa đủ bằng chứng; tập điểm quan sát được chưa đủ để suy ra toàn bộ kích thước vật.
5. Thử Patchwork++ như baseline native ngoại tuyến; chỉ thử WASM sau khi benchmark cho thấy lợi ích đủ bù chi phí tích hợp.

## 1. Evidence cards: nguồn sơ cấp

Các đoạn “xác nhận” dưới đây diễn giải ngắn nguồn. Số liệu trên dữ liệu thật của PointSnap chưa được đo lại trong nghiên cứu này.

### L01 — GroundGrid paper

- **Nguồn:** [GroundGrid: LiDAR Point Cloud Ground Segmentation and Terrain Estimation](https://arxiv.org/html/2405.15664v1).
- **Xuất bản:** DOI `10.1109/LRA.2023.3333233`, chấp nhận 2023; bản arXiv 24/05/2024.
- **Xác nhận:** dùng elevation grid, thống kê độ cao, loại nhiễu theo đường nhìn, lưu cao độ/confidence giữa các lần quan sát và nội suy. Bài báo phân biệt kiểm segmentation với kiểm cao độ terrain. Đã đọc phần phương pháp và đánh giá.
- **Giới hạn:** kết quả và runtime thuộc thực nghiệm/triển khai của tác giả; chưa phải bằng chứng cho bản JS.

### L02 — Patchwork++ paper

- **Nguồn:** [Patchwork++: Fast and Robust Ground Segmentation](https://arxiv.org/abs/2207.11919).
- **Xuất bản:** IROS 2022; arXiv v2 tháng 09/2022.
- **Xác nhận:** mở rộng Patchwork với adaptive ground likelihood, temporal ground revert, region-wise vertical plane fitting và reflected noise removal; đánh giá trên SemanticKITTI.
- **Giới hạn:** đã đọc abstract/metadata sơ cấp; chưa tái hiện thuật toán hoặc benchmark trong phiên nghiên cứu này.

### L03 — Patchwork++ usage hiện hành

- **Nguồn:** [Official USAGE.md](https://github.com/url-kaist/patchwork-plusplus/blob/master/USAGE.md).
- **Xác nhận:** tài liệu hiện có hai protocol chấm SemanticKITTI, khác cách xử lý vegetation; cùng dự đoán có thể ra điểm khác. Cấu hình cần xét sensor height, độ nghiêng, range và ngưỡng fit. Đã đọc sâu phần protocol và tuning.
- **Giới hạn:** nội dung nhánh `master` thay đổi; khi benchmark phải pin commit và protocol.

### L04 — L-shape fitting

- **Nguồn:** [CMU Robotics Institute — Efficient L-Shape Fitting for Vehicle Detection Using Laser Scanners](https://publications.ri.cmu.edu/efficient-l-shape-fitting-for-vehicle-detection-using-laser-scanners).
- **Xuất bản:** IEEE IV 2017, Zhang, Xu, Dong và Dolan.
- **Xác nhận:** mô hình hóa L-shape fitting thành bài toán tối ưu và giải bằng tìm kiếm, với các tiêu chí fit khác nhau.
- **Giới hạn:** đã đọc trang tác giả/abstract; PDF tác giả bị timeout khi lấy. Không suy ra độ chính xác của PointSnap từ nguồn này.

### L05 — nuScenes coordinate/timestamp tutorial

- **Nguồn:** [nuScenes devkit tutorial](https://www.nuscenes.org/tutorials/nuscenes_tutorial.html).
- **Xác nhận:** `calibrated_sensor` diễn tả sensor trong hệ ego; `ego_pose` gắn pose với timestamp trong hệ global. `sample_data` có liên kết đến cả hai. Đã đọc phần cấu trúc và chuyển hệ.
- **Giới hạn:** job CVAT được export không mặc nhiên giữ các metadata đó; cần kiểm hợp đồng adapter riêng.

### L06 — nuScenes detection protocol

- **Nguồn:** [Official detection README](https://github.com/nutonomy/nuscenes-devkit/blob/master/python-sdk/nuscenes/eval/detection/README.md).
- **Xác nhận:** protocol tách lỗi vị trí, kích thước, hướng, tốc độ và thuộc tính; có quy tắc range/visibility. Yaw của barrier được xét đối xứng khác các lớp có đầu/đuôi. Đã đọc phần format, preprocessing và metrics.
- **Giới hạn:** đây là đánh giá detector, không phải chứng nhận công cụ QC hoặc thời gian annotator.

### L07 — Argoverse 2 Sensor

- **Nguồn:** [Official Sensor Dataset guide](https://argoverse.github.io/user-guide/datasets/sensor.html).
- **Xác nhận:** point cloud đã bù ego motion theo timestamp tham chiếu, cung cấp trong hệ egovehicle; annotations cũng ở hệ ego. Bộ dữ liệu có pose, calibration và point timestamps.
- **Giới hạn:** phải tránh bù chuyển động lần hai khi adapter đọc dữ liệu này; đã đọc phần sensor, annotations, pose và sweeps.

### L08 — Argoverse 2 ground-height map

- **Nguồn:** [Official HD Maps guide](https://argoverse.github.io/user-guide/api/hd_maps.html).
- **Xác nhận:** dense ground-height raster thuộc Sensor/TbV, không thuộc AV2 LiDAR/Motion Forecasting. Grid có độ phân giải 30 cm và vùng phủ giới hạn; một số log có map thay đổi. API truy vấn cao độ trong hệ city.
- **Giới hạn:** raster là tham chiếu có phạm vi/độ phân giải, không phải đáp án tiếp đất tuyệt đối cho mọi box.

### L09 — KITTI official evaluation

- **Nguồn:** [KITTI 3D Object Detection Evaluation](https://www.cvlibs.net/datasets/kitti/eval_object.php?obj_benchmark=3d).
- **Xác nhận:** dùng 3D overlap và chia độ khó theo kích thước ảnh, che khuất/truncation; nhãn có giới hạn theo image plane. Protocol khác nuScenes.
- **Giới hạn:** AP detector KITTI không thể dùng trực tiếp làm precision finding QC; đã đọc phần dataset/evaluation, không nghiên cứu leaderboard.

## 2. Đối chiếu với mã PointSnap

**Bằng chứng nội bộ:** [`terrain.js`](../../extension/src/annotator/terrain.js), [`object-points.js`](../../extension/src/annotator/object-points.js).

| Khía cạnh | Mã hiện tại | Hệ quả thiết kế |
|---|---|---|
| Địa hình | Dựng theo từng frame; loại vùng trong box có nhãn | Cần regression cho nhãn sai ảnh hưởng vùng đất được giữ lại |
| Nhiễu dưới đất | So min-Z với trung vị min-Z lân cận | Chưa phải loại nhiễu đường nhìn của GroundGrid; thử phản xạ, hố và cầu vượt |
| Phân loại ô | Pool thống kê phương sai theo khoảng cách | Cần kiểm đường dốc, vỉa hè, sàn cao phẳng và vùng không liên tục |
| Ô thiếu dữ liệu | Nội suy nghịch đảo bình phương khoảng cách; confidence theo hỗ trợ | Cần đo hiệu chuẩn confidence, tách ô quan sát với ô nội suy |
| Liên frame | Không tích hợp terrain/confidence theo thời gian | Giữ ưu điểm không cần pose; mọi đề xuất tích hợp thời gian cần hợp đồng chuyển hệ |
| Điểm của vật | Loang qua voxel từ box nới, loại ground/box khác | Cần test vật chạm nhau, cây/tường sát vật và seed nhiễm |
| Khoảng hở | Chỉ đo mặt hướng LiDAR, đủ điểm và không bị che | Giữ nguyên giới hạn bằng chứng; không suy ra mặt khuất từ khoảng điểm |

**Suy luận hình học:** nếu chỉ thấy một mặt phẳng của vật, nhiều cuboid có bề sâu khác nhau cùng bao được tập điểm ấy. Vì vậy tối ưu độ khít của điểm đơn lẻ không xác định duy nhất kích thước/tâm toàn vật. Đây là lý do thiết kế để giữ kích thước theo spec/track và đo mặt quan sát được, chứ không tự đặt box bằng extent của điểm.

## 3. Quyết định thuật toán đề xuất

| Ứng viên | Vai trò đề xuất | Thử nghiệm quyết định |
|---|---|---|
| Lưới terrain JS hiện tại | Baseline phát hành trong extension | Đo bias cao độ, coverage và latency theo từng nhóm tình huống |
| Lưới một frame cải tiến | Ứng viên nâng cấp gần nhất | Ablation loại nhiễu, slope-aware variance, confidence và nội suy có ranh giới |
| Local plane/RANSAC của backend | Baseline đối chiếu có sẵn | So cùng box/frame/ROI; ghi ca thiếu điểm, không coi global plane là đáp án |
| GroundGrid tham chiếu native | Baseline nghiên cứu ngoại tuyến | Đối chiếu faithful implementation, metadata và điều kiện tích hợp nhiều quan sát |
| Patchwork++ native | Baseline ground mask ngoại tuyến | Pin commit/protocol; cùng calibration/range; đo thêm sai số mặt đất dưới box |
| L-shape | Ước lượng trục/mặt thấy được cho vật cứng | Chỉ đề xuất khi đủ bề mặt hỗ trợ; test xoay 90°/180°, vật tròn và vật che khuất |
| WASM hoặc model nặng | Spike sau benchmark | Chỉ tiến hành khi phương án nhẹ không đạt nhu cầu đã đo; kiểm memory/copy/startup |

Các dòng trong bảng là **đề xuất**, chưa phải kết quả xếp hạng. Nên chọn theo hiệu quả end-to-end của annotator/QC, không chỉ điểm ground segmentation.

## 4. Hợp đồng hình học và thời gian cần chốt

### Cuboid nghiêng

Với tâm `c`, rotation matrix `R` và kích thước `(l,w,h)`, tọa độ các góc là `c + R * (±l/2, ±w/2, ±h/2)`.

**Suy luận trực tiếp:** cao độ nhỏ nhất của cả box bằng `c_z - (|R31|*l + |R32|*w + |R33|*h)/2`. Do đó giữ `c_z-h/2` không giữ đáy thế giới khi box có roll/pitch và thay l/w. Khi thay kích thước, có thể tính tâm dự kiến rồi bù z từ các góc; hành vi này phải có test. Còn “tiếp đất đúng” trên dốc cần spec riêng, không đồng nhất với việc giữ min-Z.

**Đề xuất UI:** báo khoảng residual giữa các góc đáy và terrain, số góc có hỗ trợ, mức quan sát/nội suy và khoảng confidence. Với yaw-only trên vỉa hè, biểu diễn khoảng địa hình thay vì một cao độ có vẻ tuyệt đối. Khi thấp hỗ trợ thì trả `INSUFFICIENT_EVIDENCE`.

### Yaw và ego motion

**Suy luận thiết kế từ L05/L07:** chuyển động trong hệ sensor thay đổi không tương đương chuyển động của vật trong global. Kiểm heading theo vận tốc, static world hoặc gộp sweep cần pose/timestamp và chuyển hệ rõ ràng. Thiếu metadata thì chỉ chạy phép kiểm tương đối có hợp đồng phù hợp và công bố giới hạn; không tự suy ra heading-motion đúng.

**Đề xuất:** tách `yaw_axis` với `yaw_heading`; đối xứng π hoặc π/2 chỉ dùng cho phép đo phù hợp. Frame rẽ, reverse và góc qua −π/π có fixture riêng. Tỉa keyframe phải đối chiếu đúng nội suy của CVAT, kể cả mốc outside/occluded/attribute; CVAT adapter là nguồn hợp đồng, không dùng giả định từ tần số dataset.

## 5. Kế hoạch benchmark đề xuất

### Tập kiểm tra và tách dữ liệu

- **Geometry fixtures:** mặt phẳng/dốc/vỉa hè/cầu nhiều tầng, noise phản xạ, box nghiêng, vật sát nhau và các trường hợp ít điểm có đáp án tính được.
- **Public-data holdout:** nuScenes, AV2 Sensor có raster và KITTI được chuyển hệ bằng adapter đã kiểm; chia theo scene/log, không rải frame cùng track vào cả tuning và test.
- **Target-data holdout:** job thật của đội với spec thật; QC xác nhận độc lập, có adjudication khi bất đồng. Public dataset giúp tìm lỗi; quyết định phát hành dựa trên target holdout.
- **Corruption suite:** chèn Z/center/dims/yaw có seed cố định; thử đơn lỗi và lỗi kết hợp. Báo tách kết quả này với lỗi thật do người gán nhãn.

### Chỉ số

| Bài toán | Chỉ số đề xuất |
|---|---|
| Ground mask | Precision/recall/IoU với định nghĩa ground đã khóa |
| Cao độ | Signed bias, MAE, p50/p90/p95 absolute error; coverage, phân biệt observed/interpolated |
| Finding | Precision và recall theo luật/severity/class; false alarms trên 100 box; mẫu số đã duyệt |
| Confidence | Accuracy/coverage theo confidence bin; kiểm giả thuyết “confidence cao thì lỗi thấp” |
| Đề xuất sửa | Sai số trước/sau, tỉ lệ cải thiện và tỉ lệ làm xấu; giữ mặt thấy được, kích thước, đáy và trạng thái |
| Thời gian | Build-frame và per-box p50/p95; cold/warm; số điểm, CPU, browser, phiên bản và memory peak |
| Người dùng | Thời gian đến Save, số thao tác, lỗi sau review; thử cùng job theo thứ tự đối trọng để giảm học thuộc |

### Các lát dữ liệu cần báo riêng

Khoảng cách (ví dụ 0–15/15–30/30–50/>50 m là **bin thử nghiệm đề xuất**), số điểm của vật, loại sensor, slope, curb, occlusion, class/subtype, sensor mounting, static/moving và chuyển động ego. Lỗi raster/ngoài ROI tính thành thiếu tham chiếu, không âm thầm bỏ mẫu rồi báo coverage cao.

### Quy trình ra quyết định

1. Khóa dataset split, ground taxonomy/ignore classes, coordinate adapter, rule version, seed và spec trước khi chạy.
2. Chạy cùng ROI và cùng frame/box cho mọi baseline; ghi lý do abstain/failure.
3. Tune trên development set; báo holdout nguyên vẹn. Bootstrap theo scene/log hoặc báo từng scene để tránh coi frame tương quan là mẫu độc lập.
4. So ablation có/không terrain nội suy, loại nhiễu, point connectivity, visible-face gating và track reference.
5. Chốt ngưỡng phát hành từ chi phí báo nhầm/bỏ sót với QC; chưa đủ dữ liệu để tuyên bố mức precision hay centimet chung cho dự án.

### Cảnh báo về holdout lịch sử của repository

**Bằng chứng nội bộ:** [`eval/split.py`](../../pointsnap/eval/split.py) đặt `scene-1077` và `scene-1100` vào `TEST_SCENES`. Tuy nhiên [phần PP-07](../pain-points-va-giai-phap.md) mô tả nới dải kích thước của extension theo cả 10 cảnh nuScenes mini sau các ca lỗi trên `scene-1100`; [extension README](../../extension/README.md) cũng mô tả hiệu chỉnh sau thử nghiệm ở hai cảnh này.

**Suy luận giới hạn:** các cảnh đó không còn là holdout chưa chạm tới cho bộ luật extension đã hiệu chỉnh, hoặc cho bộ luật tương lai lấy extension làm chuẩn. Đây không phải bằng chứng rằng bộ ngưỡng Python hiện tại đã được chỉnh tương tự: chính tài liệu ghi chúng còn lệch nhau. Khi hợp nhất luật, cần lập development/test manifest mới có các scene/log chưa dùng chỉnh ngưỡng và thêm target-domain holdout.

## 6. Phương pháp và khoảng trống

- **11 truy vấn tìm kiếm thành công** với các biến thể GroundGrid, Patchwork++, L-shape, nuScenes transforms/metrics, AV2 sensor/maps và KITTI evaluation. Một lời gọi lỗi cú pháp trước khi thực thi không tính là truy vấn.
- **9 nguồn sơ cấp được trích ở L01–L09**; đã mở thêm repository GroundGrid và trang AV2 tổng quan để định hướng, không dùng nguồn blog/forum làm chứng cứ.
- Đọc sâu phần phương pháp/đánh giá GroundGrid, protocol/tuning Patchwork++, nuScenes detection, AV2 sensor và HD maps. L-shape chỉ xác nhận từ trang tác giả do PDF timeout.
- Có đọc trực tiếp `terrain.js` và `object-points.js`; không cài thuật toán, tải dataset hay chạy benchmark mới.
- Chưa biết sensor/spec/dữ liệu nội bộ mục tiêu. Chưa có bằng chứng về độ chính xác của WASM port, camera/ML hay confidence đã hiệu chuẩn cho PointSnap.
