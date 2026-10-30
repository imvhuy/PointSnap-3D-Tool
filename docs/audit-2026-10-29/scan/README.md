# Kiểm toán pipeline quét QC

Ngày: 29/10/2026. Baseline: `e845e7d`. Áp dụng `engineering-code-review` và `engineering-testing-strategy`.

## Kết luận

Pipeline có cấu trúc phù hợp để tiếp tục: đọc CVAT qua một client, tái sử dụng luật hình học của extension, có coverage cho dữ liệu không đọc được, và tách các heuristic chuyển động khỏi phép đo từng box. Tuy nhiên chưa đạt mức có thể tin vào mọi kết quả quét. Bốn tình huống sai đã được tái hiện bằng dữ liệu tổng hợp; quan trọng nhất là kết quả `pass` dù không đọc được frame nào. `pass` ở đây là trường `summary.gate.verdict` của bộ quét; không phải bằng chứng endpoint hoàn thành job đã tự duyệt nhãn.

Không sửa mã sản phẩm, không gọi CVAT thật, không đọc cấu hình bí mật. Probe chạy trên Node v24.20.0. Không đo thời gian tiết kiệm cho QC hay độ chính xác trên dữ liệu sản xuất.

## Tái hiện

Từ thư mục gốc repository:

```powershell
node docs/audit-2026-10-29/scan/probes.cjs
```

Kết quả đã lưu tại [results.json](results.json). Script dùng assertions xác nhận **hành vi lỗi của baseline**, nên exit 0 có nghĩa các lỗi đã được tái hiện; không có nghĩa sản phẩm đạt yêu cầu. Khi sửa sản phẩm, cần chuyển từng case sang regression test khẳng định hành vi mong đợi và cập nhật probe kiểm toán.

## Lỗi đã xác nhận

| ID | Ưu tiên | Nguồn | Tình huống / thực tế | Hành vi cần có |
|---|---|---|---|---|
| SCAN-01 | P1 | `qc/lib/scan.js:170`, `:173`, `:253`, `:260` | Cả bốn frame trả CVAT 500. Coverage ghi đủ bốn frame thiếu, `boxes=0`, `summary.objects=0`, nhưng `gate.verdict='pass'`; `result.objects` vẫn chứa một object. | Kết quả có trạng thái không kiểm đủ (`incomplete`) hoặc tương đương; tách số object có nhãn với object đã đo. Coverage là điều kiện độc lập với số finding. |
| SCAN-02 | P2 | `qc/lib/scan.js:170`, `:207`, `:273`; `qc/lib/trackrules.js:304` | Hai track chỉ xuất hiện ở các frame 0–2 đã xóa; frame 3 còn lại không có box. Per-box bỏ qua đúng, nhưng luật duplicate và objectSummary vẫn dùng `frames` chưa lọc: báo lỗi duplicate ở 0–2 và yêu cầu duyệt hai object. | Một tập frame hợp lệ dùng thống nhất cho phép đo, luật nhiều frame, tóm tắt và tiến độ. Frame đã xóa không tạo lỗi nhãn. |
| SCAN-03 | P2 | `qc/lib/pcd.js:8`, `:28`, `:91` | PCD compressed khai báo 12 byte raw nhưng luồng LZF chỉ tạo 1 byte. `Buffer.alloc` điền phần thiếu bằng 0, hàm vẫn trả điểm `[0,0,0]` như điểm hợp lệ. | Kiểm tra đủ byte input/output, raw size đúng schema, bounds và giới hạn cấp phát; PCD hỏng phải thành coverage error, không thành điểm giả. |
| SCAN-04 | P2 | `qc/lib/scan.js:25` | Track có một keyframe yaw=0 ở frame 0, outside từ frame 1, trở lại frame 5–7 với yaw=π ổn định. `trackFindings` lọc bỏ keyframe outside rồi nối hai đoạn, báo `heading.jump` ở frame 0. | Chia theo đoạn visible như `TrackRules.segments`; không suy luận biến thiên hướng qua khoảng mất dấu. Đoạn một keyframe phải được coi là không đủ bằng chứng. |

SCAN-02 không đòi file point cloud bị thiếu hoặc file hỏng. SCAN-03 là tình huống corruption do chủ động tạo, không có bằng chứng dữ liệu CVAT của người dùng hiện đang bị lỗi này. SCAN-04 chứng minh một cảnh báo không có bằng chứng hướng nhảy trong đoạn visible; không suy rộng thành mọi cảnh báo heading đều sai.

## Trạng thái từng module

| Module | Điểm tốt quan sát từ mã / test hiện có | Giới hạn còn phải giải quyết |
|---|---|---|
| `cvat.js` | Client tập trung, timeout request, phân trang, chỉ đọc | Chưa có contract fixture CVAT trong test cho thứ tự PCD trong chunk, job bắt đầu khác 0, frame step, job split. Hủy scan chưa truyền xuống fetch; chưa có giới hạn kích thước body tải. Đây là rủi ro cần kiểm chứng, không khẳng định mapping đang sai. |
| `zip.js` | Đọc central directory, hỗ trợ stored/deflate | Chưa kiểm CRC, giới hạn giải nén và validation toàn bộ offset/length. Cần reject corruption rõ ràng và cap tài nguyên thay vì chỉ dựa exception Buffer. |
| `pcd.js` | Có ASCII, binary, binary_compressed, bỏ NaN/Infinity | SCAN-03; binary hiện cắt theo số byte còn lại thay vì reject file thiếu; metadata thiếu bounds cho POINTS/COUNT/SIZE. |
| `tracks.js` | Tách raw annotation → frame; nội suy góc theo cung ngắn; tích lũy mutable attributes; có unit test outside | Tính “giống CVAT” mới được test bằng fixture tự viết. Cần đối chiếu đầu ra `cvat-core` cùng phiên bản cho các cạnh job và frame filters. |
| `scan.js` | Dùng chung `measureBox/checkBox`, gộp finding theo object/luật/cặp, giữ coverage | SCAN-01/02/04; raw frame thiếu không đồng nghĩa phép kiểm hoàn thành. |
| `trackrules.js` | Có phân đoạn outside cho motion, ghép Hungarian, lọc nhiều track cùng nhảy | Heuristic phụ thuộc mật độ keyframe và chuyển động ego; độ nhạy/độ chính xác chưa có đánh giá độc lập rộng. `validateQc` mới kiểm mọi số hữu hạn ≥0; nên thêm miền tỉ lệ 0–1 và số frame nguyên dương. |
| `icp.js` | Tìm thô + refine, ngưỡng match quality, công bố `weak` frames | Chỉ 2D. `chain` thay phép biến đổi yếu bằng bước tốt gần nhất; rule dùng `poses` dù có bước suy đoán. Cần truyền chất lượng/confidence vào từng kết luận, thay vì coi mọi pose có cùng độ tin cậy. Đây là giới hạn thiết kế đã thấy từ mã. |
| `evidence.js` | Có ba kết luận one/two/unknown và số điểm; không ép unknown thành xác nhận | Lift/link/minPts đang là heuristic cố định; cụm tường/cây/vật chưa gán có thể ảnh hưởng kết luận. Cần holdout junction có ground truth và sensitivity analysis, không coi “một cụm” là chứng minh một vật. |
| `rules.js` | Resolve shared guideline + QC defaults, có validate trước dùng | Bounds của QC threshold còn yếu; version guideline phải là một phần contract khi so scan trước/sau. |

## Bằng chứng chất lượng sẵn có và điều chưa biết

[Thử nghiệm hai vòng](../../qc-thu-nghiem-2-vong.md) tự ghi rõ QC/annotator đều là script, bước login bỏ qua, 36 lỗi được cài trên một scene. Sau sửa thuật toán trên cùng dữ liệu/seed, kết quả trỏ đúng chỗ 28/36, đúng loại 25/36. Không chuyển các số đó thành độ chính xác sản xuất hoặc mức tiết kiệm thời gian cho người thật.

Tài liệu cũng ghi nhận: cả track quay ngược không bắt được, sai kích thước cả track trong khoảng class không bắt đúng loại, vật hoàn toàn thiếu không tự phát hiện. Phiếu thiếu vật của bản UI sau đó là cơ chế ghi nhận và chặn hoàn thành theo phiếu; không bổ sung bộ phát hiện vật chưa gán.

Tài liệu đo luật box nhảy trên bốn job có 48 lỗi cài mỗi cỡ: phát hiện 29/48 ở lệch 1 m, 39/48 ở 1,5 m, 42/48 ở 2 m; mục nghi báo nhầm trên nhãn chuẩn tăng 3→5 và hai mục mới chưa xác minh. Đây là trade-off thực tế, chưa có tập holdout độc lập hoặc khoảng bất định theo scene.

## Tiêu chí nghiệm thu đề xuất

1. **Integrity trước:** mọi frame/chunk thiếu hoặc hỏng được xác định; kết quả không có `pass` khi phép kiểm bắt buộc chưa chạy. Tách `annotationQuality`, `coverage` và `humanReviewCompletion`.
2. **Frame mask thống nhất:** một fixture deleted-frame phải cho zero finding và zero review object trên frame bị xóa. Kiểm cả shape, track, outside, duplicate và tóm tắt.
3. **PCD/ZIP:** corpus hợp lệ ba dạng, mọi kích thước COUNT; corpus hỏng (truncated header/payload/LZF, offsets sai, raw mismatch, CRC mismatch) phải trả lỗi có kiểm soát. Cap compressed/raw bytes, point count, thời gian và bộ nhớ.
4. **CVAT contract:** fixtures xuất từ các phiên bản CVAT mà đội thực sự hỗ trợ. So sánh box/frame/attribute với cvat-core; bao phủ job start≠0, split/overlap, outside/reentry, deleted, frame_step và thứ tự file. Không mở rộng hỗ trợ phiên bản chỉ vì unit test xanh.
5. **Domain holdout:** tách cảnh trước khi chỉnh threshold; báo precision/recall theo loại lỗi, class, khoảng cách, density, độ che và ego-motion. Dùng mẫu lỗi thật do hai QC xác nhận; lỗi cài chỉ là phần bổ sung. Báo cả khoảng bất định theo scene và số lỗi không thể kiểm.
6. **ICP/evidence:** đánh giá với pose thật nếu có; perturb pitch/roll/độ dốc, nền ít cấu trúc và nhiều vật động. Rule qua weak pose phải được gắn nhãn thiếu bằng chứng, không âm thầm dùng như pose đo được.
7. **Load/cancel:** job nhiều frame/box, point cloud lớn; đo peak RSS, p50/p95 thời gian, độ phản hồi API khi quét, cancel latency. Giá trị ngân sách cần chốt theo máy triển khai và job thực tế trước khi đặt SLA.
8. **Pilot người thật:** cùng dữ liệu/độ khó, đo phút/object, số lần đổi màn, số lỗi bỏ sót sau nghiệm thu, tỷ lệ phiếu trả lại, độ đồng thuận QC. Không dùng số lượt API hoặc lượt mở object để thay cho số phút người dùng.

## Thứ tự làm

- Pha 1: sửa SCAN-01/02/03/04, thêm regression tests đúng hành vi mong đợi; chốt schema coverage và frame mask.
- Pha 2: CVAT contract + giới hạn parser/network; confidence cho ICP/evidence; benchmark tải và hủy quét.
- Pha 3: holdout độc lập và pilot người thật; sau đó mới chọn nâng cấp thuật toán fit LiDAR, heading theo chuyển động, gợi ý cụm điểm thiếu box.

Không có bằng chứng từ lần kiểm toán này để xếp PointSnap “tốt nhất lĩnh vực”. Có thể đặt mục tiêu cụ thể hơn: bảo toàn nhãn, đầu ra kiểm tra có coverage rõ, và giảm thời gian QC trên dữ liệu của đội mà không tăng lỗi sau nghiệm thu.
