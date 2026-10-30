# CVAT — bằng chứng tích hợp cho PointSnap 3D

**Truy cập nguồn:** 26/10/2026.  
**Phương pháp:** 10 truy vấn tìm kiếm, đọc sâu tài liệu/API và mã nguồn chính thức. Exa/Firecrawl không được cung cấp trong phiên; dùng công cụ web. Nguồn nhánh `develop` là quan sát tại ngày truy cập, không phải hợp đồng tương thích cho CVAT đang triển khai. Ngày xuất bản của các trang sống không được xác định.

## Kết luận ảnh hưởng trực tiếp đến thiết kế

1. **PointSnap phải sở hữu giao diện QC 3D của mình.** Tài liệu Manual QA của CVAT nói Review mode không áp dụng cho task 3D; Automated QA cũng chỉ hỗ trợ task 2D. Vì vậy đề xuất nội bộ lấy CVAT Issues làm kênh chính cần sửa: API tồn tại chưa chứng minh issue được nhìn thấy/giải quyết trên canvas 3D. [C01](#c01-manual-qa), [C02](#c02-automated-qa), [C03](#c03-issues-api)
2. **Đọc point cloud trực tiếp từ CVAT là hướng có nền tảng API**, nhưng phải giải quyết ánh xạ chunk/frame, giải mã, quyền, hủy và cache. Không được coi `job.frames.get().data()` là mảng XYZ sẵn sàng hoặc không ảnh hưởng player. [C04](#c04-jobs-api), [C05](#c05-frame-source)
3. **Undo nhiều frame cần thiết kế riêng có nhật ký.** History transaction hiện chỉ chứa một frame; freeze bỏ qua ghi lịch sử. Kết quả này củng cố lỗi partial-write đã thấy ở adapter PointSnap. [C06](#c06-history), [C07](#c07-save-states)
4. **Tỉa keyframe phải đối chiếu đúng nội suy CVAT.** Đường nội suy 3D hiện dùng tuyến tính cho tọa độ/kích thước và cung ngắn nhất cho từng góc Euler. Không thay bằng quaternion SLERP rồi tuyên bố tương đương. [C08](#c08-cuboid-interpolation)
5. **Ưu tiên API/plugin action có sẵn, cô lập phần nội bộ.** Có entrypoint cấp store/core/actionCreators, nhưng chưa tìm được cam kết ổn định công khai cho các trường canvas/Redux mà extension chạm tới. [C09](#c09-plugin-entrypoint)

## Thẻ bằng chứng

### C01. Manual QA

- Nguồn: [Manual QA and Review](https://docs.cvat.ai/docs/qa-analytics/manual-qa/).
- Quan sát: phần Note đầu bài giới hạn Review mode, không áp dụng cho task 3D (trang hiện hành, dòng 284–286 khi đọc).
- Tin cậy: cao cho phạm vi được tài liệu công bố; chưa kiểm UI bản CVAT mục tiêu.
- Đề xuất: checklist/list/overlay 3D do PointSnap cung cấp; thử nghiệm Issues chỉ là một spike có tiêu chí kết thúc rõ.

### C02. Automated QA

- Nguồn: [Automated QA, Review & Honeypots](https://docs.cvat.ai/docs/qa-analytics/auto-qa/).
- Quan sát: Quality estimation chỉ hỗ trợ task 2D, loại trừ cả cuboid 2D; bài cũng mô tả so với ground-truth subset.
- Tin cậy: cao về giới hạn công bố hiện tại. Không thể suy từ tên “cuboid” trong danh sách sản phẩm rằng native QA hỗ trợ LiDAR.
- Đề xuất: PointSnap cung cấp QC hình học 3D và coverage riêng.

### C03. Issues API

- Nguồn: [IssuesApi class reference](https://docs.cvat.ai/docs/api_sdk/sdk/reference/apis/issues-api/).
- Quan sát: có create/list/retrieve/update/delete; dữ liệu tạo có frame, job, position, message, assignee và resolved.
- Giới hạn: schema/API không chứng minh định vị, hiển thị, điều hướng và resolve trong job 3D.
- Đề xuất: chỉ bật adapter Issues khi test đủ tạo → đọc → annotator mở đúng đối tượng → trả lời/resolve → tải lại.

### C04. Jobs API

- Nguồn: [JobsApi class reference](https://docs.cvat.ai/docs/api_sdk/sdk/reference/apis/jobs-api/).
- Quan sát: có endpoint lấy dữ liệu/meta và PATCH annotation. `retrieve_data` nhận chunk `index` theo job; `number` cho chunk đã deprecated. Tài liệu nêu checksum/kích thước/ngày cập nhật và phản hồi 200/206/416.
- Đề xuất: adapter thương lượng theo schema server; test job bắt đầu giữa task, frame step, frame bị xóa, chunk cuối thiếu và chất lượng dữ liệu.

### C05. Frame source

- Nguồn: [cvat-core/src/frames.ts](https://raw.githubusercontent.com/cvat-ai/cvat/develop/cvat-core/src/frames.ts).
- Quan sát: dữ liệu được cache theo job; `FrameData.data()` trả `imageData` dạng Blob/ImageBitmap. Các lần decode dùng request mới nhất, có thể từ chối request cũ. Có các phép đổi frame task/job theo metadata.
- Suy luận cần thử: scan nền có thể tranh decode với player khi người dùng chuyển frame. Cần hàng đợi có ưu tiên/hủy hoặc reader REST riêng; cache của CVAT và PointSnap phải được tính chung.

### C06. History

- Nguồn: [cvat-core/src/annotations-history.ts](https://raw.githubusercontent.com/cvat-ai/cvat/develop/cvat-core/src/annotations-history.ts).
- Quan sát: giới hạn lịch sử là 32; transaction kiểm các action cùng frame. Khi history frozen, `do` bỏ qua action. Transaction có abort và undo.
- Đề xuất: multi-frame apply dùng journal trước ghi, ghi nhận phần thành công và rollback bù; luôn nhả freeze trong finally. Test lỗi ở mọi vị trí batch và rollback lỗi.

### C07. Save states

- Nguồn: [cvat-core/src/annotations-collection.ts](https://github.com/cvat-ai/cvat/blob/develop/cvat-core/src/annotations-collection.ts).
- Quan sát: đường save nhóm mở history transaction, gọi save từng annotation, abort khi lỗi và đóng transaction khi kết thúc.
- Giới hạn: đây là thay đổi bộ nhớ frontend; không suy ra giao dịch server hoặc khóa nhiều người dùng. Chưa xác lập hợp đồng HTTP compare-and-swap cho nhãn từ tài liệu đã đọc.
- Đề xuất: dùng capability probe và test Save/reload; giữ riêng revision snapshot, phiên nhãn và trạng thái lưu server.

### C08. Cuboid interpolation

- Nguồn: [cvat-core/src/annotations-objects/cuboid-track.ts](https://raw.githubusercontent.com/cvat-ai/cvat/develop/cvat-core/src/annotations-objects/cuboid-track.ts).
- Quan sát: points được nội suy tuyến tính; riêng chỉ số 3–5 của cuboid 3D được thay bằng nội suy góc Euler theo cung ngắn nhất. Occluded/outside ở đường này lấy từ phía trái.
- Đề xuất: golden fixtures so trực tiếp với CVAT cho ±π, roll/pitch, outside/occluded và boundary job; giữ mốc thay đổi thuộc tính khi tỉa.

### C09. Plugin entrypoint

- Nguồn: [cvat-ui/src/components/plugins-entrypoint.tsx](https://raw.githubusercontent.com/cvat-ai/cvat/develop/cvat-ui/src/components/plugins-entrypoint.tsx).
- Quan sát: `window.cvatUI.registerComponent` truyền core/store/dispatch/actionCreators, gồm changeFrameAsync; có callback cập nhật trạng thái và destructor, sự kiện plugins.ready.
- Đề xuất: dùng entrypoint/actionCreators thay action Redux tự viết khi khả dụng; cleanup listener/overlay/worker trong destructor. Các cấu trúc mesh/camera nội bộ vẫn cần adapter và kiểm thử phiên bản.

### C10. User roles

- Nguồn: [User roles](https://docs.cvat.ai/docs/account_management/user-roles/).
- Quan sát: quyền hệ thống và tổ chức khác nhau; organization Worker bị giới hạn ở job được giao. Annotation/Validation/Acceptance là stage, không phải role.
- Đề xuất: ma trận nghiệm thu gồm Worker/assignee, supervisor và maintainer, cả project cá nhân/tổ chức; đọc được job không đồng nghĩa được sửa schema hay tạo issue ở mọi stage.

### C11. Access tokens

- Nguồn: [Access Tokens](https://docs.cvat.ai/docs/api_sdk/access_tokens/).
- Quan sát: session dùng session ID/CSRF; PAT được khuyến nghị cho API/CLI/SDK và dùng Bearer, có read-only/read-write và hạn dùng. Legacy token đã deprecated.
- Đề xuất: luồng browser dùng phiên CVAT hiện tại; backend tùy chọn dùng PAT tối thiểu quyền, có hạn dùng, không lưu chung cấu hình được chia sẻ.

### C12. Native 3D workflow

- Nguồn: [3D object annotation](https://docs.cvat.ai/docs/annotation/manual-annotation/modes/3d-object-annotation/).
- Quan sát: CVAT hỗ trợ shape và track 3D; track giữ ID trong chuỗi frame và dùng nội suy. Có các hình chiếu để chỉnh cuboid, contextual images khi dataset cung cấp và mũi tên các trục.
- Đề xuất: PointSnap bổ sung số đo/điều hướng/QC vào workflow đang có; kiểm phím tắt và camera khi nghiệm thu để tránh xung đột thao tác.

## Các quyết định kỹ thuật đề xuất

### 1. Reader cho QC

- POC A: đọc qua cvat-core trong MAIN world, chuyển kết quả cần thiết sang compute worker; scan tuần tự, ưu tiên người dùng, ghi coverage khi hủy/lỗi.
- POC B: lấy chunk qua REST cùng origin/session, giải nén/PCD trong worker; cần test CSRF/quyền, metadata và version.
- Chọn dựa trên correctness, UI responsiveness, peak memory và tương thích, không chỉ một số đo tốc độ đọc frame cache nóng.
- Không tải lại nhãn server rồi coi đó là trạng thái đang sửa chưa Save. Scan cần công bố rõ nguồn là draft phiên hiện tại hay bản đã lưu.

### 2. Phục hồi mutation

- Chuẩn bị journal đầy đủ và revision đầu vào trước mutation đầu tiên.
- Kiểm tra kế hoạch, lock, frame và annotation còn tồn tại; cập nhật preview khi dữ liệu đổi.
- Apply theo nhóm capability cho phép; lỗi trả journal cùng phần đã ghi, không chỉ ném exception mất trạng thái.
- Undo chỉ ghi lại frame vẫn trùng post-state của thao tác; báo frame đã sửa tiếp và giữ nguyên chúng.
- Nghiệm thu cả Apply/Undo lỗi giữa chừng, Save/reload và restart/reload làm mất in-memory history.

### 3. Phiên bản và tương thích

- Ghi phiên bản server, browser, extension và schema/guideline trong mỗi kết quả.
- Chọn một phiên bản CVAT chuẩn để đóng P0; thêm phiên bản thứ hai sau khi contract tests đạt.
- Probe capabilities cho registerComponent, frame decoder, saveStates và history thay vì chỉ so chuỗi phiên bản.
- Mọi phụ thuộc develop cần pin tag/commit tương ứng bản triển khai trước khi lập golden fixtures.
- Capability không được chứng minh phải hiển thị chưa hỗ trợ; không bật đường ghi bằng suy đoán.

## Điều chưa kết luận được

- CVAT Issues hiển thị/resolve hoàn chỉnh trên canvas 3D của bản mục tiêu.
- Quyền thực tế trên CVAT công ty, các policy OPA tùy biến và khả năng thêm plugin.
- Dạng PCD/chunk và cơ chế frame mapping của bản mục tiêu khi có frame step, deleted frame hoặc segment lệch đầu.
- Số đo hiệu năng scan khi người dùng thao tác đồng thời; chưa chạy CVAT thật trong nghiên cứu này.
- Cam kết ổn định/semver cho các trường nội bộ canvas/Redux mà PointSnap hiện truy cập.

## Nhật ký phương pháp

- 10 truy vấn: nhóm 3D/interpolation; jobs/chunk/annotation; issues/review3D; history/saveStates; plugin registerComponent.
- 12 nguồn chính được giữ trong các thẻ C01–C12; đã đọc phần nội dung/API/source liên quan, không chỉ snippet tìm kiếm.
- Hai URL cũ/đoán (`contributing/plugins/`, `access-tokens/`) không truy cập được; URL Access Tokens đúng lấy từ điều hướng chính thức.
- Có đọc thêm mã plugin SAM chính thức để đối chiếu cách đăng ký plugin; không đưa thành nguồn độc lập để tránh trùng bằng chứng.
- Chỉ thêm file nghiên cứu này; không sửa mã production hoặc gọi server CVAT của người dùng.
