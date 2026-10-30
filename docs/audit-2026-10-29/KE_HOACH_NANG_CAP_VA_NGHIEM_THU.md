# Kế hoạch nâng cấp và nghiệm thu PointSnap 3D

Ngày 29/10/2026. Trạng thái **đề xuất triển khai**, chưa sửa runtime. Baseline `e845e7d`. Căn cứ: [báo cáo chính](../DANH_GIA_MODULE_VA_LO_TRINH_CHAT_LUONG_2026-10-29.md), các probe trong thư mục này và [nghiên cứu nguồn sơ cấp](NGHIEN_CUU_DOI_CHIEU.md).

## 1. Quyết định kiến trúc đề xuất

### ADR-Q01 — Tiếp tục dùng core JS, quy định rõ hợp đồng

**Bối cảnh:** extension và service đã dùng chung module; runtime không có npm dependencies. Lỗi quan trọng hiện tại phần lớn là dữ liệu/transaction/cache, chưa có bằng chứng phải thay ngôn ngữ để sửa.

**Đề xuất:** giữ core JS thuần; chuẩn hóa input/domain và output evidence. Runtime vẫn Node stdlib/browser APIs. Công cụ benchmark native/model và browser QA chạy tách môi trường, chỉ đưa vào runtime sau khi có bằng chứng về lợi ích và chi phí.

| Lựa chọn | Lợi ích | Đổi lại | Quyết định đề xuất |
|---|---|---|---|
| Củng cố core JS hiện có | Ít rủi ro migration; thống nhất annotator/QC; test lại nhanh | Phải sửa contract và theo dõi version kỹ | Làm trước |
| Đưa mô hình/native trực tiếp vào luồng chính | Có thể nâng coverage/fit | Thêm GPU/build/deployment, latency, điều kiện quyền sử dụng; không tự sửa lỗi workflow | Chỉ sau benchmark |
| Viết lại toàn hệ thống | Có thể chọn framework/storage mới | Mất thời gian tái tạo hành vi, không có dữ liệu cho thấy cần thiết | Chưa có cơ sở chọn |

**Hợp đồng cần có:** `(jobId,kind,serverId)`, frame mask, mét/radian, rotation convention, coordinate frame, annotation revision, guideline/rule version; hỗ trợ upright hay OBB phải thống nhất xuyên pipeline. Không dùng cùng tên “box 3D” cho các hàm có miền khác nhau mà không kiểm tra đầu vào.

### ADR-Q02 — Tách ba trạng thái chất lượng

**Đề xuất schema:** `quality` (finding trong phần kiểm được), `coverage` (đủ/thiếu/không áp dụng/thất bại theo rule), `reviewCompletion` (QC duyệt snapshot nào). Trạng thái hoàn thành gắn với snapshot revision và các phiếu tương ứng; không lấy danh sách finding rỗng hay file done tồn tại làm bằng chứng hoàn tất.

```text
CVAT annotation + frame metadata + guideline/rule revision
                 ↓ snapshot kiểm được định danh
Parser/valid-frame mask → Measure/Rules → Findings + Coverage
                 ↓                           ↓
            Object review ↔ Ticket state/version
                 ↓
Completion = snapshot còn phù hợp + review đủ + phiếu đã nghiệm thu
```

Nếu CVAT thay đổi nhãn sau thời điểm đối chiếu, completion phải trở thành lỗi thời. Nếu không có transaction liên hệ thống, API phải nói rõ mốc snapshot và xử lý stale sau đó; không hứa khóa được CVAT chỉ bằng file JSON cục bộ.

### ADR-Q03 — Kiểm soát ghi trước khi đổi storage

**Đề xuất cho pilot một process:** ID phiếu không tái sử dụng; version mỗi phiếu; serialize/CAS mutation; journal phục hồi cho cập nhật liên quan ticket/object; kiểm điều kiện lại sau await. JSON atomic rename chỉ bảo vệ từng file, không tạo transaction nhiều file.

Khi cần nhiều process/replica hoặc tải đã vượt ngân sách đo được, thiết kế migration sang storage có transaction/constraint. Chưa tự thêm dependency hay DB chỉ để có kiến trúc lớn hơn. Quyền QC toàn cục và ACL theo project là hai policy khác nhau: mô tả policy hiện dùng và bảo toàn nó trên mọi endpoint, gồm export/evidence/spec.

## 2. Backlog theo thứ tự phụ thuộc

| Gói | Phạm vi | Điều kiện đóng |
|---|---|---|
| A1 | GEO-01: journal trước apply, rollback/recovery, không mất journal khi refresh lỗi | Fault injection đầu/giữa/cuối, refresh/rollback lỗi; kết quả hoặc về trước sửa hoặc có record phục hồi đầy đủ |
| A2 | WF-03/04: ID bất biến, tombstone recall, state/version chống race | Tab cũ không sửa phiếu khác; concurrent submit không mở lại accepted; object/ticket thống nhất |
| A3 | WF-01/02: completion theo snapshot và invariant dùng chung | Sửa/thêm/xóa nhãn, đổi spec, mở phiếu mới đều làm kết luận cũ mất hiệu lực phù hợp; list/detail/API thống nhất |
| A4 | SCAN-01: coverage độc lập | Thiếu/hỏng toàn bộ hoặc một phần chunk không thể có trạng thái giống kiểm đủ; QC được biết phần phải tự xem |
| A5 | GEO-02/03/04/05: miền geometry, cache/revision và terrain | Upright và OBB theo contract; cached/uncached trùng sau mọi thay đổi đầu vào; không áp số đo cũ |
| B1 | SCAN-02/04, INT-01: valid frames, visible segments, compound identity | Deleted/outside không sinh kết luận sai; shape/track trùng ID chọn đúng hoặc báo không tìm thấy |
| B2 | SCAN-03: PCD/ZIP integrity và cap tài nguyên | Corpus hợp lệ giữ đúng điểm; corpus hỏng trả lỗi kiểm soát, không sinh điểm từ zero-fill hoặc cấp phát vô hạn |
| B3 | WF-05/07 và WF-06 theo policy: related fingerprints, login buckets, ACL | Sửa vật phụ được ghi nhận; chuẩn hóa username nhất quán; quyền ngoài project bị từ chối nếu cần ACL |
| B4 | Plugin/extension/spec parity và tài liệu | Đường tích hợp QC khả dụng được nêu rõ; phần legacy không gây hiểu nhầm; kê đủ rule chung và rule chỉ UI/QC |
| C1 | CVAT contract và browser E2E | Ma trận target version/browser có Save/reload/Undo và hai vai trò, nhiều tab, lỗi mạng |
| C2 | Holdout + benchmark thuật toán + profiling | Manifest độc lập, artifact có thể chạy lại; báo đủ coverage/chất lượng/latency và lát dữ liệu |
| D1 | Nâng ground/fit/heading/missing proposal | Ứng viên thắng baseline trên tiêu chí đã khóa, không gây suy giảm chấp nhận được ở nhóm khó |
| D2 | Pilot với annotator/QC thật | Giảm phút thao tác theo phép đo đã thiết kế, số lỗi sau nghiệm thu không tăng; bất đồng được adjudicate |

Mỗi gói cần PR nhỏ cùng regression test hành vi mong đợi. Không chuyển đồng loạt các probe assert lỗi sang suite chính rồi gọi chúng là test pass của bản sửa. Khi runtime đổi, giữ bằng chứng baseline và cập nhật test/ghi chú rõ revision đã sửa.

## 3. Ma trận kiểm thử trọng yếu

| Nhóm | Case bắt buộc | Oracle |
|---|---|---|
| Hình học | Round-trip local/world; yaw ±π; roll/pitch; mặt nghiêng; overlap/điểm sát biên | Góc/điểm tính độc lập; bất biến chặt trên synthetic, không lấy chính hàm production làm mọi expected |
| Ghi/Undo | Lock, fail thứ n, fail refresh, fail rollback, sửa khác trong khi pending, Undo sau Save | Journal đầy đủ, không overwrite thay đổi mới; dữ liệu sau Save/reload khớp kế hoạch |
| Cache | Label, attribute, occluded/outside, object cạnh đổi semantic, keyframe khác đổi cùng count, terrain exclusion đổi | Cached và fresh có cùng applicability/issue/contact/mặt đo sau ổn định |
| Đọc frame | Job start≠0, frame_step, split/overlap, deleted, outside/reentry, filename khác thứ tự | Fixture từ CVAT cùng version, so cvat-core và point/frame mapping |
| Parser | ASCII/binary/LZF, COUNT, NaN; header/payload truncated, kích thước/offset sai, CRC | Point array biết trước hoặc lỗi kiểm soát; cap trước allocate/decompress |
| Workflow | Create/edit/send/recall, stale tab, submit/withdraw/accept/return, lỗi CVAT, request chồng nhau | State machine/version; không ID reuse; không commit trên version cũ |
| Completion | Nhãn/spec đổi, scan chưa xong/lỗi, review thiếu, phiếu mở lại, done cũ | Cùng invariant và revision ở API list/detail, web và plugin |
| Quyền | QC/annotator khác nhau, hai project/organization, token revoked/expired, đổi tài khoản | Không trả dữ liệu hoặc cho ghi vượt policy triển khai |
| Tài nguyên | Point cloud lớn, nhiều frame/box, 2 scan cùng lúc, slow network, cancel/restart | Peak RSS, event-loop/UI delay, throughput, thời gian cancel, recovery artifacts |

Không đặt mục tiêu chỉ theo line coverage. Cần negative-path, concurrency, property/invariant và E2E ở các ranh giới dữ liệu.

## 4. Nghiệm thu trên CVAT thật

Dùng project/job thử nghiệm riêng và tài khoản QC/annotator được cấp cho thử nghiệm. Audit này chưa tạo dữ liệu hay can thiệp CVAT thật. Pin chính xác version CVAT, browser và commit PointSnap; không ghi credentials vào artifact.

Một lượt tối thiểu: mở job → đo box → preview sửa track → áp dụng → Undo/redo → Save → reload đối chiếu; QC scan → xem đủ object → tạo phiếu nhiều lỗi/cặp và phiếu thiếu vật → sửa draft → gửi → thu hồi phiếu chưa xử lý; annotator sửa và Save → nộp → rút/nộp lại; QC nghiệm thu → scan lại → so khác biệt → hoàn thành; sửa nhãn sau đó để kiểm invalidation.

Lặp các cạnh: đổi job/frame khi đang pending, hai tab cùng object, hai user, mạng rớt giữa apply/API, phiên hết hạn, plugin và extension cùng bật. Lưu trace, console lỗi, API status và annotation trước/sau; ảnh giao diện đơn lẻ không chứng minh nhãn đã lưu đúng.

[Playwright Chromium persistent context](https://playwright.dev/docs/chrome-extensions) là một lựa chọn QA; máy thử độc lập có thể cài công cụ này mà không đổi runtime stdlib của dự án.

## 5. Benchmark để chọn thuật toán

### Dữ liệu và split

- Development: các scene đã dùng chỉnh ngưỡng và tìm lỗi. Các scene/seed trong báo cáo hai vòng không dùng lại làm chứng nhận độc lập.
- Holdout: scene/log mới, tách trước khi tune; ưu tiên sensor/spec thực của đội. Public datasets bổ sung kiểm transform và nhóm cảnh khó.
- Reference labels: hai QC kiểm độc lập, giải quyết bất đồng và lưu lý do/điều khoản spec. Không coi nhãn chuẩn public là hoàn hảo hoặc đúng mọi spec doanh nghiệp.
- Corruption: cài lỗi có seed và độ lớn biết trước để đo sensitivity; báo riêng với lỗi thật, không gộp làm một tỉ lệ.
- Lát dữ liệu: class/subtype, range, point count, occlusion, ground slope/curb/multilevel, sensor, ego speed/turning, static/moving, lỗi cặp.

### Ứng viên

| Bài toán | Baseline | Ứng viên để thử | Rào chắn |
|---|---|---|---|
| Ground | Terrain JS sau sửa cache | Patchwork++ mask, GroundGrid elevation; TerraSeg ngoại tuyến khi phù hợp | Cùng ROI/transform, tách observed/interpolated; không dùng sensor height mặc định như chân lý |
| Fit cuboid | Connected-points + visible faces | Fit robust theo mặt nhìn thấy, temporal support có pose; xem công cụ SUSTechPOINTS làm tham chiếu tính năng | Không thu box vào phần bị che; preview, bảo toàn phần amodal/spec và Undo |
| Track consistency | Heuristic hiện có sau sửa outside | Pose thật nếu có; ICP có confidence; temporal residual theo timestamp | Pose yếu → abstain/cần xem; giữ kết quả theo từng class và maneuver |
| Heading toàn track | So keyframe hiện có | Heading-motion khi đủ tốc độ/pose, camera hỗ trợ | Symmetry theo class; xe lùi, rẽ, đứng yên và cone không dùng cùng rule |
| Vật thiếu | QC tự tạo phiếu | Cụm non-ground chưa được box giải thích; model proposal nếu dữ liệu cho phép | Tên đúng là “vùng nghi sót”, không tự kết luận vật; đo false proposals và lỗi sót thật |
| Duyệt lại | So object fingerprint | So geometry/attribute từng frame, batch nhiều frame cùng object | Pin revision và ghi phần thay đổi; không giấu context object xung quanh |

Các ứng viên và nguồn ở [nghiên cứu đối chiếu](NGHIEN_CUU_DOI_CHIEU.md). Chưa có benchmark nào trong audit này chứng minh ứng viên thắng PointSnap.

### Chỉ số và quy tắc chọn

| Nhóm | Phải báo |
|---|---|
| Ground | Signed bias, p50/p95 absolute error dưới box, coverage/no-evidence, confidence bins; segmentation IoU chỉ là chỉ số bổ sung |
| Finding | Precision, recall, FP/100 box hoặc object với mẫu số rõ, theo rule/severity/class; số QC đã xác minh |
| Edit | Sai số trước/sau, tỉ lệ cải thiện/làm xấu, số thao tác phục hồi; không đếm “đã thay đổi” thành “đã sửa đúng” |
| Performance | Cold/warm p50/p95, số điểm/frame/box, peak memory, phần chặn UI/event loop, máy/browser/version |
| Workflow | Phút/object đến Save, phút/job QC, số lần đổi màn, phiếu trả lại, lỗi sau nghiệm thu |

Định nghĩa trước ngưỡng spec `T_z`, `T_center`, `T_dims`, `T_yaw` theo class và coverage áp dụng. Với synthetic, yêu cầu bất biến số học (ví dụ giữ đáy trong 1 mm) kiểm độc lập; với dữ liệu thật, không mặc định mọi sensor đủ quan sát để đạt mức centimet đó.

**Ngân sách khởi đầu đề xuất cho pilot, chưa là số đã đo:** p95 phản hồi điều khiển sau khi dữ liệu đã tải ≤200 ms trên máy mục tiêu; không thực hiện edit bằng số đo lỗi thời; mọi case P1 có regression và E2E tương ứng; lưu mọi frame/rule không kiểm đủ. Ngân sách scan/memory đặt sau khi đo job đại diện. Khi candidate tăng recall nhưng cũng tăng FP, chọn theo thời gian QC và mức lỗi sau nghiệm thu, không chỉ số phát hiện.

Pilot dùng thứ tự đối trọng hoặc các job tương đương để giảm hiệu ứng học thuộc; giữ nguyên yêu cầu QC duyệt và tiêu chuẩn lỗi ở hai điều kiện. Báo số người/job/scene và khoảng bất định, không dùng tốc độ script API thay cho phút của người thật.

## 6. Artifact một lượt benchmark/phát hành

```text
revision + rule/spec digest + CVAT/browser/node versions
dataset manifest + scene split + coordinate adapters + seeds
raw per-object/per-frame predictions + abstain reasons
QC adjudication + metrics by slice + uncertainty
timings/memory + test/E2E traces + known limitations
decision: giữ baseline / thử tiếp / phát hành giới hạn
```

Không lưu token/cookie/password trong artifact. Lưu point cloud hoặc annotation thật theo chính sách dự án, không theo mặc định của script nghiên cứu.

## 7. Định nghĩa hoàn tất

Giai đoạn sửa integrity hoàn tất khi tất cả ca ưu tiên cao ở audit có regression đúng kỳ vọng và qua E2E CVAT mục tiêu, không mất nhãn/journal khi fault injection. Giai đoạn thuật toán hoàn tất khi ứng viên được đánh giá trên split khóa từ trước và đáp ứng spec/coverage/latency cùng mức lỗi sau nghiệm thu đã chọn. Chỉ khi có benchmark cùng protocol và phạm vi rõ mới so sánh “tốt hơn” với một baseline; không dùng cụm “tốt nhất lĩnh vực” làm trạng thái nghiệm thu không đo được.
