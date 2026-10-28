# Extension trong CVAT ↔ dịch vụ QC

Mục tiêu: QC và annotator làm việc ngay trong trang job 3D của CVAT, không chuyển tab:
- chuyển object không tải lại trang;
- chọn box và khoá camera;
- lỗi / lời QC hiện cạnh box;
- bấm OK / Trả lỗi / Nộp tại chỗ.

Trang web QC (`qc/`) vẫn giữ phần tổng quan: tiến độ, phiếu, nghiệm thu, guideline. Phần dịch vụ QC đã xong (mục 1–3); phần
extension (mục 4–6) chưa làm.

## 1. Kết nối

- Người dùng đăng nhập trang QC → menu tài khoản → **Kết nối extension CVAT** → **Tạo token**. Token có dạng `psq_…`, chỉ
  hiện một lần, hết hạn sau 30 ngày, mang đúng vai trò của người tạo (QC hoặc annotator). Người dùng xoá được token ở cùng
  chỗ đó.
- Extension, trang Tùy chọn → **Dịch vụ QC**: địa chỉ (ví dụ `http://127.0.0.1:8766`) và token → **Kiểm tra** (`GET /api/me`,
  hiện tên và vai trò). Xin quyền host cho đúng origin của dịch vụ (`chrome.permissions.request`).
- Mọi request kèm hai header: `Authorization: Bearer psq_…` và `X-PointSnap-QC: 1`. Thân request là JSON.
- Token không tạo được token khác (`POST /api/ext-tokens` bằng token → 403).
- Trả về 401 nghĩa là token hết hạn hoặc đã bị xoá: báo người dùng tạo token mới.

## 2. An toàn (bắt buộc)

- **Token chỉ nằm ở background / storage của extension.** Code chạy trong trang CVAT (world MAIN) không bao giờ thấy token.
  Đường đi: MAIN → `postMessage` → bridge (isolated world) → `chrome.runtime.sendMessage` → background `fetch`.
- **Background chỉ cho đi các đường dẫn trong danh sách dưới đây.** Trang CVAT có thể có script khác gửi `postMessage`, nên
  không được làm proxy mở cho mọi đường dẫn:
  - `GET /api/me`, `GET /api/status`
  - `GET /api/jobs/<số>`; `POST /api/jobs/<số>/(scan|objects|reviews|complete)`
  - `GET /api/tickets`, `GET /api/tickets?job=<số>`; `POST /api/tickets/batch`; `POST /api/tickets/BUG-<số>/(comment|submit|accept|return)`
  - `GET /api/users`
- Nội dung từ dịch vụ (lời QC, ghi chú annotator, tên) chỉ hiện bằng `textContent`, không `innerHTML`: người khác viết được
  nội dung này.
- Dịch vụ không ở localhost thì phải chạy HTTPS (đang chạy http).

## 3. API (đều đã có, cùng API trang web QC dùng)

| Việc | Request | Ghi chú |
|---|---|---|
| Ai đang dùng | `GET /api/me` → `{ username, name, role: 'qc' \| 'annotator' }` | |
| Kết quả quét + duyệt của job | `GET /api/jobs/<jobId>` → `{ run, result, reviews, objectReviews, completion }` | Chỉ QC |
| Quét lại | `POST /api/jobs/<jobId>/scan` (202); hỏi lại `GET /api/jobs/<jobId>` tới khi `run.state` là `done` / `error` | Chỉ QC |
| QC duyệt object | `POST /api/jobs/<jobId>/objects` `{ keys: ['track:123'], status: 'ok' \| 'returned' \| null, issue? }` | `issue = { tags: [..], frame, text, finding }` khi trả lỗi |
| QC kết luận mục tool báo | `POST /api/jobs/<jobId>/reviews` `{ key, verdict: 'confirmed' \| 'false_alarm' \| null }` | |
| Gửi lỗi cho annotator | `POST /api/tickets/batch` `{ jobId, assignee, keys }` → danh sách phiếu | Gửi mọi object đã trả lỗi mà chưa có phiếu |
| Hoàn thành job | `POST /api/jobs/<jobId>/complete` → 409 kèm lý do nếu chưa đủ | Đủ 100% object, gửi hết lỗi, nghiệm thu hết phiếu |
| Phiếu | `GET /api/tickets?job=<jobId>` (QC: mọi phiếu của job) · `GET /api/tickets` (annotator: phiếu của mình) | |
| Annotator nộp / ghi chú | `POST /api/tickets/<id>/submit` hoặc `/comment` `{ text }` | Phiếu trả về có `unchanged: true` nếu object trên CVAT chưa đổi |
| QC nghiệm thu / trả lại | `POST /api/tickets/<id>/accept` hoặc `/return` `{ text }` | |
| Người nhận phiếu | `GET /api/users` → `[{ username, name, role }]` | Gồm người được giao job trên CVAT |

Một số trường hay dùng:

- `result.objects[]`: `{ key: 'track:<serverID>', kind, serverId, cvatId, label, first, last, boxes, errors, warnings,
  noGround, noPoints, far, static, fingerprint }`.
  - `cvatId` là số object CVAT hiện trên sidebar.
  - `serverId` là `serverID` của CVAT.
- `result.findings[]`: `{ key, objKey, other?, otherCvatId?, rule, severity, title, short, message, frames }`.
- `objectReviews[key]`: `{ status, by, at, fingerprint, issue?, ticket? }`. Object **đã duyệt** khi
  `objectReviews[key].fingerprint === object.fingerprint`. Fingerprint khác thì object đã bị sửa sau lần duyệt, coi như
  chưa xem. Nếu khác fingerprint nhưng có `ticket` thì phiếu đang sửa, vẫn tính là trả lỗi.
- Phiếu: `{ id: 'BUG-101', jobId, objKey, serverId, cvatId, label, frames: [a, b], title, message, priority: 'must' | 'warn',
  assignee, status: 'open' | 'submitted' | 'accepted' | 'returned', unchanged?, thread: [{ name, role, at, text, kind }] }`.

## 4. Extension, chế độ QC (`role === 'qc'`), trong trang job CVAT

- **Thẻ QC:**
  - Thời điểm quét gần nhất + nút **Quét lại**.
  - Tiến độ duyệt: số object có fingerprint khớp trên tổng số object; tính theo đúng quy tắc ở mục 3.
  - Nút **Gửi N lỗi cho annotator**: mặc định giao cho người được giao job trên CVAT.
  - Nút **Hoàn thành**: hiện lý do khi bị 409.
- **Xem tiếp trong CVAT:**
  - Thứ tự giống trang web: object có lỗi → có cảnh báo → tool không kiểm được (`noPoints > 0` hoặc `noGround ≥ boxes/2`) →
    còn lại; trong mỗi nhóm xếp theo `first`, rồi `cvatId`.
  - Mỗi bước: chuyển frame trong CVAT (frame đầu của mục tool báo nặng nhất, không có thì `first`), chọn box theo
    `serverId`, khoá camera. **Không tải lại trang, không lọc mất các box xung quanh.**
  - Hiện các mục tool báo của object cạnh box: tiêu đề, `short`, frame.
- **Phím tắt:**
  - 1 OK; 2 Trả lỗi; 3 Báo nhầm (OK + `false_alarm` cho các mục tool báo của object); J / K tới / lui.
  - **Trả lỗi** là một form nhỏ:
    - nhãn lỗi: các tiêu đề tool báo + danh sách chung "Lơ lửng / lún, Kích thước, Hướng (yaw), Lệch vị trí, Sai class,
      Thiếu thuộc tính, Đứt / đổi ID, Thiếu box ở frame";
    - **frame lấy đúng frame CVAT đang mở**, chỗ trang web không biết được;
    - ghi chú.
  - QC vẫn phải duyệt **100% object**. Tool chỉ xếp thứ tự, không bỏ qua object nào.
- **Phiếu chờ nghiệm thu** của job: bấm vào thì nhảy tới box, có nút Nghiệm thu / Trả lại. Nếu phiếu có `unchanged` thì
  hiện cảnh báo "CVAT chưa đổi".

## 5. Extension, chế độ annotator (`role === 'annotator'`)

- **Thẻ Rework:** các phiếu của job đang mở có `status` là `open` hoặc `returned`. Bấm một phiếu thì nhảy tới `frames[0]`,
  chọn box theo `serverId`, khoá camera, hiện lời QC và các trao đổi.
- **Nộp**:
  - Nếu CVAT còn thay đổi chưa Lưu thì nhắc Lưu trước.
  - Gọi `POST /api/tickets/<id>/submit`.
  - Phiếu trả về `unchanged: true` thì báo "object chưa đổi trên CVAT, bạn đã Lưu chưa?". Với lỗi theo cặp (vẽ trùng, đứt
    track) thì bình thường: sửa bằng cách xoá object kia.
- Không thấy kết quả quét hay guideline editor: dịch vụ trả 403 cho annotator.

## 6. Chưa làm

- Phiếu "thiếu vật" (không gắn object, theo frame + vị trí): hiện hệ thống chưa có, job hoàn thành được dù còn thiếu box.
- HTTPS cho dịch vụ QC khi chạy ngoài localhost.
