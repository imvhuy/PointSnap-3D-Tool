/*
 * Chỉ mục không gian nhìn từ trên cho point cloud của một frame: dựng một lần O(N), hỏi theo hình chữ nhật.
 * Thay cho cách cũ (lấy mẫu đều cả cloud xuống ~4000 điểm rồi mới lọc theo bán kính, nên quanh box gần như hết điểm).
 */
(function (root) {
  'use strict';

  const MAX_CELLS = 4_000_000;

  /**
   * `positions`: Float32Array/Array phẳng [x0, y0, z0, x1, …] (đúng mảng `geometry.attributes.position.array`).
   * Ô có cạnh `cell` mét; vùng bao quá lớn thì tự nới ô để số ô ≤ MAX_CELLS.
   * Điểm có tọa độ NaN / Infinity (PCD giữ chỗ cho tia không phản xạ) không vào lưới: một điểm như vậy làm vùng bao
   * vô hạn và cả frame không tra được điểm nào.
   */
  function build(positions, cell = 1) {
    const count = Math.floor(positions.length / 3);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i += 1) {
      if (!isFinitePoint(positions, i)) continue;
      const x = positions[3 * i], y = positions[3 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX === Infinity) return empty(positions, count, cell);
    let size = cell;
    while (Math.ceil((maxX - minX) / size + 1) * Math.ceil((maxY - minY) / size + 1) > MAX_CELLS) size *= 2;
    const nx = Math.ceil((maxX - minX) / size) + 1, ny = Math.ceil((maxY - minY) / size) + 1;
    const cellOf = new Int32Array(count).fill(-1);
    const starts = new Int32Array(nx * ny + 1);
    for (let i = 0; i < count; i += 1) {
      if (!isFinitePoint(positions, i)) continue;
      const c = Math.floor((positions[3 * i + 1] - minY) / size) * nx + Math.floor((positions[3 * i] - minX) / size);
      cellOf[i] = c;
      starts[c + 1] += 1;
    }
    for (let c = 0; c < nx * ny; c += 1) starts[c + 1] += starts[c];
    const order = new Int32Array(count), fill = starts.slice(0, nx * ny);
    for (let i = 0; i < count; i += 1) if (cellOf[i] >= 0) order[fill[cellOf[i]]++] = i;

    /** Gọi `visit(i)` cho mọi điểm có x ∈ [x0, x1], y ∈ [y0, y1] (theo ô, caller tự lọc chính xác). */
    function forEachIn(x0, y0, x1, y1, visit) {
      const ix0 = Math.max(0, Math.floor((x0 - minX) / size)), ix1 = Math.min(nx - 1, Math.floor((x1 - minX) / size));
      const iy0 = Math.max(0, Math.floor((y0 - minY) / size)), iy1 = Math.min(ny - 1, Math.floor((y1 - minY) / size));
      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const c = iy * nx + ix;
          for (let k = starts[c]; k < starts[c + 1]; k += 1) visit(order[k]);
        }
      }
    }

    return { positions, count, forEachIn };
  }

  function empty(positions, count, cell) {
    return { positions, count, cell, forEachIn() {} };
  }

  function isFinitePoint(positions, i) {
    return Number.isFinite(positions[3 * i]) && Number.isFinite(positions[3 * i + 1]) && Number.isFinite(positions[3 * i + 2]);
  }

  /** Các điểm (chỉ số) quanh footprint xoay của box, nới `margin` mét; lọc chính xác theo hệ box. */
  function pointsNearBox(grid, box, margin) {
    const reach = Math.hypot(box.dims[0] / 2 + margin, box.dims[1] / 2 + margin);
    const [cx, cy] = box.center, c = Math.cos(box.rotation[2]), s = Math.sin(box.rotation[2]);
    const hl = box.dims[0] / 2 + margin, hw = box.dims[1] / 2 + margin;
    const out = [];
    const p = grid.positions;
    grid.forEachIn(cx - reach, cy - reach, cx + reach, cy + reach, (i) => {
      const dx = p[3 * i] - cx, dy = p[3 * i + 1] - cy;
      if (Math.abs(c * dx + s * dy) <= hl && Math.abs(-s * dx + c * dy) <= hw) out.push(i);
    });
    return out;
  }

  /**
   * Đoạn thẳng `from` → `to` có bị điểm chắn không: ≥ `minPoints` điểm cách đoạn < `radius` m, nằm giữa (bỏ 1 m đầu và
   * `endGapM` cuối), và `ignore(i)` = false (vd điểm của chính vật). Dùng để biết một mặt box có thật sự nhìn thấy.
   */
  function segmentBlocked(grid, from, to, { radius = 0.3, endGapM = 0.5, minPoints = 3, ignore = () => false } = {}) {
    const d = to.map((v, i) => v - from[i]), len = Math.hypot(...d);
    if (len < 1 + endGapM) return false;
    const u = d.map((v) => v / len), p = grid.positions, seen = new Set();
    let blocked = 0;
    for (let t = 1; t < len - endGapM && blocked < minPoints; t += radius * 2) {
      const x = from[0] + u[0] * t, y = from[1] + u[1] * t;
      grid.forEachIn(x - radius, y - radius, x + radius, y + radius, (i) => {
        if (seen.has(i) || blocked >= minPoints) return;
        seen.add(i);
        const w = [p[3 * i] - from[0], p[3 * i + 1] - from[1], p[3 * i + 2] - from[2]];
        const along = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
        if (along <= 1 || along >= len - endGapM) return;
        const perp = Math.hypot(w[0] - along * u[0], w[1] - along * u[1], w[2] - along * u[2]);
        if (perp < radius && !ignore(i)) blocked += 1;
      });
    }
    return blocked >= minPoints;
  }

  const api = { build, pointsNearBox, segmentBlocked, isFinitePoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapGrid = api;
})(globalThis);
