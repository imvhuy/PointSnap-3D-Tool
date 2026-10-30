# Kiểm toán hình học và bảng annotator

Ngày 29/10/2026. Baseline: `e845e7d8cc258acd35e89925212cbea51cdac749`. Phạm vi: `extension/src/annotator/`; không sửa mã sản phẩm, không mở hay sửa nhãn CVAT thật.

## Kết luận

Các module thuần đã tách khá tốt: `box` làm đổi hệ tọa độ, `spatial-grid` lấy ứng viên, `terrain` ước lượng đất, `measure` hợp số đo và `checks` áp ngưỡng; `track-ops` chỉ lập kế hoạch, adapter mới ghi. Tuy nhiên chưa đủ để khẳng định hoạt động chính xác nhất trong gán nhãn LiDAR. Đã tái hiện 5 nhóm lỗi/ràng buộc chưa được chặn, với 6 ca cụ thể. Hai nghi vấn cũ về batch Undo và giữ đáy khi đồng bộ kích thước vẫn tồn tại ở baseline này.

Phép chạy: `node docs/audit-2026-10-29/geometry/probe.cjs`. Kết quả: [results.json](results.json). **Probe assert hành vi sai hiện tại nên exit 0 có nghĩa là tái hiện thành công; không có nghĩa sản phẩm đạt.** Mỗi assertion cần đổi sang kỳ vọng đúng khi sửa lỗi rồi mới đưa vào suite chính.

## Lỗi đã tái hiện

| ID | Ưu tiên | Vị trí trong mã sản phẩm | Bằng chứng và tác động |
|---|---|---|---|
| GEO-01 | P1 | `cvat-adapter.js:147–175`; `annotator.js:432–436` | Cài lỗi `state.save()` ở frame 1: frame 0 đã ghi, frame 1 lỗi, hàm reject và không trả record; CVAT history bị freeze trong lúc ghi. `S.lastUndo` chỉ được gán sau khi `applyEdits()` thành công. Có sửa một phần nhưng không có journal mới để người dùng hoàn tác. |
| GEO-02 | P1 với box roll/pitch đang được chấp nhận | `track-ops.js:33–46` | Box pitch 30°, dài 4→6 m, các chiều khác giữ nguyên: đáy từ 1,133974596 m xuống 0,133974596 m, lệch **−1 m**, dù mô tả thao tác giữ đáy. Code dịch tâm theo hệ local nhưng chỉ bù local Z bằng chênh chiều cao/2. Control box chỉ yaw giữ đáy đúng. |
| GEO-03 | P2, cùng ràng buộc box nghiêng | `spatial-grid.js:80–93`; các caller trong `measure.js` | Điểm `[3,0,0]` nằm trong OBB có dims `[1,1,10]`, pitch 90°; `B.toLocal()` xác nhận ở local `[~0,0,3]`, nhưng `pointsNearBox(..., 0.5)` trả rỗng. Vùng hỏi và lọc ứng viên dùng footprint yaw, không đủ bao OBB roll/pitch. Có thể thiếu điểm đầu vào dù phép kiểm local phía sau đúng. |
| GEO-04 | P1 | `annotator.js:153–171`; reload `193–218`; listener `732–736` | Đổi class từ car thành pedestrian, giữ hình học/ID/attributes: cached measurement vẫn là car và không báo sai cỡ; chạy `Measure.measureBox()` mới báo sai cỡ. Reload track thay dims keyframe khác mà số keyframe vẫn là 3: cache vẫn không báo `size.in_track`; tính mới có lỗi. Key chỉ chứa hình học box hiện tại, hình học các box khác, số lượng keyframe và attributes hiện tại; thiếu label, occluded, nội dung keyframe và semantic box khác. Listener thay states chỉ đánh dấu track dirty, không xóa measure key. |
| GEO-05 | P2 | `annotator.js:87–96`; `measure.js:19–21`; `terrain.js:38–51` | Terrain dùng các box để loại điểm, nhưng frame cache chỉ xét job/frame/settings và identity mảng positions. Thêm box bao vùng điểm ngay cùng frame: terrain cache vẫn 100 ô đất, rebuild cùng dữ liệu và box mới còn 0. Hai bên annotator và QC có thể dùng terrain khác nhau sau khi sửa nhãn. |

P1 là lỗi cần xử lý trước khi coi thao tác sản xuất đáng tin cậy; P2 có thể xử lý ở vòng kế tiếp nếu quy trình chặn rõ đầu vào bị ảnh hưởng. GEO-02/GEO-03 có thể giảm phạm vi bằng cách **từ chối có giải thích** box roll/pitch ngoài miền đã hỗ trợ; không được tự bỏ roll/pitch rồi hiển thị kết luận như đã kiểm đủ.

### Hướng sửa và tiêu chí nghiệm thu

**GEO-01 — giao dịch sửa nhãn.** Lập journal trước khi ghi; theo dõi phần đã thành công; rollback khi có lỗi. Nếu rollback cũng lỗi, giữ journal và thông báo số frame đã ghi/phục hồi/chưa phục hồi. Tách lỗi refresh khỏi lỗi ghi để refresh thất bại không làm mất journal. Đảm bảo unfreeze lịch sử trong mọi nhánh. Không được ghi đè một thay đổi mới của annotator trong lúc rollback.

Nghiệm thu: lỗi ở frame đầu/giữa/cuối, lỗi refresh, lỗi rollback, khóa thay đổi khi đang chờ và double-click; tất cả hoặc không đổi dữ liệu, hoặc có danh sách phần còn đổi và đường phục hồi. E2E phải Save, tải lại rồi đối chiếu dữ liệu; mock không chứng minh hành vi lịch sử của CVAT.

**GEO-02/GEO-03 — hợp đồng hình học.** Chốt rõ upright cuboid hay OBB Euler XYZ đầy đủ. Nếu hỗ trợ đầy đủ, broad phase lấy AABB thế giới từ 8 góc rồi narrow phase theo local; overlap không dùng chiều cao `centerZ ± height/2` như hiện tại cho box nghiêng. Đồng bộ cỡ cần dựng box mới, tính `bottomZ` từ góc thế giới rồi hiệu chỉnh tâm Z theo bất biến mong muốn; kiểm lại xung đột với yêu cầu giữ mặt gần LiDAR. Nếu chỉ upright, kiểm và khóa mọi thao tác/phép kiểm không hợp lệ trên box nghiêng.

Nghiệm thu: yaw-only control; roll/pitch 1°, 5°, 15°, 30°, 90°; góc âm; sensor bất kỳ. Điểm thuộc OBB luôn có trong tập ứng viên. `toLocal(toWorld(p))` khớp trong sai số số học. Sau sync, tâm XY và các mặt cần giữ phải khớp hợp đồng đã chọn, đáy lệch không quá 1 mm trên fixture. Ground snap đã dùng `B.bottomZ` để bù world Z nên không phải cùng lỗi với size sync.

**GEO-04 — invalidation số đo.** Dùng revision thay vì chỉ count: revision semantic/hình học frame, revision toàn bộ keyframe track, revision guideline. Không chỉ thêm label hiện tại rồi bỏ các phụ thuộc khác. Invalidate sau Undo/redo, đổi class/attributes/occluded/outside, khóa hay sửa object liên quan. Không cần rebuild point index chỉ vì đổi class.

Nghiệm thu: từng ca đổi độc lập label, occluded, required attribute, label/attributes/ID object bên cạnh, dims keyframe khác với cùng count. Cached và uncached phải trùng `classKey`, issue keys/severity, contact và các mặt đo. Test qua listener như CVAT thực, không chỉ gọi helper.

**GEO-05 — invalidation địa hình.** Giữ index điểm theo identity cloud nhưng phiên bản terrain phải theo box exclusion mask. Debounce rebuild khi kéo, hiển thị đang tính hoặc số đo tạm và không cho snap dựa vào terrain lỗi thời. Cần đo chi phí rebuild trên point cloud lớn để không đưa thao tác nặng vào mỗi animation frame.

Nghiệm thu: thêm/xóa/di chuyển/resize box, outside đổi ở cùng frame; sau ổn định, terrain annotator và `Measure.buildFrame()` của QC phải trùng. Khi đang rebuild, thao tác ghi dùng số đo mới nhất hoặc bị chặn với lý do rõ.

## Phần tốt và giới hạn phải công bố

| Nhóm | Đã có nền tảng tốt | Còn thiếu bằng chứng hoặc giới hạn |
|---|---|---|
| Hình học | Ma trận Euler XYZ, local/world, corner và min bottom; guard finite/positive dims | Các phép downstream footprint, height overlap, ground query giả định upright; thiếu hợp đồng miền thống nhất |
| Ground | Lọc điểm object, local grid, coarse ground, giới hạn range và `ground.no_evidence` | Confidence là heuristic hỗ trợ, chưa là xác suất đã hiệu chuẩn; mặt đường nhiều tầng, sparse/rain/snow và sensor khác cần holdout |
| Fit/điểm object | Connected voxel, loại điểm object khác, xét mặt quay về LiDAR và che khuất | Khả năng nối sang cây/tường hoặc rời cụm là tính chất heuristic; không chứng minh box ôm đúng amodal extent của vật |
| Track ops | Preview; kế hoạch thuần; giữ sự kiện outside/occluded/attributes khi thinning; short-angle interpolation | Yaw smoothing theo hàng xóm không xác định được cả track quay ngược; mọi góc/điểm cần contract CVAT theo version, không chỉ control synthetic |
| Adapter | Một cửa duy nhất tới CVAT internals; không tự Save; record Undo tránh ghi đè frame đã sửa tiếp | Batch thất bại, thay job/frame khi async, xung đột Undo và API CVAT khác version cần E2E/fault injection |
| Cache | Giữ index để tránh quét lại point cloud trong mỗi render | Thiếu các phụ thuộc dữ liệu như các probe đã chứng minh |

Ngoài ra, `annotator.js:271–282` tự thêm cảnh báo checklist **Ôm vật** theo mặt lòi/điểm đỏ. `Checks.checkBox()` dùng bởi scanner không có cùng phép thêm này. Đây là khác phạm vi chức năng, cần đưa vào tài liệu/rule engine nếu muốn tuyên bố “annotator và QC kết luận giống nhau”; chưa phải probe độc lập về một lỗi mới.

## Kế hoạch kiểm thử cần bổ sung

1. **Unit invariants:** phép biến đổi, candidate completeness, giữ đáy, thinning reconstruction; random seed cố định, không dùng cùng công thức làm oracle cho mọi assertion.
2. **Integration adapter với fault injection:** thất bại/khóa/ngắt ở mọi bước batch; đảm bảo journal còn truy cập được; refresh fail; Undo sau sửa khác.
3. **Integration controller:** so cached/uncached sau từng thay đổi semantic/geometry; thêm version vào phụ thuộc async; không áp preview của job/track cũ.
4. **E2E CVAT:** ma trận version được hỗ trợ, Chrome/Edge; chọn/sửa/Undo/Save/reload, đổi frame/job trong lúc pending, cùng lúc dùng plugin và extension. Chưa chạy E2E trong audit geometry này.
5. **Holdout chất lượng LiDAR:** nhóm sensor, range, point count, class, occlusion, dốc/bờ vỉa, giao cắt/đa tầng. Đo precision, recall, coverage/no-evidence, sai số ground và thời gian người dùng thực; không dùng cùng scene/seed để vừa chỉnh ngưỡng vừa nghiệm thu.

## Cách tạo bằng chứng

Probe chỉ dùng Node stdlib. Adapter được chạy nguyên văn trong `vm` với mock `ObjectState.save()`/freeze để tiêm lỗi; controller được giữ nguyên logic, chỉ thêm export các closure cho phép gọi `measureActive`/`frameData`, còn số đo dùng module thật. Có control batch thành công+Undo và box upright. Các fixture là dữ liệu tổng hợp nhằm kiểm tra bất biến; không đại diện phân bố lỗi hay độ chính xác ngoài thực tế. Không truy cập network, secrets hay dữ liệu CVAT của người dùng.

Các module được đọc: box, spatial-grid, terrain, object-points, measure, checks, track-ops, cvat-adapter và annotator. Skill áp dụng: `engineering-code-review`, `engineering-testing-strategy`. Khuyến nghị ở trên là kết luận review và thiết kế nghiệm thu; chưa được triển khai.
