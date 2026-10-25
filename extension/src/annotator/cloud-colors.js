/*
 * Tô màu trực tiếp các điểm của point cloud CVAT (A4): điểm của vật trong box xanh lá, điểm lòi ra ngoài box đỏ.
 * Chỉ đổi màu hiển thị (thuộc tính `color` của geometry three.js mà 4 view dùng chung), không đụng nhãn. Màu gốc
 * được giữ lại và trả về khi bỏ chọn box, đổi box hoặc đổi frame.
 */
(function (root) {
  'use strict';

  const INSIDE = [0.13, 0.77, 0.37]; // xanh lá #22c55e
  const OUTSIDE = [0.94, 0.27, 0.27];
  let geometry = null, saved = new Map(), lastKey = '';

  function restore() {
    const colors = geometry?.attributes?.color;
    if (colors && saved.size) {
      for (const [i, rgb] of saved) colors.array.set(rgb, 3 * i);
      colors.needsUpdate = true;
    }
    saved = new Map();
    lastKey = '';
  }

  /** Dấu của cả danh sách chỉ số: kéo box làm đổi điểm ở giữa danh sách mà số lượng và hai đầu vẫn giữ nguyên. */
  function hash(indices) {
    let h = indices.length;
    for (const i of indices) h = (Math.imul(h, 31) + i) | 0;
    return h;
  }

  function paint(colors, indices, rgb) {
    for (const i of indices) {
      if (!saved.has(i)) saved.set(i, colors.array.slice(3 * i, 3 * i + 3));
      colors.array.set(rgb, 3 * i);
    }
  }

  /**
   * Tô `insideIdx` / `outsideIdx` (chỉ số điểm trong mảng position của `cloud`). Trả về false khi cloud không có thuộc
   * tính màu để caller vẽ lớp phủ thay thế.
   */
  function highlight(cloud, insideIdx, outsideIdx) {
    const colors = cloud?.geometry?.attributes?.color;
    if (!colors || !cloud.material?.vertexColors) { clear(); return false; }
    if (cloud.geometry !== geometry) { saved = new Map(); lastKey = ''; geometry = cloud.geometry; } // frame mới: màu cũ đã mất cùng geometry cũ
    const key = `${hash(insideIdx)}:${hash(outsideIdx)}`;
    if (key === lastKey) return true;
    restore();
    paint(colors, insideIdx, INSIDE);
    paint(colors, outsideIdx, OUTSIDE);
    colors.needsUpdate = true;
    lastKey = key;
    return true;
  }

  function clear() {
    restore();
  }

  root.PointSnapCloudColors = { highlight, clear };
})(globalThis);
