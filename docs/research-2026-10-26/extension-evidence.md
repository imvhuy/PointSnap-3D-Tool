# PointSnap — Extension reliability and browser evidence

**Ngày nghiên cứu:** 26/10/2026.  
**Phạm vi:** Chrome/Edge MV3, bridge MAIN–ISOLATED, quyền, lưu trữ, xử lý nền, phục hồi sửa nhãn và nghiệm thu.  
**Phương pháp:** 8 truy vấn tìm kiếm, đọc 9 URL tài liệu chính thức Chrome/MDN/Playwright/W3C; đọc sâu các phần liên quan của tài liệu lifecycle, storage, messaging, network requests, execution worlds và extension testing. Không chạy CVAT/browser thực tế trong nghiên cứu này. Exa/Firecrawl không có trong phiên, dùng công cụ web tương đương. Các đề xuất dưới đây chưa phải kết quả triển khai.

## 1. Kết luận có thể dùng cho thiết kế

1. Giữ **adapter CVAT tối thiểu ở MAIN**, thuật toán thuần độc lập, và bridge quyền hạn hẹp ở ISOLATED/service worker. MAIN chia sẻ môi trường với trang nên không là nơi giữ bí mật hoặc xác thực nguồn lệnh. [E1](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld), [E2](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).
2. Đặt phép quét trong vòng đời job/tab và có cơ chế lưu tiến độ được phép; service worker xử lý sự kiện/quyền, không là bộ nhớ duy nhất của công việc dài. [E4](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
3. Đặc tả chính xác “dữ liệu không rời CVAT”. `storage.sync` có thể đồng bộ metadata sang trình duyệt khác; PointSnap hiện dùng sync cho cấu hình host. [E5](https://developer.chrome.com/docs/extensions/reference/api/storage), [hosts.js](../../extension/hosts.js).
4. Trước khi mở rộng sửa theo track, sửa lỗi **batch ghi một phần nhưng mất Undo record** bằng nhật ký phục hồi và kiểm tra xung đột. Đây là đề xuất giải quyết hành vi mã hiện có, không phải bảo đảm giao dịch từ trình duyệt. [Adapter hiện tại](../../extension/src/annotator/cvat-adapter.js).
5. Thêm kiểm thử extension thật bằng fixture Chromium persistent context; bộ unit test không thay thế kiểm Save/reload, quyền, worker restart và adapter CVAT. [E7](https://playwright.dev/docs/chrome-extensions).

## 2. Evidence cards

Mỗi thẻ chỉ tóm tắt điểm được nguồn trực tiếp hỗ trợ. Truy cập tất cả URL ngày 26/10/2026; ngày cập nhật chỉ ghi khi xác minh được trong trang.

### E1 — MDN: scripting.ExecutionWorld

- URL: [scripting.ExecutionWorld](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld).
- Bằng chứng: ISOLATED tách global/API khỏi trang; MAIN dùng chung môi trường JavaScript với trang, có thể bị trang can thiệp, không có API riêng của content script.
- Giới hạn: đây là hợp đồng môi trường thực thi, không xác nhận adapter nội bộ CVAT nào tương thích.
- Tin cậy: cao cho semantics của execution world; đối chiếu thêm cảnh báo messaging ở E2.

### E2 — Chrome: Message passing

- URL: [Message passing — security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations).
- Bằng chứng: Chrome khuyến cáo coi nội dung gửi từ content script là ít tin cậy hơn service worker; kiểm tra input, hạn chế hành động có quyền và xử lý nội dung tránh chạy mã ngoài ý muốn.
- Giới hạn: kiểm origin không chứng minh một message trong cùng trang được phát ra bởi logic PointSnap.
- Tin cậy: cao; giải thích trust boundary cùng E1.

### E3 — Chrome: Permissions API

- URL: [Permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions).
- Bằng chứng: quyền tùy chọn có thể xin khi người dùng bật chức năng; lời gọi xin quyền phải xuất phát từ thao tác người dùng. API có kiểm tra và gỡ quyền; host permission có thể xin theo origin cụ thể.
- Giới hạn: quyền browser không thay thế quyền đọc/ghi job của tài khoản CVAT.
- Tin cậy: cao; chưa thử permission flow của PointSnap trên máy mục tiêu.

### E4 — Chrome: Service worker lifecycle

- URL: [The extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- Bằng chứng: worker thường bị dừng sau 30 giây không hoạt động; biến global mất khi dừng. Tài liệu còn nêu giới hạn request kéo dài và fetch chậm, cùng các thay đổi vòng đời theo phiên bản Chrome.
- Giới hạn: các ngoại lệ/timer phụ thuộc phiên bản; không suy ra một tác vụ dài chắc chắn bị dừng đúng một mốc cố định.
- Tin cậy: cao; test restart theo E7.

### E5 — Chrome: Storage API

- URL: [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage).
- Cập nhật trên trang: 11/09/2026 UTC.
- Bằng chứng: local/session hiện có giới hạn 10 MB; session bị xóa khi reload/update/disable extension hoặc khởi động lại browser. Sync đồng bộ giữa browser đăng nhập cùng người dùng, khoảng 100 KB tổng, 8 KB mỗi item; ghi vượt quota thất bại.
- Giới hạn: các vùng này không tự tạo giao dịch với bộ nhớ annotation CVAT; quota không phải ngân sách toàn bộ extension.
- Tin cậy: cao.

### E6 — MDN: Transferable objects

- URL: [Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).
- Bằng chứng: chuyển `ArrayBuffer` sang worker chuyển ownership và làm buffer gốc bị detach. Typed array được serialize; underlying buffer mới là transferable.
- Giới hạn: lợi ích truyền dữ liệu không chứng minh toàn pipeline LiDAR nhanh hơn; benchmark phải gồm chi phí sao chép và dựng lại chỉ mục.
- Tin cậy: cao.

### E7 — Playwright: Chrome extensions

- URL: [Chrome extensions](https://playwright.dev/docs/chrome-extensions).
- Bằng chứng: extension test dùng Chromium với persistent context. Hướng dẫn hiện khuyên Chromium đi kèm Playwright vì Chrome/Edge đã bỏ cờ sideload cần cho ví dụ. Trang mô tả fixture popup/service worker và xử lý worker suspension/restart.
- Giới hạn: fixture Chromium không chứng nhận bản Chrome/Edge doanh nghiệp cụ thể; cần smoke test riêng.
- Tin cậy: cao; công cụ được đề xuất chưa được cài/chạy trong nghiên cứu này.

### E8 — W3C WAI: Button pattern

- URL: [Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/).
- Bằng chứng: button có accessible name; có thể lấy từ text, `aria-label` hoặc `aria-labelledby`. Hướng dẫn nêu Space/Enter, quản lý focus và trạng thái toggle.
- Giới hạn: đúng markup chưa chứng nhận toàn UI đạt WCAG hoặc mọi công nghệ hỗ trợ.
- Tin cậy: cao.

### E9 — Chrome: Cross-origin network requests

- URL: [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
- Bằng chứng: content script chịu same-origin; extension context có thể fetch host được cấp quyền. Chrome cảnh báo không cho bridge nhận URL tùy ý từ trang/content script; cần giới hạn tài nguyên và dùng cách render nội dung an toàn.
- Giới hạn: host permission không cấp quyền ứng dụng phía CVAT hoặc quyền dùng PAT của server khác.
- Tin cậy: cao; củng cố thiết kế scope validation E2.

## 3. Đối chiếu với repository

| Quan sát trực tiếp từ code | Hệ quả thiết kế đề xuất |
|---|---|
| [manifest](../../extension/manifest.json) nạp annotator và adapter ở MAIN; settings bridge ở ISOLATED | Giữ code có quyền ở extension context; MAIN là vùng dữ liệu/logic trang có thể quan sát hoặc sửa |
| [settings bridge](../../extension/src/annotator/settings-bridge.js) kiểm source/origin và nhận projectId từ message | Schema/type/size validation cần nằm phía nhận có quyền; project phải được đối chiếu với job của tab. Source/origin chỉ khoanh vùng trang, không xác thực tác giả message trong trang |
| [background](../../extension/background.js) đã giới hạn sender, route, method và job/run origin | Giữ và test các ràng buộc này; tránh biến thành proxy nhận URL tùy ý |
| [hosts](../../extension/hosts.js) dùng storage.sync cho CVAT origins và local cho profile | Chốt host metadata có được sync không. Có chế độ triển khai local-only nếu ranh giới dữ liệu đòi hỏi |
| [adapter](../../extension/src/annotator/cvat-adapter.js) sửa state rồi save tuần tự khi không gộp cùng frame; Undo record chỉ trả khi thành công | Cần journal trước mutation và trả trạng thái thành công một phần/khôi phục; không coi `finally freeze(false)` là rollback |
| [controller](../../extension/src/annotator/annotator.js) cache dựa geometry/attributes nhưng thiếu label/occluded và một số đầu vào peer | Dùng revision rõ ràng cho annotation, guideline, cloud và track; vô hiệu hóa đủ đầu vào và bỏ kết quả async đã lỗi thời |
| Lưu done/dismiss trong localStorage của trang CVAT | Công bố đây là trạng thái cục bộ, không tự thành review chung của đội; key cần origin/job/identity/revision và retention |

Đây là quan sát code ở checkout, không là tuyên bố lỗ hổng khai thác đã chứng minh. Không có yêu cầu gửi dữ liệu ngoài CVAT được thực hiện trong nghiên cứu.

## 4. Đề xuất hợp đồng bridge và phiên xử lý

**Suy luận thiết kế từ E1/E2/E3/E9 và code hiện tại:**

- Envelope có `protocolVersion`, `type`, `requestId`, `tab/job scope`, `revision`, payload theo schema và giới hạn kích thước.
- Mỗi message type có allowlist field và hành động; input không mở rộng quyền bằng URL, project ID hoặc job ID do trang tự khai báo.
- Giữ PAT và quyền network trong context được phép; MAIN chỉ nhận dữ liệu cần hiển thị/tính toán.
- Correlation ID giúp ghép trả lời; nó không là bí mật để xác thực trong MAIN. Random token cùng trang không biến page code thành trust boundary.
- Khi tab chuyển job hoặc reload extension: tăng generation, hủy logic tác vụ cũ, dọn overlay/cache, từ chối response không còn cùng generation.
- Thu hồi host permission phải dừng thao tác có quyền và cho người dùng biết trạng thái; mở tab đã cấp trước đó không được mặc định là vẫn có quyền.

## 5. Đề xuất scan worker, cache và cancellation

Đây là phương án cần profile trên job mục tiêu, không là cam kết tốc độ:

1. MAIN adapter đọc đúng frame và tạo bản dữ liệu thuần cần cho phép kiểm; ghi rõ data revision.
2. Gửi sang dedicated worker theo lô nhỏ, sau khi kiểm CSP/worker loading của CVAT mục tiêu. Có fallback chunk trên main thread nhường event loop.
3. Không transfer trực tiếp `ArrayBuffer` do CVAT sở hữu/render: buffer đó có thể bị detach theo E6. Sao chép vùng cần dùng rồi transfer bản sao; tính cả chi phí copy trong benchmark.
4. Cache có hạn theo byte/frame, dùng revision của cloud + annotation + guideline + algorithm version. Terrain phụ thuộc box exclusions nên geometry đổi có thể làm terrain cũ không còn đúng.
5. Cancellation kiểm giữa các bước/lô; response kèm generation để bỏ kết quả cũ ngay cả khi phép tính đang chạy không ngắt tức thì.
6. Giữ bản thống kê/findings và release cloud khi rời frame theo chính sách cache. Đo peak memory; không giữ cloud cả job trong `chrome.storage`.
7. Nếu hỗ trợ tiếp tục sau restart, checkpoint chứa trạng thái/identity/config được phép lưu. Checkpoint không thay thế kiểm revision trước khi tiếp tục.

## 6. Đề xuất phục hồi sửa nhiều keyframe

**Vấn đề code:** `saveGroup` đóng băng history, gọi từng `state.save()`, rồi mở history trong finally; lỗi giữa batch có thể để các frame trước đã đổi nhưng caller chưa nhận Undo record. [cvat-adapter.js](../../extension/src/annotator/cvat-adapter.js), [annotator.js](../../extension/src/annotator/annotator.js).

**Đề xuất, cần được nghiệm thu trên từng phiên bản CVAT:**

1. `PREPARED`: đọc fresh state, kiểm scope/lock, chụp before/after cho từng frame và ghi journal được phép trước mutation.
2. `APPLYING`: mỗi entry có trạng thái chưa thử/đã áp dụng/không rõ/đã phục hồi/xung đột; cập nhật sau mỗi lần ghi.
3. `APPLIED_UNSAVED`: thay đổi mới ở phiên CVAT; UI nói rõ chưa Save lên server. Người dùng tự Save.
4. Nếu lỗi: phục hồi entry đã đổi trong thứ tự ngược và giữ journal khi còn entry không rõ; luôn mở lại history. Lỗi recovery được hiển thị riêng.
5. Sau crash/reload: so geometry hiện tại với before/after. Chỉ phục hồi khi khớp after; khớp before thì xem là chưa đổi/đã phục hồi; khác cả hai thì đánh dấu conflict, giữ công việc người khác.
6. Undo chủ động cũng dùng compare-before-restore; giữ frame đã chỉnh tiếp. Không tự retry lệnh ghi mơ hồ như một phép đọc idempotent.

**Ràng buộc dữ liệu:** journal chứa hình học nhãn. Nếu chính sách chỉ cho trạng thái RAM, khả năng phục hồi qua reload không thể được quảng bá. Muốn crash recovery cần chốt lưu trữ local/server nào được phép, retention, cleanup và backup. `storage.session` không bền qua reload theo E5; persist ở local/IndexedDB cũng không làm thao tác CVAT thành transaction atomic.

## 7. Kế hoạch kiểm thử ưu tiên

| Lớp | Tình huống | Kết quả cần chứng minh |
|---|---|---|
| Unit | Đổi label, occluded, thuộc tính peer, track dims nhưng không đổi số keyframe | Cache trả phép đo mới; kết quả không còn gắn label cũ |
| Unit | Guideline thay đổi khi worker còn chạy | Response revision cũ bị bỏ |
| Bridge contract | Message sai origin/source/schema, quá kích thước, project/job mạo nhận, request trùng | Không vượt scope/quyền, có trạng thái lỗi rõ |
| Adapter integration | Inject lỗi ở lần save thứ 1, giữa và cuối; lỗi unfreeze/refresh/recovery | Mọi entry có trạng thái xác định; phục hồi được hoặc giữ journal/conflict; không mất lối Undo |
| Adapter integration | Lock thay đổi, user chỉnh tiếp sau Apply, outside/occluded/attribute boundary | Không ghi đè frame lock hoặc bản sửa mới; tỉa keyframe giữ mốc ngữ nghĩa |
| Browser extension | Install/grant/deny/revoke host; worker ngủ rồi thức; reload extension trên tab đang mở | Nạp đúng adapter/cấu hình, stale context được nhận biết, quyền được kiểm lại |
| Browser CVAT | Preview → Apply → Save CVAT → reload; Undo → Save → reload | Nhãn đúng sau vòng lưu thực; không coi refresh canvas là server persistence |
| Navigation | SPA chuyển job, đổi frame nhanh, hai tab cùng job | Không trộn identity/cache/undo; xung đột được biểu diễn |
| Performance | Cloud sparse/dense, nhiều box, job dài; cancel khi đọc/tính/gửi | Ghi p50/p95, long tasks, peak memory, cancel latency; không tự đặt SLO từ benchmark giấy |
| Accessibility | Panel icon-only, thu gọn, viewport hẹp, phím tắt khi đang nhập | Accessible names còn tồn tại; Space/Enter/focus/toggle đúng; không chặn phím CVAT cần dùng |

**Công cụ đề xuất:** unit tests Node cho hàm thuần; adapter fixtures cho state/history và fault injection; Playwright Chromium persistent context cho MV3; smoke test riêng Chrome/Edge và CVAT phiên bản doanh nghiệp. Theo E7, không dựa cờ sideload của branded Chrome/Edge để thiết kế CI. Khi môi trường không hỗ trợ automated extension loading, duy trì bước nghiệm thu thủ công có phiên bản và bằng chứng.

## 8. Giới hạn nghiên cứu

- Chưa chứng minh dedicated worker đọc được module/asset trong CSP cụ thể của CVAT mục tiêu; cần compatibility spike.
- Chưa nghiệm thu transaction/history semantics CVAT ở đây; nhóm nghiên cứu CVAT đối chiếu source phiên bản cần xác nhận.
- Chưa chạy fault-injection/browser tests mới. Các vấn đề batch/cache được ghi nhận từ rà soát code và reproduction của đợt review trước; kết quả nghiên cứu hiện tại là thiết kế kiểm thử cần triển khai.
- Chưa có quyết định của chủ dữ liệu về sync metadata, journal persist và xuất findings; mọi kiến trúc lưu dữ liệu cần tôn trọng quyết định đó.
- Tài liệu browser là tài liệu sống; pin phiên bản công cụ/browser trong CI và ghi retrieval date khi cập nhật báo cáo.
