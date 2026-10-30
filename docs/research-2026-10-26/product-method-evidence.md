# Bằng chứng sản phẩm và phương pháp đánh giá

**Truy cập:** 26/10/2026. **Phương pháp:** 8 truy vấn; giữ 8 nguồn dưới đây, gộp URL HTML/raw của cùng nội dung. Tài liệu sản phẩm là mô tả do đơn vị phát triển công bố; nghiên cứu này không trực tiếp chạy các sản phẩm để so tốc độ hoặc chất lượng.

## P01 — SUSTechPOINTS

- [Repository chính thức](https://github.com/naurril/SUSTechPOINTS).
- Bằng chứng: công cụ công bố chỉnh box 9 DoF, batch edit, box fitting, tô màu điểm và chế độ focus.
- Bài học đề xuất: lấy chuỗi thao tác chỉnh một track làm đơn vị thiết kế UX. Không suy ra PointSnap cần thay CVAT hoặc có thể chuyển mã mà không đánh giá việc tích hợp.
- Giới hạn: danh sách tính năng không phải benchmark độc lập.

## P02 — Segments.ai: cuboid interface

- [3D point cloud cuboid interface](https://docs.segments.ai/how-to-annotate/label-3d-point-clouds/3d-point-cloud-cuboid-interface).
- Bằng chứng: có kích thước mặc định theo category; tách simple/smart/AI initialization; auto-adjust giữ orientation và có giới hạn về ground/outlier.
- Bài học đề xuất: mỗi nút sửa của PointSnap công bố phần hình học sẽ đổi và điều kiện bằng chứng; preset theo class hỗ trợ thao tác nhưng không chứng nhận nhãn đúng.
- Giới hạn: chưa đánh giá thuật toán nội bộ hay precision của dịch vụ.

## P03 — Segments.ai: batch mode

- [Batch mode for dynamic objects](https://docs.segments.ai/how-to-annotate/label-3d-point-clouds/batch-mode-for-dynamic-objects).
- Bằng chứng: một đối tượng có thể được quan sát qua nhiều frame trong cùng chế độ; hỗ trợ chọn frame và keyframe interpolation.
- Bài học đề xuất: làm dải track có context và ưu tiên keyframe bất thường; cân nhắc thumbnail/batch view sau khi kiểm ngân sách bộ nhớ.
- Giới hạn: không lấy lời giới thiệu hiệu quả làm mức tăng năng suất đã đo cho PointSnap.

## P04 — Segments.ai: QA process

- [Manage QA processes](https://docs.segments.ai/guides/manage-qa-processes).
- Bằng chứng: mô tả vòng rejected → labeler sửa → reviewer kiểm lại; có lint qua API/webhooks và trạng thái Verified. Kiểm unlabeled points được giới hạn ở segmentation.
- Bài học đề xuất: tách tiến độ annotator, finding review và chấp nhận job. PointSnap cần lưu revision để vòng nộp lại có ngữ cảnh.
- Giới hạn: không coi kiểm segmentation là bằng chứng QC cuboid đã bao phủ đầy đủ.

## P05 — LATTE

- [LATTE, Wang và cộng sự, 2019](https://arxiv.org/abs/1904.09085).
- Bằng chứng: bài nghiên cứu giải quyết LiDAR thưa, thao tác 3D phức tạp và sự lặp giữa frame bằng sensor fusion, one-click annotation và tracking.
- Bài học đề xuất: đo giảm thao tác theo track và chất lượng sau sửa. Tốc độ tăng trong nghiên cứu gốc không là dự báo cho PointSnap.
- Giới hạn: nghiên cứu nền tảng cũ; chưa tái lập thí nghiệm ở đây.

## M01 — Chia dữ liệu theo nhóm

- [GroupKFold, scikit-learn](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html).
- Bằng chứng: các fold dùng group không giao nhau; mỗi group xuất hiện trong test một lần qua các fold.
- Đề xuất: group theo scene/log cho phát triển luật; khóa một bộ kiểm tra mới trước tinh chỉnh. Các track cùng cảnh không được phân tán tùy tiện để tạo ấn tượng kiểm tra độc lập.
- Giới hạn: chọn group theo scene là quyết định của thiết kế đánh giá PointSnap, không phải kết quả benchmark do scikit-learn cung cấp.

## M02 — Khoảng tin cậy cho tỷ lệ

- [NIST: Confidence intervals for proportions](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
- Bằng chứng: NIST trình bày Wilson và khoảng chính xác cho tỷ lệ, gồm trường hợp mẫu nhỏ/ít lỗi.
- Đề xuất: báo precision cùng mẫu số và bất định. Với finding phụ thuộc theo track/scene, cần xử lý cấu trúc nhóm khi ước lượng; chỉ lấy nhiều frame từ một track không tạo thêm từng ấy quan sát độc lập.
- Giới hạn: khoảng thống kê không khắc phục mẫu chọn thiên lệch hoặc đáp án review chưa đáng tin.

## M03 — nuScenes detection metrics

- [Detection task — official devkit](https://github.com/nutonomy/nuscenes-devkit/blob/master/python-sdk/nuscenes/eval/detection/README.md).
- Bằng chứng: matching AP dùng khoảng cách tâm 2D; ATE cũng là khoảng cách 2D. Orientation có quy ước theo class, chẳng hạn barrier khác cone.
- Suy luận: đánh giá lỗi Z-grounding cần thêm sai số đáy theo trục đứng và coverage; chỉ báo mAP/NDS không trực tiếp chứng minh phép đo đáy chính xác.
- Giới hạn: benchmark detection và kiểm nhãn là hai mục tiêu đánh giá khác nhau.

## Đối chiếu cục bộ đáng chú ý

1. [split.py](../../pointsnap/eval/split.py) liệt kê `scene-1077` và `scene-1100` trong TEST_SCENES. [Pain point, mục PP-07 và 6.3](../pain-points-va-giai-phap.md) ghi đã nới ngưỡng extension sau khi kiểm các cảnh này và tham khảo 10 cảnh mini. Vì vậy, đối với bộ luật extension tương lai dùng chung cho QC, đây không còn là tập kiểm chưa được quan sát. Nhận xét này không khẳng định mọi ngưỡng Python đã được chỉnh trên các cảnh ấy.
2. [Bài toán bàn giao](../BAI_TOAN_VA_BAN_GIAO_PHAT_TRIEN.md) và [thiết kế QC](../qc-scan-phan-tich-thiet-ke.md) xác định CVAT là nền tảng mục tiêu. So sánh ở P01–P05 dùng để học cách thao tác và tổ chức review; chưa có cơ sở kinh tế hoặc yêu cầu di chuyển sang nền tảng khác.
3. Các mục tiêu SLO, số job pilot và ngưỡng phát hành trong kế hoạch nghiên cứu là đề xuất cần kiểm; không lấy từ kết quả của các sản phẩm tham khảo.

## Nhật ký truy vấn của phần tổng hợp

1. SUSTechPOINTS: annotation features / auto rotate / tracking.
2. Segments.ai: point cloud cuboid annotation / review quality.
3. CVAT: 3D annotation / quality validation / issues; nguồn chuyển cho nhóm CVAT để kiểm sâu.
4. nuScenes: center-distance mAP / NDS.
5. Segments.ai: batch mode dynamic objects.
6. scikit-learn: GroupKFold non-overlapping groups.
7. NIST: binomial proportions / Wilson intervals.
8. SUSTechPOINTS: batch editing guide / auto fit.

Đã mở trang gốc cho các nguồn giữ lại; trang nuScenes chạy JavaScript được đối chiếu bằng README devkit chính thức. Bài LATTE được đọc phần abstract gốc; không tuyên bố đã tái lập hoặc phân tích toàn bộ thí nghiệm trong PDF. Bỏ các kết quả diễn đàn và bài tổng hợp không cần thiết khỏi căn cứ kỹ thuật.
