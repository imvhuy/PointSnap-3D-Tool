# PointSnap chạy ngay trong trang CVAT (không cần extension)

CVAT có sẵn API plugin cho giao diện: `window.cvatUI.registerComponent`, chính là cách plugin SAM của CVAT dùng. Plugin
PointSnap đăng ký qua đó:
- đọc store của CVAT: job đang mở, frame, các object;
- chuyển frame (`changeFrameAsync`) và chọn box (`ACTIVATE_OBJECT`) **không tải lại trang**;
- hiện một khung nhỏ ở góc dưới bên trái trang job.

Dịch vụ QC đặt cùng địa chỉ với CVAT (`/pointsnap-qc/`), nên nhận người dùng **từ phiên đăng nhập CVAT**: không có token
hay đăng nhập riêng.

| Ai | Thấy gì trong CVAT |
|---|---|
| QC (tài khoản trong `QC_USERS`) | Quét job, tiến độ x/N, xem lần lượt mọi object (lỗi tool báo lên đầu, kèm mục tool báo), OK / Trả lỗi / Báo nhầm (Alt+1/2/3, Alt+J bỏ qua), gửi lỗi cho người được giao job, nghiệm thu / trả lại phiếu, hoàn thành job. Trả lỗi lấy **frame đang mở trong CVAT**. QC vẫn duyệt đủ 100% object |
| Annotator | Lỗi QC trả về của job đang mở: tới box, đọc lời QC, Nộp. Nộp bị chặn nếu còn thay đổi chưa Lưu, và có cảnh báo nếu object chưa đổi |
| Mọi người | Bảng annotator của extension (mặt đất, kiểm box, dải track, sửa cả track, spec), không cần cài extension. Spec đọc / lưu ở dịch vụ QC theo project (cả nhóm dùng chung; chỉ QC lưu được) |

Bảng annotator là đúng các script MAIN world của extension: dịch vụ gộp theo thứ tự `extension/manifest.json` ở
`/pointsnap-qc/annotator-panel.js`, plugin nạp file đó và trả lời yêu cầu cấu hình / lưu spec của bảng thay cho
`settings-bridge.js`. Máy nào vẫn cài extension thì chỉ một bảng chạy, và spec lấy từ dịch vụ QC.

Cả bảng annotator lẫn khung QC nằm trong tab **PointSnap** (có logo) ở thanh bên phải, cạnh Objects / Labels, không nổi đè
lên canvas. CVAT chưa có chỗ cắm plugin cho thanh bên nên plugin chèn tab cùng kiểu antd vào DOM; tab đang mở được nhớ
trong trình duyệt.

Code: [qc/public/plugin.js](../qc/public/plugin.js), [qc/public/plugin.css](../qc/public/plugin.css). Phía dịch vụ:
`Auth.fromCvatSession` trong [qc/lib/auth.js](../qc/lib/auth.js) hỏi CVAT `/api/users/self` bằng đúng cookie phiên, nhớ 5
phút, không lưu cookie.

## Cài trên CVAT (đã làm trên CVAT local 28/10/2026)

Thêm 2 file vào thư mục chạy CVAT (`D:\AIvin\cvat`), không sửa file nào của CVAT:

1. `pointsnap-ui.conf`: bản sao file nginx của container `cvat_ui` (`/etc/nginx/conf.d/default.conf`), thêm 2 chỗ.
   - Trong `location /`:
     ```
     sub_filter '</head>' '<script defer src="/pointsnap-qc/plugin.js"></script></head>';
     sub_filter_once on;
     ```
   - Một location mới:
     ```
     location /pointsnap-qc/ {
         proxy_pass http://host.docker.internal:8766/;
         proxy_set_header Host $host;
         proxy_set_header X-Forwarded-Prefix /pointsnap-qc;
         client_max_body_size 2m;
     }
     ```
2. `docker-compose.override.yml`:
   ```yaml
   services:
     cvat_ui:
       volumes:
         - ./pointsnap-ui.conf:/etc/nginx/conf.d/default.conf:ro
   ```

Sau đó chạy lại container giao diện:

```bash
CVAT_HOST=localhost docker compose up -d cvat_ui
```

**Gỡ:** xoá 2 file đó, rồi chạy lại đúng lệnh trên.

**Lưu ý khi chạy lệnh trên:**

- `docker compose up -d cvat_ui` chạy lại cả `cvat_server` nếu cấu hình của nó khác lúc tạo. Ở máy này, `.env` của CVAT có
  `CVAT_HOST=172.16.58.181`, còn các container đang chạy được tạo với `localhost`. Lần chạy đầu không có
  `CVAT_HOST=localhost` nên traefik chỉ nhận địa chỉ 172.16.58.181: **CVAT ở localhost:8080 báo 404 khoảng 2 phút**, tới khi
  chạy lại với `CVAT_HOST=localhost`. Dữ liệu không ảnh hưởng: DB và volume giữ nguyên.
- Dịch vụ QC (cổng 8766) phải đang chạy **trước khi** mở trang CVAT. Trang mở lúc dịch vụ tắt thì không có khung PointSnap;
  CVAT vẫn chạy bình thường, chỉ cần tải lại trang sau khi bật dịch vụ.
- Ở CVAT công ty: admin bên đó làm 2 bước tương tự, và đặt dịch vụ QC ở địa chỉ nginx của CVAT gọi được. Dịch vụ cùng địa
  chỉ với CVAT nên phải dùng HTTPS như CVAT.

## Đã thử (CVAT local, job 76)

- Plugin nạp trong trang CVAT. Dịch vụ nhận đúng người đang đăng nhập CVAT và đúng vai trò.
- **Xem lại box**: CVAT chuyển frame 0 → 37 và chọn đúng box (serverID 1006). **Bỏ qua**: sang frame 29, chọn barrier #49.
  URL không đổi, trang không tải lại.
- Form Trả lỗi lấy đúng frame đang mở (29).
- Chưa thử các thao tác ghi (OK / Trả lỗi / Gửi lỗi / Nộp) trên trang CVAT, vì job 76 trong dữ liệu QC thật đang có kết
  quả quét của bạn. Các thao tác này dùng đúng API đã có test (`qc/test/auth.test.js`).

## Còn thiếu

- **Khoá camera vào box** (extension đã có code, cần đưa sang).
- Hiện lỗi tool báo ngay trên canvas: hiện mới hiện trong khung.
- Phiếu "thiếu vật".
- Đóng gói phần annotator của extension (đo mặt đất, sửa track…) thành plugin, nếu bỏ hẳn extension.
