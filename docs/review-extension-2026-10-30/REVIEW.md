# Review extension PointSnap — 30/10/2026

Baseline đã kiểm: `d16879373bbf766f151865d4657720e7accbcc13`, manifest `0.6.0`.
Skill áp dụng: `engineering-code-review` (`C:/Users/Han/.codex/skills/engineering-code-review/SKILL.md`).
Phạm vi: extension standalone; ưu tiên đường ghi nhãn, Undo, cache số đo, chuyển job/frame và hình học.
Không chỉnh mã sản phẩm, không mở hoặc sửa nhãn CVAT thật. Chỉ thêm báo cáo và probe review.

Kết luận: **cần sửa trước khi nghiệm thu thao tác sửa hàng loạt**. Xác nhận 8 vấn đề: 4 P1 và 4 P2.
P1 cần ưu tiên vì có thể ghi nhầm dữ liệu, mất đường hoàn tác hoặc đưa kết luận kiểm tra sai.
5 nhóm GEO từ audit 29/10 vẫn tái hiện trên baseline hiện tại; 3 ca ASYNC được thêm bằng probe trong lượt review này.

## 1. [P1] Ghi batch thất bại có thể để lại thay đổi mà không có bản Undo

Vị trí: `extension/src/annotator/cvat-adapter.js:222–228,236–259`; caller `annotator.js:481–483`.

`saveGroup()` freeze lịch sử rồi lưu từng state. Nếu `state.save()` ở giữa batch ném lỗi, những frame trước đó đã ghi,
nhưng không rollback. `applyEdits()` reject trước khi trả `record`, nên `rememberUndo()` không chạy. Lỗi đọc lại state
hoặc `refresh()` sau khi lưu cũng có thể làm mất record theo cùng đường trả kết quả.

Bằng chứng GEO-01: lưu frame 0 thành công, frame 1 lỗi; frame 0 vẫn đổi, không trả được record; freeze đã được trả về
false. Không kết luận lịch sử bị freeze vĩnh viễn: vấn đề là phần đã ghi không có journal mới cho UI hoàn tác.

Hướng sửa: lập journal trước khi ghi, ghi nhận từng bước thành công, rollback khi lỗi; nếu rollback không hoàn tất phải
giữ journal truy cập được và báo phần còn thay đổi. Tách lỗi refresh khỏi kết quả ghi. Với Hạ đáy mọi frame, cập nhật
journal sau từng lượt, thay vì chỉ sau khi toàn bộ các lượt hoàn tất.

Nghiệm thu: tiêm lỗi đầu/giữa/cuối batch, lỗi đọc lại/refresh/rollback; hoặc không đổi dữ liệu, hoặc vẫn có đường phục hồi
phần đã ghi, không ghi đè công sửa mới của annotator.

## 2. [P1] Bản xem trước của job cũ có thể được áp vào job mới

Vị trí: `extension/src/annotator/annotator.js:425–437,445–466`.

`onJobChanged()` xóa plan, nhưng `preparePlan()` còn chờ `trackKeyframes()` không có token job để hủy kết quả. Promise cũ
hoàn tất sẽ tạo lại `S.plan`. Plan chỉ mang `clientID`, không mang `jobId`; `applyPlan()` kiểm ID và signature hình học
nhưng không kiểm job. CVAT có thể dùng lại clientID giữa các job, như chính comment ở `onJobChanged()` đã mô tả.

Bằng chứng ASYNC-01: yêu cầu lấy cỡ frame hiện tại 6 m ở job 101/frame 1; chuyển sang job 202/frame 0 với clientID 7;
kết quả job 101 về muộn tạo lại plan. Hai track có cùng hình học keyframe nên signature khớp; Apply gọi ghi job 202,
đổi frame 0 sang dài 6 m. Đây là CVAT giả trong VM, không phải ghi dữ liệu thật.

Hướng sửa: gắn `(jobId, clientID, operationToken)` vào tác vụ và plan; kiểm sau mỗi await, trước khi hiện preview và trước
khi ghi. Đổi job phải hủy operation cũ; không chỉ xóa biến plan. Nếu còn cho thao tác tiếp tục khi đổi object/frame,
UI phải giữ rõ object/job đích của thao tác.

Nghiệm thu: API đọc keyframe bị trì hoãn, đổi job dùng cùng clientID và cùng hình học; không xuất hiện plan cũ và không
có lệnh ghi vào job mới. Kiểm thêm đổi object, hủy, và chuyển job lần nữa trước khi Apply hoàn tất.

## 3. [P1] Checklist giữ kết quả cũ khi đổi class hoặc sửa keyframe khác

Vị trí: `extension/src/annotator/annotator.js:158–176,198–204,945–949`.

Cache key chứa hình học hiện tại, hình học object khác, **số lượng** keyframe và attributes hiện tại; thiếu label,
occluded, semantic của object khác và nội dung keyframe. Listener đổi states chỉ đánh dấu đọc lại track; việc reload
track cùng số keyframe không bắt buộc tính lại số đo.

Bằng chứng GEO-04a: CVAT đổi car thành pedestrian, cache vẫn trả label car và không báo sai kích thước; tính mới báo
`size.class_range`. GEO-04b: giữ 3 keyframe, đổi chiều dài hai keyframe khác thành 8 m; cache không báo
`size.in_track`, tính mới có báo.

Hướng sửa: revision cho dữ liệu hình học/semantic của frame và nội dung track; invalidate khi đổi class, occluded,
attributes, object liên quan, Undo/redo và khi đọc lại keyframe. Không dùng count thay cho revision nội dung.

Nghiệm thu: cached và uncached cho cùng label, issue/severity và số đo sau từng thay đổi độc lập; đi qua listener
controller, không chỉ test module Measure.

## 4. [P1] Đồng bộ kích thước làm lệch đáy box có pitch/roll

Vị trí: `extension/src/annotator/track-ops.js:35–48`; lời hứa giữ đáy trên UI ở `annotator.js:402`.

Dịch tâm trong hệ local và chỉ bù local Z theo chênh chiều cao không giữ được đáy trong hệ thế giới khi box nghiêng.
Mã đang chấp nhận Euler XYZ hợp lệ và không chặn thao tác này trên box có pitch/roll.

Bằng chứng GEO-02: pitch 30°, kích thước `[4,2,2]` → `[6,2,2]`, đáy từ 1,133974596 m xuống 0,133974596 m, lệch −1 m.
Control cùng phép đổi với box chỉ yaw giữ đáy đúng.

Hướng sửa: chốt hợp đồng box upright hay Euler XYZ đầy đủ. Nếu hỗ trợ nghiêng, tính bất biến đáy qua các góc thế giới
và giải quyết rõ yêu cầu giữ mặt nhìn thấy; nếu chưa hỗ trợ thì chặn thao tác và giải thích trên UI.

Nghiệm thu: pitch/roll dương, âm và các độ nghiêng nhỏ trên dốc; sau sync đáy khớp hợp đồng trong dung sai 1 mm.

## 5. [P2] Refresh ghi states của frame cũ vào màn hình frame mới

Vị trí: `extension/src/annotator/cvat-adapter.js:195–202`.

`refresh()` chụp ctx, await annotations và history, rồi dispatch `FETCH_ANNOTATIONS_SUCCESS` mà không kiểm lại job/frame.
Nếu người dùng đổi frame/job qua CVAT trong thời gian chờ, kết quả cũ vẫn được gán vào Redux hiện tại. `S.busy` chỉ
chặn hành động của panel PointSnap, không chặn thao tác native của CVAT.

Bằng chứng ASYNC-02: bắt đầu refresh frame 0, đổi player sang frame 1 trước khi get hoàn tất; action vẫn mang state
frame 0. Probe xác nhận payload dispatch sai ngữ cảnh; chưa đo ảnh hưởng render trên trình duyệt thật.

Hướng sửa: kiểm lại job, frame và generation/request token ngay trước dispatch; bỏ phản hồi cũ hoặc yêu cầu refresh
ngữ cảnh mới. Cần chống cả hai refresh cùng frame hoàn tất ngược thứ tự.

Nghiệm thu: đổi frame/job giữa hai await, đảo thứ tự phản hồi; action cũ không ghi vào state mới.

## 6. [P2] Lấy point cloud đang vẽ mà chỉ so frame, không so job

Vị trí: `extension/src/annotator/cvat-adapter.js:170–176`; caller `annotator.js:495–505,528–550`.

`frameCloud(ctx, frame)` dùng cloud của context hiện tại nếu số frame bằng yêu cầu, dù `now.job.id !== ctx.job.id`.
Trong Hạ đáy mọi frame đang chờ đọc dữ liệu, người dùng chuyển sang job có cùng số frame có thể làm phép đo của job
cũ dùng cloud của job mới; sau đó kết quả này có thể tham gia kế hoạch sửa Z ở job cũ.

Bằng chứng ASYNC-03: yêu cầu job 101/frame 0, store đang job 202/frame 0; hàm trả đúng object cloud của job 202.
Probe xác nhận nguồn cloud bị trộn; chưa tuyên bố đã quan sát nhãn thật bị sửa sai Z.

Hướng sửa: chỉ dùng live cloud khi cả job identity và frame khớp; nếu không đọc đúng chunk của job yêu cầu hoặc hủy
tác vụ khi đổi job. Gắn token vào các phép đo còn chờ và cache kết quả.

Nghiệm thu: hai job dùng cùng số frame, cloud có độ cao đất khác nhau, đổi job giữa lúc chạy; không dùng chéo cloud.

## 7. [P2] Bản đồ mặt đất không dựng lại sau khi sửa box cùng frame

Vị trí: `extension/src/annotator/annotator.js:92–99`; phụ thuộc ở `measure.js:17–20`.

Terrain loại điểm nằm trong các box, nhưng frame cache chỉ theo job/frame/settings và identity mảng cloud. Thêm,
xóa hoặc sửa box cùng frame không thay các khóa này, nên terrain giữ exclusion mask cũ. Số đo tiếp đất và nút Hạ đáy
có thể dựa trên bản đồ khác với lần dựng mới của QC.

Bằng chứng GEO-05: thêm box bao vùng điểm cùng frame/cloud; cache còn 100 ô đất, rebuild theo box mới còn 0.

Hướng sửa: giữ riêng index điểm theo cloud, còn terrain cần revision của các box dùng loại điểm; debounce rebuild khi
kéo và chặn thao tác ghi dựa trên terrain chưa cập nhật.

Nghiệm thu: thêm/xóa/resize/move/outside cùng frame; terrain sau cập nhật phải khớp `Measure.buildFrame()` mới.

## 8. [P2] Truy vấn điểm bỏ sót điểm thật trong box nghiêng

Vị trí: `extension/src/annotator/spatial-grid.js:67–78`; dùng ở `measure.js:37–39`.

Vùng lấy ứng viên và lọc XY chỉ dùng dài/rộng và yaw, không bao được hình chiếu của box có pitch/roll. Narrow phase
theo hệ local phía sau không thể lấy lại những điểm đã bị loại. Vì vậy có thể báo box rỗng hoặc số đo ôm vật sai.

Bằng chứng GEO-03: box `[1,1,10]`, pitch 90°, điểm `[3,0,0]` ở trong box theo `toLocal()`, nhưng `pointsNearBox()`
với margin 0,5 m trả rỗng. Ca này kiểm bất biến lấy đủ điểm, không đại diện độ nghiêng thường gặp của dữ liệu thật.

Hướng sửa: nếu hỗ trợ box nghiêng, broad phase dùng AABB thế giới từ các góc, sau đó lọc chính xác trong hệ local;
nếu chỉ hỗ trợ upright thì chặn kết luận/ghi nhãn cho miền chưa hỗ trợ.

Nghiệm thu: mọi điểm thật nằm trong OBB đều có trong tập ứng viên, với pitch/roll nhỏ/lớn, góc âm và yaw kết hợp.

## Kiểm chứng và giới hạn

- Extension chạy riêng: **134/134 đạt**.
- Extension + QC không gồm auth, chạy nối tiếp file test: **175/175 đạt**, log `tests.tap`.
- Full suite chạy song song có **174/176 đạt**: test thời gian 60.000 điểm đo 306 ms, vượt ngưỡng cứng 300 ms;
  test auth không kết nối được local server với `EACCES 127.0.0.1`. Lượt chạy nối tiếp 175 test phía trên đạt lại test
  thời gian. Không coi lần vượt ngưỡng này là một finding hiệu năng sản phẩm độc lập.
- Test QC ban đầu gặp `EPERM rename` trong TEMP do sandbox; đổi TEMP/TMP sang thư mục artifact được phép ghi thì
  các test file storage đạt. Test auth vẫn chưa xác minh do hạn chế kết nối trong môi trường này.
- Không chạy E2E Chrome/Edge/Opera với CVAT thật, không kiểm Save/reload hoặc Ctrl+Z thật trong lượt review.
- Probe dùng module production trong VM với mock CVAT và dữ liệu tổng hợp. Assertion cố ý xác nhận hành vi lỗi hiện
  hữu; **exit 0 của probe nghĩa là tái hiện lỗi thành công, không phải sản phẩm đã đạt nghiệm thu**.
- `geometry-results.json` được tạo lại trên HEAD nêu đầu báo cáo. Trường `baseline: e845e7d` bên trong là metadata
  hardcode của probe audit cũ, không phải commit đã chạy trong lượt này.

Lệnh tái hiện:

```powershell
node docs/audit-2026-10-29/geometry/probe.cjs
node docs/review-extension-2026-10-30/probe-async.cjs
node --test --test-concurrency=1 extension/tests/*.test.js qc/test/qc.test.js qc/test/fragment.test.js
```

Thứ tự sửa đề xuất: journal/rollback và hủy tác vụ khi đổi job → revision số đo/terrain → hợp đồng box nghiêng →
guard refresh/cloud → E2E CVAT cho thao tác ghi, Undo, Save và tải lại. Module thuần, adapter tách riêng và kế hoạch
sửa có preview là nền tảng tốt; các lỗi hiện tại chủ yếu nằm ở vòng đời dữ liệu và tính toàn vẹn khi ghi bất đồng bộ.

## Trạng thái sửa (30/10/2026)

Đã sửa cả 8 vấn đề; nghiệm thu bằng `extension/tests/review-fixes.test.js` (11 test, module production trong VM với
CVAT giả). Trên code trước khi sửa cả 11 test trượt; sau khi sửa cả 11 đạt. Toàn bộ test chạy nối tiếp: 187/187 đạt.

| # | Sửa |
| --- | --- |
| 1 | `applyEdits` ghi nhận từng state đã lưu; lỗi giữa batch thì trả các frame đó về trạng thái trước (`rollback`). Trả lại không hết thì lỗi mang `record` của phần còn đổi và controller giữ nút Hoàn tác (`keepUndoOnError`). Lỗi đọc lại / vẽ lại sau khi lưu không làm mất bản ghi. Hạ đáy mọi frame gộp bản ghi sau từng lượt và giữ Hoàn tác khi lỗi hoặc dừng. |
| 2 | Vé thao tác `S.opToken` tăng khi đổi job. Bản xem trước mang `jobId` + vé; kết quả về muộn của job cũ bị bỏ; `applyPlan` kiểm job / box / vé trước và sau khi đọc track. Hạ đáy mọi frame và gán thuộc tính dừng khi job đổi. |
| 3 | Khoá cache số đo gồm class, occluded, thuộc tính, nhãn / thuộc tính box khác, revision bản đồ mặt đất và nội dung kích thước keyframe (không dùng số lượng). |
| 4 | `planSizeSync` bù Z thế giới để đáy (góc thấp nhất) đứng yên với box có pitch / roll; box chỉ yaw không đổi. |
| 5 | `refresh` có số thế hệ, bỏ kết quả khi job / frame đã đổi hoặc có lần vẽ lại mới hơn. |
| 6 | `frameCloud` chỉ dùng cloud đang vẽ khi cùng job và cùng frame. |
| 7 | Bản đồ mặt đất dựng lại theo chữ ký các box của frame (thêm / xoá / dời / đổi cỡ / outside); chỉ mục điểm giữ theo cloud. |
| 8 | `pointsNearBox` với box nghiêng lấy vùng tìm từ 8 góc thế giới rồi lọc trong hệ box; box đứng thẳng giữ cách cũ (QC và bảng vẫn cùng kết quả). |

Probe review / audit được viết để xác nhận lỗi, nên giờ chúng trượt ở các ca đã sửa (đúng như mong đợi). Ca `partialSave`
của probe hình học vẫn "tái hiện" vì job giả không có `annotations.get` nên không trả lại được; hành vi mới (lỗi mang bản
ghi Hoàn tác) được kiểm ở `review-fixes.test.js`. Chưa chạy E2E với CVAT thật.
