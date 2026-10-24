/*
 * Chạy sớm nhất khi trang CVAT bắt đầu tải (document_start): nếu đang ở trang của một task / job,
 * chuẩn bị sẵn bộ lọc PointSnap trong lịch sử bộ lọc trước khi CVAT dựng trang job.
 */
(function (root) {
  'use strict';

  const m = location.pathname.match(/\/tasks\/(\d+)/);
  if (!m) return;
  root.PointSnapCvatApi.seedFilterForTask(Number(m[1]), root.PointSnapCore.FLAG_ATTR).catch(() => {
    // Chưa đăng nhập hoặc task không có thuộc tính cờ: phần bảng điều khiển sẽ báo khi mở job.
  });
})(globalThis);
