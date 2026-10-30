# Đối chiếu kỹ thuật và phương pháp trong lĩnh vực

Ngày kiểm tra nguồn: 29/10/2026. Mục tiêu là chọn hướng nâng chất lượng PointSnap cho gán nhãn/QC cuboid LiDAR trên CVAT. Đây là nghiên cứu tài liệu kết hợp audit mã, chưa phải benchmark các nền tảng hay thuật toán trên cùng dữ liệu.

## 1. Hợp đồng dữ liệu phải đúng trước thuật toán

[CVAT 3D](https://docs.cvat.ai/docs/manual/basics/3d-object-annotation/) phân biệt Shape và Track; track dùng nội suy. **Suy luận cho PointSnap:** phải nghiệm thu việc dựng box theo đúng phiên bản CVAT, bao gồm outside, frame xóa, thuộc tính và biên job. Test tự viết phép nội suy chưa chứng minh nó khớp cvat-core. Nguồn [annotations-history](https://github.com/cvat-ai/cvat/blob/develop/cvat-core/src/annotations-history.ts) và [annotations-collection](https://github.com/cvat-ai/cvat/blob/develop/cvat-core/src/annotations-collection.ts) là mã upstream để tham khảo; nhánh develop không thay cho bản đã triển khai. Trong lần nghiên cứu này chưa đọc được URL nguồn pin v2.75.x, nên chưa xác minh tương thích theo version bằng nguồn từ xa.

[ASAM OpenLABEL](https://www.asam.net/fileadmin/Standards/OpenLABEL/ASAM_OpenLABEL_BS_V1-0-0.html) định nghĩa cuboid bằng tâm, rotation, kích thước và hệ tọa độ. **Đề xuất thiết kế:** metadata phải ghi rõ đơn vị, trục, hệ sensor/ego/world, rotation convention và timestamp. Không đổi công thức Euler hiện tại chỉ để giống OpenLABEL: adapter CVAT cần giữ đúng convention của CVAT rồi mới chuyển sang schema trung gian.

[PCD của PCL](https://pointclouds.org/documentation/tutorials/pcd_file_format.html) quy định FIELDS/SIZE/TYPE/COUNT, ba dạng ASCII/binary/binary_compressed và hai kích thước nén/giải nén của LZF. **Hệ quả kỹ thuật:** parser phải xác nhận đúng số byte/schema trước khi xem dữ liệu là point cloud hợp lệ. SCAN-03 trong audit là lỗi integrity, không cần mô hình AI mới để sửa.

## 2. Ground: chọn bằng sai số dưới box và coverage

[GroundGrid](https://arxiv.org/html/2405.15664v1) phân biệt ground segmentation với terrain estimation, dùng elevation/confidence và thông tin trước đó. Bài báo đánh giá hai bài toán riêng. [Mã tác giả](https://github.com/dcmlr/groundgrid/blob/main/README.md) có hệ phụ thuộc native/ROS. **Đề xuất:** làm baseline ngoại tuyến, đo residual cao độ tại các góc/đáy box và coverage; không lấy IoU ground hoặc tốc độ native trong bài báo làm cam kết cho JS chạy browser.

[Patchwork++](https://arxiv.org/abs/2207.11919) đề xuất xử lý vùng ground không được phân đoạn đủ, mặt nhiều tầng và nhiễu phản xạ; có [mã chính thức](https://github.com/url-kaist/patchwork-plusplus). **Đề xuất:** dùng như baseline ground mask/điểm hỗ trợ, sau đó kiểm riêng mặt đất dưới box. Không mặc định bộ ngưỡng của sensor trong paper đúng cho LiDAR của đội.

[TerraSeg, CVPR 2026](https://arxiv.org/abs/2603.27344) nghiên cứu ground segmentation tự giám sát trên nhiều sensor; [repository tác giả](https://github.com/tudelft-iv/TerraSeg) công bố checkpoints và yêu cầu CUDA, không chạy CPU-only theo cấu hình phát hành. README phân biệt license mã với weights phi thương mại. **Đề xuất:** chỉ là ứng viên đánh giá ngoại tuyến khi phần cứng và quyền sử dụng phù hợp. Chưa benchmark, không đề nghị thay core JS bằng model này ngay. PDF CVF trả 403 trong phiên; kết luận ở đây dựa trên abstract và README, không dùng bảng điểm paper để xếp hạng.

Các con số từ ba nghiên cứu không thể so trực tiếp để tuyên bố thuật toán nào tốt nhất cho PointSnap: khác dataset/protocol/hardware và mục tiêu. Nâng terrain hiện tại cần thêm loại ground quan sát/nội suy, số góc có điểm hỗ trợ, signed bias, p95 sai số và tỉ lệ từ chối đo; confidence heuristic chưa phải xác suất nhãn đúng.

## 3. Chuyển động và heading cần có mức tin cậy

[Open3D ICP](https://www.open3d.org/docs/release/tutorial/pipelines/icp_registration.html) dùng fitness và inlier RMSE để đánh giá registration, minh họa tác động của khởi tạo và refinement. **Đề xuất cho ICP 2D hiện có:** báo chất lượng khớp, phần điểm hỗ trợ và frame pose suy đoán; đánh giá sai số so pose thật nếu có. Không suy rằng quality trên một ngưỡng bảo đảm ego pose đúng, nhất là đường lặp cấu trúc hoặc ít nền tĩnh.

[AV2 Sensor](https://argoverse.github.io/user-guide/datasets/sensor.html) có pose ego 6DOF và quy định point cloud/annotation trong hệ egovehicle. [AV2 HD Maps](https://argoverse.github.io/user-guide/api/hd_maps.html) mô tả ground-height raster cho Sensor dataset. **Đề xuất:** tận dụng metadata này làm oracle ngoại tuyến, kiểm transform trước; raster không phải ground truth hoàn hảo cho mọi bề mặt hoặc ngoài ROI.

[nuScenes evaluation](https://github.com/nutonomy/nuscenes-devkit/blob/master/python-sdk/nuscenes/eval/detection/README.md) tách translation, scale, orientation và attribute; orientation của barrier đối xứng 180°, cone không chấm heading. **Đề xuất:** mỗi class trong spec cần symmetry và applicability riêng. Lỗi cả track quay ngược cần bằng chứng về chuyển động/ảnh, không chỉ so yaw giữa các keyframe. Các chỉ số detection của nuScenes không phải chỉ số QA và không nên bê nguyên thành thước đo lỗi nhãn.

## 4. Cách làm việc mạnh trong các công cụ cùng lĩnh vực

[Segments.ai batch mode](https://docs.segments.ai/how-to-annotate/label-3d-point-clouds/batch-mode-for-dynamic-objects) cho xem cùng object ở nhiều frame. [Smart propagation](https://docs.segments.ai/how-to-annotate/label-3d-point-clouds/smart-cuboid-propagation) công bố giới hạn khi ít điểm hoặc chuyển động bất thường. **Đề xuất:** sau khi sửa integrity, ưu tiên so trước/sau và nhiều frame của cùng vật; propagation cần preview, confidence và dừng/Undo. Chưa có dữ liệu so thời gian người dùng của PointSnap với sản phẩm này.

[SUSTechPOINTS](https://github.com/naurril/SUSTechPOINTS) công bố chỉnh box 9DoF, auto/interactive fitting, batch và ảnh camera. **Suy luận:** fit cuboid vào mặt nhìn thấy, thao tác theo track và camera là các mốc tính năng đáng so. Danh sách tính năng không chứng minh độ chính xác, độ ổn định hay hiệu quả của bất kỳ công cụ nào trong hệ CVAT của đội.

**Đề xuất ưu tiên phát triển:** (1) mọi thao tác sửa phục hồi được; (2) box/track đúng hợp đồng; (3) fit theo mặt LiDAR quan sát được, giữ phần amodal theo spec; (4) gợi ý vùng chưa có box; (5) heading theo chuyển động khi đủ bằng chứng; (6) batch/re-review/camera giúp QC quyết định nhanh hơn. Mỗi bước chỉ nâng thành tính năng chính sau benchmark và pilot.

## 5. Kiểm chứng thay cho nhận xét “tốt nhất”

[GroupKFold](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html) minh họa chia tập theo group không chồng nhau. **Đề xuất của audit:** tách theo scene/log trước khi tune; frame gần nhau cùng track không là mẫu độc lập. Dữ liệu đã dùng điều chỉnh luật trong báo cáo nội bộ chỉ là development, không là holdout mới.

[NIST về khoảng tin cậy tỉ lệ](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) cung cấp Wilson interval. **Đề xuất:** báo số mẫu và khoảng bất định cho precision/recall, đồng thời bootstrap theo scene khi mẫu tương quan. Không dùng một tỉ lệ 3/3 hoặc 36 lỗi cài để cam kết chất lượng sản xuất.

[Playwright extension testing](https://playwright.dev/docs/chrome-extensions) yêu cầu persistent Chromium context cho extension. **Đề xuất:** một môi trường QA tách biệt có thể chạy E2E mà không đưa dependencies vào runtime. Phải kiểm Save/reload, Undo, nhiều tab và đổi người dùng; parse syntax không kiểm các tương tác này.

[MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) mô tả chuyển quyền sở hữu ArrayBuffer sang worker. **Đề xuất:** nếu profiler chứng minh build terrain/fit chặn main thread, dùng Worker và buffer snapshot thuộc PointSnap; không transfer buffer mà CVAT renderer đang sở hữu vì bên gửi sẽ bị detach.

[CVAT user roles](https://docs.cvat.ai/docs/account_management/user-roles/) là nguồn tham khảo chính sách upstream. **Đề xuất triển khai:** chốt QC toàn hệ thống hay theo project/organization; một service token đọc được dữ liệu không tự chứng minh người dùng hiện tại cũng có quyền đó (WF-06). Đây là lựa chọn phân quyền cụ thể, không phải yêu cầu thêm nhiều lớp công nghệ.

## 6. Phương pháp và giới hạn

- Áp dụng workflow `deep-research`, `engineering-architecture`, `engineering-system-design`, `engineering-code-review`, `engineering-testing-strategy`; đối chiếu với source và probe tại `e845e7d`.
- Firecrawl/Exa không có trong toolset phiên này; dùng công cụ web có sẵn để tìm và đọc nguồn sơ cấp thay thế. Có 14 truy vấn tìm kiếm; các liên kết thành công dùng trong phân tích đều đặt cạnh nhận xét tương ứng. Không dùng URL lỗi tải hoặc tên paper như bằng chứng hiệu năng đã kiểm.
- Mức tin cậy cao cho các probe và hành vi source đã đọc; trung bình cho lựa chọn kiến trúc đề xuất; chưa đủ bằng chứng để xếp hạng sản phẩm, độ chính xác production hoặc mức tiết kiệm phút của người dùng.
- Chưa cài/chạy baseline ngoại tuyến, tải dataset, tải model, thử CVAT thật hay phỏng vấn QC. Những việc này nằm trong kế hoạch nghiệm thu, chưa được hoàn thành bằng lần nghiên cứu này.
