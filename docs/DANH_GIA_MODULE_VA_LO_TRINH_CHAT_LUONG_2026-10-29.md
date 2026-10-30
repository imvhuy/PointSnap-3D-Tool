# PointSnap 3D — Đánh giá module và lộ trình chất lượng

**Ngày:** 29/10/2026, Asia/Saigon. **Mã được đánh giá:** `e845e7d8cc258acd35e89925212cbea51cdac749` trên `main`.

## 1. Kết luận dành cho chủ dự án

**Dự án có kiến trúc phù hợp để phát triển tiếp, nhưng chưa hoạt động đúng trong một số tình huống quan trọng và chưa đủ bằng chứng để gọi là tốt nhất trong lĩnh vực.** Cần ưu tiên độ an toàn của thao tác sửa nhãn, tính mới của dữ liệu nghiệm thu và độ nhất quán của phiếu trước khi mở rộng thuật toán.

Đợt này chạy lại **167 test hiện có, 167 đạt**, trong đó 25 test chỉ kiểm cú pháp script. Các phép thử bổ sung vẫn tìm được lỗi vì bộ test cũ chủ yếu bao phủ ca tuần tự và đầu vào thông thường. “Test xanh” không có nghĩa mọi tình huống đều đúng.

Có **18 ca kiểm tra bổ sung** được lưu: 6 ca geometry/cache thuộc 5 nhóm; 4 ca scan; 7 ca workflow, trong đó 1 ca phụ thuộc chính sách phân quyền; 1 ca identity ở plugin cần thêm contract/E2E. Không diễn giải con số này như 18 lỗi độc lập hoặc thống kê độ chính xác của sản phẩm.

**Thay đổi trong đợt đánh giá:** chỉ tạo tài liệu và script/bằng chứng audit dưới `docs/`; chưa sửa mã sản phẩm. Các probe chạy với dữ liệu tổng hợp, CVAT giả hoặc VM; chưa thực hiện thử nghiệm trình duyệt hay nhãn trên hệ CVAT thật của người dùng.

## 2. Phạm vi và bằng chứng

Skill áp dụng: `engineering-code-review`, `engineering-testing-strategy`, `engineering-architecture`, `engineering-system-design`, `deep-research`. Đọc hướng dẫn `CLAUDE.md`; giữ ràng buộc runtime JavaScript/Node stdlib và tài liệu tiếng Việt. Không có `AGENTS.md` trong cây project được kiểm tra. Workflow nghiên cứu dùng ba nhánh rà soát độc lập rồi đối chiếu tại phiên chính.

| Tài liệu/bằng chứng | Nội dung |
|---|---|
| [Geometry review](audit-2026-10-29/geometry/REVIEW.md) | Hình học, terrain, fit, thao tác track, adapter và cache; vị trí mã và nghiệm thu |
| [Scan review](audit-2026-10-29/scan/README.md) | CVAT client, ZIP/PCD, frame, scan, ICP, evidence và heuristic track |
| [Workflow review](audit-2026-10-29/workflow/REPORT.md) | Router thật với CVAT giả: completion, ID, concurrent request, fingerprint và quyền |
| [Integration review](audit-2026-10-29/integration/REVIEW.md) | Identity shape/track, API extension cũ và plugin CVAT mới |
| [Nghiên cứu đối chiếu](audit-2026-10-29/NGHIEN_CUU_DOI_CHIEU.md) | Nguồn sơ cấp, phương pháp ground/ICP, trải nghiệm cùng lĩnh vực và protocol đánh giá |
| [Kế hoạch nghiệm thu](audit-2026-10-29/KE_HOACH_NANG_CAP_VA_NGHIEM_THU.md) | Backlog theo phụ thuộc, quyết định kiến trúc và điều kiện đóng từng giai đoạn |
| [Log test gốc](audit-2026-10-29/baseline-tests.tap) | 167 test đạt trên Node v24.20.0 |

Các script audit assert **hành vi sai đang tồn tại**, nên exit 0 nghĩa là đã tái hiện lỗi, không phải sản phẩm đạt. Khi sửa mã, phải chuyển các case này thành regression test kỳ vọng hành vi đúng. Không cộng probe vào số 167 test.

## 3. Các lỗi ưu tiên cao

P1: xử lý trước khi coi luồng bị ảnh hưởng đủ tin cậy để triển khai rộng. P2: cần sửa, có thể theo sau P1 nếu đã giới hạn rõ miền sử dụng. Không có bằng chứng trong đợt này để khẳng định hệ thống thật đã mất dữ liệu hoặc bị truy cập trái phép.

| ID | Mức | Ca đã tái hiện | Tác động và hướng sửa |
|---|---|---|---|
| GEO-01 | P1 | Lưu nhiều keyframe lỗi ở frame 1: frame 0 đã ghi nhưng hàm không trả Undo record; CVAT history đang bị tạm ngừng | Sửa dở không có journal mới để phục hồi. Lập journal trước ghi, rollback hoặc giữ journal lỗi; refresh lỗi cũng không được làm mất journal. `extension/src/annotator/cvat-adapter.js:147` |
| GEO-02 | P1 trong miền box nghiêng | Box pitch 30°, dài 4→6 m, đáy thấp đi 1 m sau đồng bộ cỡ | Chốt hợp đồng upright/OBB; tính bù Z từ các góc thế giới hoặc từ chối rõ box ngoài miền hỗ trợ. `track-ops.js:33` |
| GEO-04a/b | P1 | Đổi car→pedestrian cùng hình học vẫn nhận số đo cached car; thay kích thước keyframe khác với cùng count cũng không tính lại | Checklist có thể bỏ sót lỗi. Invalidate bằng revision dữ liệu, bao gồm semantic và nội dung track; không chỉ keyframe count. `annotator.js:153` |
| SCAN-01 | P1 | Toàn bộ 4 frame tải point cloud lỗi, `boxes=0`, nhưng `summary.gate.verdict='pass'` | Trường này hiện được web diễn đạt là “Ít vấn đề”, không tự động hoàn thành job; vẫn là hợp đồng sai khi thiếu dữ liệu. Tách quality/coverage/human completion. `qc/lib/scan.js:253` |
| WF-01 | P1 | Sau scan/duyệt, CVAT giả sửa A và thêm B; `/complete` vẫn 200 và không đọc lại nhãn | Nghiệm thu snapshot cũ. Đối chiếu version/digest annotation và spec, bắt buộc scan/review phù hợp trước hoàn thành. `qc/server.js:399` |
| WF-03 | P1 | Thu hồi `BUG-101` rồi tạo phiếu cho vật khác: ID lại là `BUG-101`; tab cũ nộp nhầm phiếu mới | Định danh phiếu phải bất biến; dùng ID không tái dùng và giữ tombstone thu hồi. `qc/lib/store.js:97`, `qc/server.js:226` |
| WF-04 | P1 | Request nộp chờ đọc CVAT; QC nghiệm thu; request cũ chạy tiếp chuyển `accepted` về `submitted` | Điều kiện kiểm trước await bị lỗi thời. Version/CAS hoặc serialize theo phiếu, kiểm lại trước commit. `qc/server.js:238` |

Bằng chứng cụ thể: [geometry/results.json](audit-2026-10-29/geometry/results.json), [scan/results.json](audit-2026-10-29/scan/results.json), [workflow/probe-results.json](audit-2026-10-29/workflow/probe-results.json).

## 4. Các phát hiện còn lại

| ID | Mức/phạm vi | Kết quả | Nghiệm thu cần có |
|---|---|---|---|
| GEO-03 | P2, box nghiêng | Broad phase dùng footprint yaw bỏ điểm nằm thật trong OBB roll/pitch | Mọi điểm thuộc OBB phải có trong tập ứng viên; lấy AABB từ 8 góc rồi lọc local, hoặc chặn miền chưa hỗ trợ |
| GEO-05 | P2 | Cùng frame/cloud, đổi box loại điểm nhưng terrain cache vẫn 100 ô đất; tính mới còn 0 | Phiên bản terrain theo exclusion mask; không snap từ terrain lỗi thời |
| SCAN-02 | P2 | Frame đã xóa vẫn sinh duplicate và object cần duyệt | Dùng chung valid-frame mask cho mọi luật, summary và queue |
| SCAN-03 | P2, dữ liệu hỏng giả lập | LZF thiếu byte vẫn tạo điểm `[0,0,0]` | Reject payload sai/bounds sai, giới hạn dung lượng và ghi coverage error |
| SCAN-04 | P2 | `heading.jump` so xuyên khoảng outside, báo hướng nhảy ở đoạn chỉ có 1 keyframe | Chia visible segments; không kết luận qua khoảng mất dấu |
| WF-02 | P2 | Tạo phiếu thiếu vật sau hoàn thành: complete trả 409 nhưng danh sách job vẫn `done=true` | Một invariant completion dùng chung, invalidation khi dữ liệu hoặc phiếu đổi |
| WF-05 | P2 | Sửa vật B trong phiếu A↔B vẫn báo `unchanged=true` | Fingerprint mọi vật liên quan, kể cả trạng thái xóa; đổi nhãn cảnh báo cho đúng ý nghĩa |
| WF-07 | P2 | Khóa dò mật khẩu `qcuser` không áp dụng cho `qcuser ` dù verify trim | Chuẩn hóa một lần trước rate-limit và xác thực |
| INT-01 | P2, contract edge | Trong mock shape/track trùng serverID, plugin chọn nhầm loại nhưng trả thành công | Identity `(job,kind,serverId)`, thêm E2E đầu vào trùng ID trên bản CVAT mục tiêu |
| WF-06 | P1 nếu có ranh giới project/organization | Tài khoản QC không có quyền CVAT vẫn đọc được scan qua service token chung | Hiện là quyền QC toàn cục theo thiết kế; bảo toàn ACL nếu deployment cần tách project, test mọi endpoint |

Ngoài bảng này, còn các rủi ro chưa gán như lỗi tái hiện: kết luận báo nhầm giữ qua sửa annotation/spec; role trong token chụp ở thời điểm cấp; JSON file chưa có transaction nhiều file; parser thiếu giới hạn tài nguyên; hủy scan chưa lan đầy đủ xuống fetch. Không coi chúng là sự cố đã xảy ra.

## 5. Trạng thái các module chính

| Module | Đánh giá hiện tại | Bước tiếp theo |
|---|---|---|
| `box`, `spatial-grid` | Core transform tách rõ, có test; downstream chưa thống nhất hỗ trợ roll/pitch | Geometry contract và invariants, sửa broad phase/overlap đúng miền |
| `terrain`, `measure`, `object-points`, `checks` | Có ground/no-evidence, connected points và rule thuần; cache và mức tin cậy còn khoảng trống | Sửa cache; hiệu chuẩn ground/fit trên sensor/địa hình thực, đo coverage cùng sai số |
| `track-ops`, `cvat-adapter`, `annotator` | Plan/preview tách khỏi ghi là nền tốt; lỗi ghi dở và stale measurement ảnh hưởng nhãn | Journal/rollback, revision, contract Save/Undo/reload trên CVAT thật |
| `cvat`, `zip`, `pcd`, `tracks` | Client và parser tập trung; có ba dạng PCD và nội suy | Reject corruption, cap tài nguyên, fixture lấy từ CVAT version hỗ trợ |
| `scan` | Có coverage và gộp finding | Sửa coverage gate, frame mask và visible segments; summary nhất quán |
| `icp`, `trackrules`, `evidence` | Heuristic hữu ích, có Hungarian và unknown evidence | Truyền confidence pose, đánh giá scene/log độc lập, không ép thiếu bằng chứng thành lỗi chắc chắn |
| `rules`, guideline editor | Dùng chung spec, có version/restore | Pin spec vào scan/review/complete; bounds theo ngữ nghĩa, kiểm đồng nhất UI và service |
| `server`, `auth`, `store` | Có role, ticket assignee, token hash/expiry; đủ cho prototype | Sửa completion/ID/race, policy ACL, invariant giao dịch và phục hồi |
| Plugin/web/extension | Có luồng object và nhiều lỗi/phiếu trong CVAT | E2E, identity, đường tích hợp QC rõ ràng, dọn phần backend legacy |

Hai lưu ý về tuyên bố tính năng:

- Annotator tự thêm cảnh báo “Ôm vật” tại controller nhưng scanner không có đúng phép thêm đó. Dùng chung các module đo chưa có nghĩa toàn bộ kết luận UI/QC giống nhau; cần kê rõ rule applicability hoặc hợp nhất phần này.
- Extension standalone đo/sửa nhãn đang có; phần kết nối extension tới API QC mới chưa triển khai đầy đủ. Background/options còn API/cổng Python cũ, còn plugin trong CVAT gọi dịch vụ Node mới. Token UI đã có chưa đồng nghĩa extension đã sử dụng được token. Chi tiết trong [integration review](audit-2026-10-29/integration/REVIEW.md).

## 6. Mức chất lượng thuật toán đã chứng minh

[Thử nghiệm nội bộ hai vòng](qc-thu-nghiem-2-vong.md) dùng scene LiDAR thật nhưng cài lỗi có chủ đích, QC/annotator bằng script. Sau điều chỉnh trên cùng dữ liệu/seed, tool trỏ đúng vị trí 28/36 lỗi và đúng loại 25/36. Đây là bằng chứng phát triển, chưa là đánh giá độc lập trên lỗi thật của nhân viên.

Các giới hạn đã ghi nhận: không tự phát hiện vật hoàn toàn chưa gán box; không nhận ra heading quay ngược toàn track chỉ bằng yaw giữa keyframe; sai cỡ toàn track nhưng vẫn trong khoảng class có thể lọt; frame thiếu ground không đủ bằng chứng kết luận Z. Phiếu thiếu vật giải quyết ghi nhận công việc, không giải quyết bài toán phát hiện vật thiếu.

Nghiên cứu đối chiếu đề xuất thử GroundGrid/Patchwork++ như baseline ngoại tuyến và xem TerraSeg như ứng viên học máy năm 2026, khi điều kiện phần cứng/quyền sử dụng phù hợp. Cần so bằng sai số ground dưới box, coverage, lỗi sửa xấu và thời gian người dùng trên cùng dữ liệu; không bê tốc độ/IoU từ bài báo sang PointSnap. Nguồn và giới hạn ở [nghiên cứu đối chiếu](audit-2026-10-29/NGHIEN_CUU_DOI_CHIEU.md).

## 7. Định nghĩa mục tiêu “hoạt động tốt nhất” cho dự án này

Đề xuất đo theo sáu kết quả cụ thể:

1. **Bảo toàn nhãn:** mọi thao tác ghi có preview, khả năng phục hồi và kiểm xung đột; không để lỗi giữa batch thành sửa âm thầm không Undo.
2. **Kết luận có chứng cứ:** coverage/rule applicability tách khỏi quality; thiếu điểm/pose không được giống kết quả kiểm đủ.
3. **Nghiệm thu đúng dữ liệu:** kết quả gắn với annotation/spec/rule version; ID phiếu không tái dùng, trạng thái chống race.
4. **Độ chính xác theo miền:** precision/recall và lỗi báo nhầm theo rule/class/range/density/occlusion/sensor, trên holdout chưa tune.
5. **Làm việc nhanh hơn:** đo p50/p95 thời gian đến Save, phút/object và lỗi sau nghiệm thu, với người thật và cùng quy trình.
6. **Triển khai có kiểm chứng:** pin CVAT/browser, E2E và phục hồi dữ liệu; phạm vi quyền và nơi lưu dữ liệu rõ ràng.

Không có một thuật toán chung bảo đảm tối ưu mọi sensor/spec. Kế hoạch nâng cấp phải chọn ứng viên theo các kết quả trên. Chi tiết về backlog, thử nghiệm và cổng nghiệm thu nằm trong [kế hoạch thực hiện](audit-2026-10-29/KE_HOACH_NANG_CAP_VA_NGHIEM_THU.md).

## 8. Cách chạy lại và bàn giao

Tại thư mục gốc project, Node ≥20; bằng chứng phiên này tạo bằng Node v24.20.0:

```powershell
node --test qc/test/*.test.js extension/tests/*.test.js
node docs/audit-2026-10-29/geometry/probe.cjs
node docs/audit-2026-10-29/scan/probes.cjs
node docs/audit-2026-10-29/workflow/probe-workflow.js
node docs/audit-2026-10-29/integration/probe.cjs
```

Test gốc có dùng localhost và thư mục tạm. Sandbox Windows đã từng gây EPERM khi rename; lần chạy bằng chứng sử dụng môi trường cho phép thao tác đó. Không bỏ qua một lỗi như “do sandbox” nếu chưa chạy đối chiếu. Probe workflow tiêm config và fetch giả, không đọc `qc/.env.local`, không mở CVAT thật.

Các tài liệu nghiên cứu ngày 26/10 vẫn được giữ nguyên để đối chiếu lịch sử. Chúng tham chiếu backend Python đã gỡ; dùng báo cáo này cùng README hiện tại để mô tả kiến trúc tại `e845e7d`. Các đề xuất trong báo cáo chưa được triển khai và không thay đổi chất lượng runtime chỉ vì tài liệu đã được tạo.
