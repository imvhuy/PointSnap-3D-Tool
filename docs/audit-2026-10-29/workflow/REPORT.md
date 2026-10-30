# Kiểm toán workflow, quyền truy cập và lưu trữ QC

Ngày: **29/10/2026**. Baseline: **`e845e7d`**. Skills: `engineering-code-review`, `engineering-testing-strategy`.

## Kết luận

Workflow đã có đủ thành phần cho vòng QC → annotator → QC, nhưng chưa bảo đảm tính đúng khi nhãn thay đổi ngoài phiên quét hoặc khi hai người thao tác đồng thời. Cần sửa ba lỗi P1 đã tái hiện trước khi dựa vào trạng thái “Hoàn thành” và “Đã nghiệm thu” để nghiệm thu sản xuất. Chính sách QC theo project/job cũng cần được chốt trước khi dùng một dịch vụ cho các nhóm có quyền CVAT khác nhau.

Đây là audit mã và probe dữ liệu giả, **không phải chứng nhận vận hành trên CVAT thật**. Không sửa mã sản phẩm trong đợt kiểm tra này.

## Phương pháp và bằng chứng

- Đọc `qc/server.js`, `qc/lib/{auth,store,config,cvat}.js`, các điểm kết nối với `qc/public/{plugin,app,tickets,annotator,spec}.js` và test API đang có.
- [probe-workflow.js](probe-workflow.js) chạy **router gốc và Store gốc**; chỉ tiêm config giả và thay `fetch` bằng CVAT giả. Không đọc `.env.local`, không mở cổng, không truy cập CVAT thật.
- [probe-results.json](probe-results.json) ghi expected/actual của **7 trường hợp đã tái hiện**. Assertion trong probe xác nhận hành vi sai hiện tại; exit code 0 nghĩa là tái hiện thành công, không phải sản phẩm đã vượt kiểm thử nghiệm thu.
- Lệnh: `node docs/audit-2026-10-29/workflow/probe-workflow.js`. Trên máy này, sandbox tạo đường dẫn Temp không tồn tại, nên chạy lại ngoài sandbox đã thành công. Lỗi Temp không được tính là lỗi sản phẩm.

## Các phát hiện xác nhận

| ID | Mức | Vấn đề | Nguồn chính |
|---|---|---|---|
| WF-01 | P1 | Hoàn thành trên snapshot cũ dù nhãn hiện tại đã đổi/thêm object | `qc/server.js:399`, `qc/server.js:392` |
| WF-03 | P1 | Thu hồi phiếu cao nhất làm ID được dùng lại; tab cũ tác động object mới | `qc/server.js:230`, `qc/lib/store.js:97` |
| WF-04 | P1 | Request nộp bị chậm có thể mở lại phiếu đã nghiệm thu | `qc/server.js:238`, `qc/server.js:242`, `qc/server.js:245` |
| WF-02 | P2 | Danh sách job vẫn báo xong sau khi tạo phiếu mới chưa nghiệm thu | `qc/server.js:297`, `qc/server.js:206`, `qc/lib/store.js:105` |
| WF-05 | P2 | Sửa vật thứ hai của lỗi theo cặp vẫn bị báo “object chưa đổi” | `qc/server.js:259`, `qc/server.js:246` |
| WF-07 | P2 | Thêm khoảng trắng vào username vượt được khóa dò mật khẩu | `qc/server.js:139`, `qc/server.js:324`, `qc/server.js:326` |

### WF-01 — Hoàn thành không đối chiếu nhãn đang có trên CVAT

**Tái hiện:** scan giả chứa một track A; QC đánh dấu A đạt; nhãn CVAT giả sau đó sửa A và thêm B; gọi `/api/jobs/7/complete`.

**Actual:** HTTP **200**, số object hoàn thành **1**, trong khi CVAT giả có **2** object và track A đã đổi. Endpoint không đọc lại annotation nào. Không cần tác nhân độc hại: annotator khác chỉ cần sửa/Lưu CVAT sau lần quét.

**Nguyên nhân:** `/objects` lấy fingerprint từ `store.scan`, còn `/complete` chỉ so `objectReviews` với cùng scan đó. Vì vậy “fingerprint giống” chỉ chứng minh review khớp snapshot cũ. Thay đổi bên CVAT chỉ được nhận ra sau một lần scan mới. Comment “nội dung hiện tại” không đúng cho khoảng thời gian giữa hai lần quét.

**Sửa đề xuất:** mỗi lần hoàn thành phải đối chiếu version/digest toàn bộ annotation (bao gồm tập object, label, attributes và shapes) với snapshot đã duyệt; nếu đổi thì trả **409**, vô hiệu completion và yêu cầu quét/duyệt phần thay đổi. Gắn completion với annotation version/digest, spec version/digest và scan thành công. Nếu CVAT không hỗ trợ khóa hoặc conditional transaction cho bước này, ghi rõ biên thời điểm của quyết định và tiếp tục phát hiện chỉnh sửa sau đó.

**Nghiệm thu:** sửa A, thêm B, xoá B hoặc đổi thuộc tính sau scan đều không thể hoàn thành bằng review cũ. Nhãn không đổi hoàn thành được. Việc chỉ tải lại UI hoặc chỉ bấm “Đạt” không được làm mất dấu yêu cầu scan mới.

### WF-03 — ID phiếu bị tái sử dụng sau thu hồi

**Tái hiện:** tạo `BUG-101` cho A → thu hồi → tạo phiếu cho B → gửi lệnh nộp từ tab cũ còn giữ `BUG-101` của A.

**Actual:** phiếu B cũng có ID **`BUG-101`**; lệnh từ tab cũ nộp **B (`track:10`)** dù tab đang nói về A (`track:9`).

**Nguyên nhân:** recall xoá vật lý phiếu; ID mới lấy `max(ID của các phiếu còn tồn tại)+1`. Thu hồi phiếu có số cao nhất khiến số đó dùng lại. Điều này xảy ra ngay cả trong một process, không cần đồng thời.

**Sửa đề xuất:** ID bất biến, không tái sử dụng: UUID hoặc sequence lưu độc lập. Thu hồi nên là trạng thái `recalled`/tombstone, lưu lịch sử và version. Mỗi mutation kèm ID + version, không chấp nhận ID đã thu hồi.

**Nghiệm thu:** tạo/thu hồi 100 phiếu vẫn không có ID trùng; URL/tab cũ trả 404/409 hoặc hiển thị phiếu đã thu hồi; không thể cập nhật phiếu khác.

### WF-04 — Race cho phép submitted ghi đè accepted

**Tái hiện có kiểm soát:** annotator gửi “nộp lại”; CVAT giả giữ chậm request đọc fingerprint. Trong lúc đó QC nghiệm thu xong. Cho request nộp trước đó chạy tiếp.

**Actual:** trạng thái đi **`submitted → accepted → submitted`**. `objectReviews` vẫn là `ok`, tạo bất nhất giữa kết luận object và trạng thái phiếu.

**Nguyên nhân:** server kiểm `t.status` trước `await liveFingerprint(t)`, sau await mới đọc và ghi phiếu mà không kiểm version/trạng thái hiện tại. Cùng pattern cũng ảnh hưởng điều kiện rút/nộp và có thể kết hợp với thu hồi/tái sử dụng ID.

**Sửa đề xuất:** state machine rõ ràng và optimistic concurrency (`version`/`If-Match`) hoặc serialise mutation theo ticket. Sau mọi await phải kiểm lại version/trạng thái và quyền, rồi commit nguyên tử. Nếu không còn đúng trạng thái đã đọc, trả 409; không ghi đè quyết định mới hơn. Nếu sau này dùng nhiều process, JSON files cần cơ chế khóa/transaction thực sự; đồng bộ `fs.*Sync` chỉ đủ để tránh chen giữa trong một đoạn không có await của một process.

**Nghiệm thu:** test race có hàng rào điều khiển cho submit/accept, submit/withdraw, submit/recall; request tới sau quyết định mới phải bị từ chối hoặc được áp dụng theo state machine có chủ đích; `objects` và `tickets` luôn nhất quán.

### WF-02 — Completion cũ vẫn được đưa lên danh sách job

**Tái hiện:** hoàn thành job → tạo phiếu thiếu vật mới → gọi hoàn thành lại và đọc danh sách job.

**Actual:** `/complete` trả **409** vì có phiếu mở, trong khi `/api/jobs` vẫn trả **`last.done: true`**.

**Nguyên nhân:** `listJobs` chỉ kiểm file completion tồn tại và đủ số fingerprint review; không xét phiếu đang mở, version scan/spec hoặc thời điểm tạo phiếu mới. File completion không bị vô hiệu khi mở lại công việc.

**Sửa/nghiệm thu:** tính completion qua một hàm invariant dùng chung cho API, plugin và web; thêm phiếu, trả lỗi, đổi annotation/spec làm completion hiện tại mất hiệu lực. Test danh sách và chi tiết không được đồng thời hiển thị “xong” và “còn phiếu chưa nghiệm thu”.

### WF-05 — Fingerprint thiếu các vật liên quan

**Tái hiện:** phiếu chồng lấn giữa A và B, gắn vào A; annotator sửa B để giải quyết chồng lấn, giữ A nguyên; nộp phiếu.

**Actual:** **`unchanged: true`**, dù B thực sự đã đổi. Đây là cảnh báo gây hiểu nhầm, không phải lỗi tự khóa nộp: API vẫn nhận bài. Lỗi này đã được tài liệu thử nghiệm nội bộ ghi nhận, probe xác nhận còn tồn tại sau khi thêm danh sách nhiều lỗi vào một phiếu.

**Sửa/nghiệm thu:** lưu fingerprint của mọi object liên quan ở từng issue, cả trạng thái tồn tại/xoá; so tập đó khi nộp. Sửa/xoá B phải được nhận là thay đổi; A và B đều không đổi mới báo chưa đổi. Chưa đổi dữ liệu không tự chứng minh “chưa sửa đúng”; đây chỉ là bằng chứng về nội dung.

### WF-07 — Khóa dò mật khẩu dùng username chưa chuẩn hóa

**Tái hiện:** đăng nhập sai `qcuser` 8 lần; lần kế bị 429; đăng nhập sai `qcuser ` với một dấu cách cuối.

**Actual:** request có dấu cách trả **401**, tiếp tục tới bước xác thực CVAT thay vì giữ khóa 429. Thêm số dấu cách tạo thêm bucket. Server trim username trước xác thực nhưng không trim khi tính khóa giới hạn.

**Sửa/nghiệm thu:** tạo username chuẩn hóa một lần trước mọi check và dùng cho cả khóa, ghi thất bại và xác thực. Kết hợp giới hạn theo IP và account phù hợp với reverse proxy, không tin header forwarded tùy ý. Test `qcuser`, ` qcuser`, `qcuser ` và các biến thể số lượng khoảng trắng dùng cùng bucket.

## Phát hiện có điều kiện triển khai: WF-06 — QC có quyền toàn cục

**Bằng chứng:** CVAT giả trả **403** cho tài khoản `limited` đọc annotation job 7; khi cùng tài khoản nằm trong `QC_USERS`, `/api/jobs/7` của dịch vụ QC trả **200** và hiện scan. Dịch vụ đọc CVAT bằng một service token dùng chung; đọc scan/phiếu và sửa spec/review chỉ kiểm vai trò QC, không xác nhận quyền project/job của tài khoản đang thao tác.

Đây là **hành vi được thiết kế hiện tại**, chưa phải bằng chứng có xâm nhập hệ thống thật. Nếu mọi người trong `QC_USERS` được chủ đích cấp quyền toàn bộ dữ liệu mà service token thấy, đây là chính sách cần ghi rõ. Nếu phải bảo toàn ACL giữa khách hàng/project/team của CVAT, đây là **P1**: cần kiểm quyền job/project trước mọi read/write và không lấy quyền của service token làm quyền của người dùng. Annotator hiện có lọc phiếu theo assignee; điểm tốt này chưa bảo vệ ranh giới giữa các QC.

**Nghiệm thu:** ma trận hai QC/hai project/hai organization với quyền khác nhau; đọc scan/export/evidence/tickets và ghi review/spec/complete ngoài quyền phải 403/404. Thu hồi quyền hoặc vô hiệu tài khoản phải có thời gian hiệu lực được quy định; bearer token hiện chụp role lúc cấp và không tự hỏi lại CVAT ở mỗi request.

## Phần đang làm tốt

- Annotator không xem được scan qua API QC thông thường và không tự nghiệm thu; phiếu đọc/nộp giới hạn theo assignee. Test hiện có bao phủ một số đường này.
- Header ghi riêng + không mở CORS hỗ trợ chống request ghi từ origin lạ trong trình duyệt; cookie phiên là HttpOnly và SameSite=Strict.
- Token extension lưu hash, có expiry, có revoke; bearer không tự cấp token khác.
- Guideline có version/restore; request dữ liệu sai dạng một số trường bị từ chối; JSON file ghi tệp tạm rồi rename giảm nguy cơ hỏng từng file khi ghi.
- Phiếu thiếu vật đã có và chặn endpoint hoàn thành khi còn mở. Đây là quản lý công việc QC thấy bằng mắt, chưa tự xác nhận có box mới phù hợp.

## Giới hạn thiết kế cần đưa vào kế hoạch

1. Kết luận `false_alarm` được giữ theo key object/luật nhưng không kèm annotation/spec fingerprint (`Store.setReview`); plugin bỏ ưu tiên các key này kể cả sau chỉnh sửa. Cần quy tắc khi nào tái xác minh kết luận; giữ key ổn định không đồng nghĩa bằng chứng lỗi ổn định. Chưa gán thành lỗi độc lập trong probe.
2. Session/token giữ role; cache session CVAT 5 phút, token extension tối đa 30 ngày. Cần chính sách thu hồi quyền và expiry phù hợp; không có phép đo real-world về revoke trong audit này.
3. Toàn bộ phiếu lưu một JSON và mọi update ghi lại toàn bộ; specs giữ mọi version trong một file; chưa đo tải đồng thời, giới hạn kích thước hay crash giữa các file `tickets`/`objects`. Cần benchmark và kiểm tra phục hồi trước khi dùng nhóm lớn.
4. Test API hiện dùng mock CVAT và test các nhánh tuần tự chính. Chưa thấy E2E browser đầy đủ để đảm bảo plugin chuyển frame, chọn đúng object, Save, submit/recall/withdraw và refresh luôn phản ánh đúng trạng thái.

## Kế hoạch kiểm thử ưu tiên

| Ưu tiên | Loại | Phạm vi nghiệm thu |
|---|---|---|
| P1 | Integration + state-machine | Ba lỗi WF-01/03/04 phải có test regression bất biến; version conflict và ID không tái dùng |
| P1 theo triển khai | Authorization integration | Quyền hai QC/hai project/organization và tất cả endpoint có dữ liệu/ghi |
| P2 | Integration | Completion bị vô hiệu khi mở phiếu mới, đổi scan/spec; list/chi tiết thống nhất |
| P2 | Integration | Issue một vật, nhiều vật, nhiều lỗi; sửa/xoá vật phụ; stale fingerprint và thiếu CVAT |
| P2 | Security unit/integration | Bucket đăng nhập chuẩn hóa; role revoke; token hết hạn; phiên CVAT đã đăng xuất |
| P1 trước triển khai | Browser E2E trên CVAT mục tiêu | QC duyệt/gửi; annotator chọn box sửa Save/nộp/rút; QC nghiệm thu/quét lại/hoàn thành; reload, nhiều tab và lỗi mạng |
| P2 | Resilience/load | Hai request chồng nhau, restart giữa ticket/object writes, dữ liệu JSON lỗi, số lượng phiếu lớn |

Không nên đánh giá chất lượng workflow chỉ bằng số test đang pass: các điều kiện dữ liệu mới, stale tab và request chồng nhau ở trên chưa được test tuần tự thông thường phát hiện.
