/*
 * Bản đồ địa hình của một frame (theo hướng GroundGrid, RA-L 2024), dựng một lần khi đổi frame, rồi tra O(1) cho box.
 *
 * 1. Bỏ điểm nằm trong box đã gán (nới `excludeMarginM`): đó là điểm của vật, không phải đất.
 * 2. Lưới `cellM`: mỗi ô lấy z thấp nhất. Điểm thấp hơn trung vị z thấp nhất của 3×3 ô quanh quá `outlierDropM` là
 *    tia phản xạ dưới mặt đất, bị bỏ (lưới min-Z cũ bị chính các điểm này kéo xuống).
 * 3. Mỗi ô giữ số điểm, trung bình, phương sai (Welford) của điểm trong dải [sàn, sàn + `bandM`].
 * 4. Ô là đất khi vùng 3×3 (5×5 khi xa hơn `farM`) quanh nó đủ điểm và độ lệch chuẩn gộp ≤ sigma(khoảng cách):
 *    mặt đường phẳng, còn thân vật / bụi cây làm phương sai lớn.
 * 5. Ô không thấy đất (gầm xe, bị che) nội suy từ các ô đất lân cận theo nghịch đảo bình phương khoảng cách,
 *    kèm độ tin cậy giảm dần theo khoảng cách tới ô đất thật gần nhất.
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox || require('./box.js');
  const Grid = root.PointSnapGrid || require('./spatial-grid.js');

  const DEFAULTS = {
    cellM: 0.4,
    excludeMarginM: 0.2,
    outlierDropM: 0.3,
    bandM: 2.0,
    minPoints: 3,
    sigmaBaseM: 0.05,
    sigmaPerM: 0.0015,
    farM: 20,
    maxReachM: 2.0,
    reachPerM: 0.05,
    minSupportCells: 6,
    coarseRadiusM: 15,
    coarsePercentile: 0.2,
    origin: [0, 0, 0],
  };
  const ANY_HEIGHT = { minZ: -Infinity, maxZ: Infinity };
  const CONTACT_BAND_M = 1.0;

  /** Điểm không dùng làm đất: điểm của box đã gán và điểm có tọa độ NaN / Infinity. */
  function excludedMask(grid, boxes, marginM) {
    const mask = new Uint8Array(grid.count);
    const p = grid.positions;
    for (let i = 0; i < grid.count; i += 1) if (!Grid.isFinitePoint(p, i)) mask[i] = 1;
    for (const box of boxes) {
      const lo = box.center[2] - box.dims[2] / 2 - marginM, hi = box.center[2] + box.dims[2] / 2 + marginM;
      for (const i of Grid.pointsNearBox(grid, box, marginM)) {
        const z = p[3 * i + 2];
        if (z >= lo && z <= hi) mask[i] = 1;
      }
    }
    return mask;
  }

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  /** `grid`: kết quả `PointSnapGrid.build` của cùng point cloud. `boxes`: box đã gán trong frame. */
  function build(grid, boxes, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const p = grid.positions, n = grid.count;
    const excluded = excludedMask(grid, boxes, o.excludeMarginM);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (excluded[i]) continue;
      const x = p[3 * i], y = p[3 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX === Infinity) return unavailable();
    let cell = o.cellM;
    while (Math.ceil((maxX - minX) / cell + 1) * Math.ceil((maxY - minY) / cell + 1) > 4_000_000) cell *= 2;
    const nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1, cells = nx * ny;
    const cellOf = new Int32Array(n).fill(-1);
    const lowest = new Float32Array(cells).fill(Infinity);
    for (let i = 0; i < n; i += 1) {
      if (excluded[i]) continue;
      const c = Math.floor((p[3 * i + 1] - minY) / cell) * nx + Math.floor((p[3 * i] - minX) / cell);
      cellOf[i] = c;
      if (p[3 * i + 2] < lowest[c]) lowest[c] = p[3 * i + 2];
    }

    const neighbours = (c, r, visit) => {
      const cx = c % nx, cy = (c - cx) / nx;
      for (let y = Math.max(0, cy - r); y <= Math.min(ny - 1, cy + r); y += 1) {
        for (let x = Math.max(0, cx - r); x <= Math.min(nx - 1, cx + r); x += 1) visit(y * nx + x);
      }
    };

    const floor = new Float32Array(cells).fill(Infinity);
    for (let c = 0; c < cells; c += 1) {
      if (lowest[c] === Infinity) continue;
      const around = [];
      neighbours(c, 1, (k) => { if (lowest[k] !== Infinity) around.push(lowest[k]); });
      const reference = median(around);
      floor[c] = lowest[c] < reference - o.outlierDropM ? reference - o.outlierDropM : lowest[c];
    }

    const count = new Uint32Array(cells), mean = new Float64Array(cells), m2 = new Float64Array(cells);
    for (let i = 0; i < n; i += 1) {
      const c = cellOf[i];
      if (c < 0) continue;
      const z = p[3 * i + 2];
      if (z < floor[c] || z > floor[c] + o.bandM) continue;
      count[c] += 1;
      const delta = z - mean[c];
      mean[c] += delta / count[c];
      m2[c] += delta * (z - mean[c]);
    }

    const ground = new Uint8Array(cells);
    const centerOf = (c) => [minX + (c % nx + 0.5) * cell, minY + (Math.floor(c / nx) + 0.5) * cell];
    for (let c = 0; c < cells; c += 1) {
      if (!count[c]) continue;
      const [x, y] = centerOf(c);
      const range = Math.hypot(x - o.origin[0], y - o.origin[1]);
      // Gộp thống kê của vùng quanh ô (công thức song song của Welford).
      let total = 0, pooledMean = 0, pooledM2 = 0;
      neighbours(c, range > o.farM ? 2 : 1, (k) => {
        if (!count[k]) return;
        const merged = total + count[k], delta = mean[k] - pooledMean;
        pooledM2 += m2[k] + delta * delta * total * count[k] / merged;
        pooledMean += delta * count[k] / merged;
        total = merged;
      });
      const sigma = o.sigmaBaseM + o.sigmaPerM * range;
      if (total >= o.minPoints && Math.sqrt(pooledM2 / total) <= sigma) ground[c] = 1;
    }

    const cellIndex = (x, y) => {
      const ix = Math.floor((x - minX) / cell), iy = Math.floor((y - minY) / cell);
      return ix < 0 || iy < 0 || ix >= nx || iy >= ny ? -1 : iy * nx + ix;
    };

    /** Ô đất trong bán kính `radiusM` quanh (x, y), độ cao trong [band.minZ, band.maxZ]: [{ z, dx, dy, d }]. */
    function groundCellsNear(x, y, radiusM, band = ANY_HEIGHT) {
      const out = [], r = Math.ceil(radiusM / cell);
      const ix = Math.floor((x - minX) / cell), iy = Math.floor((y - minY) / cell);
      for (let yy = Math.max(0, iy - r); yy <= Math.min(ny - 1, iy + r); yy += 1) {
        for (let xx = Math.max(0, ix - r); xx <= Math.min(nx - 1, ix + r); xx += 1) {
          const k = yy * nx + xx;
          if (!ground[k] || mean[k] < band.minZ || mean[k] > band.maxZ) continue;
          const [cx, cy] = centerOf(k), dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
          if (d <= radiusM) out.push({ z: mean[k], dx, dy, d });
        }
      }
      return out;
    }

    /**
     * Độ cao mặt đất tại (x, y): { z, confidence ∈ [0, 1] } hoặc null khi quanh đó không có ô đất nào.
     * Bán kính tìm nới theo khoảng cách tới LiDAR (tia thưa dần). Độ tin cậy theo số ô đất làm điểm tựa và số
     * góc phần tư có ô đất: nội suy từ mọi phía đáng tin hơn ngoại suy từ một phía.
     * `band` giới hạn độ cao ô đất được dùng, để mái hiên / nóc vật chưa gán nhãn không thành "mặt đất".
     */
    function heightAt(x, y, band = ANY_HEIGHT) {
      const c = cellIndex(x, y);
      if (c >= 0 && ground[c] && mean[c] >= band.minZ && mean[c] <= band.maxZ) return { z: mean[c], confidence: 1 };
      const reach = o.maxReachM + o.reachPerM * Math.hypot(x - o.origin[0], y - o.origin[1]);
      const near = groundCellsNear(x, y, reach, band);
      if (!near.length) return null;
      let wsum = 0, zsum = 0;
      const quadrants = new Set();
      for (const { z, dx, dy, d } of near) {
        const w = 1 / Math.max(d * d, 1e-4);
        wsum += w;
        zsum += w * z;
        quadrants.add((dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0));
      }
      return { z: zsum / wsum, confidence: Math.min(1, near.length / o.minSupportCells) * (quadrants.size / 4) };
    }

    /**
     * Mặt đất thô của vùng rộng quanh (x, y), cho kiểm tra Z thô: phân vị thấp (`coarsePercentile`) của các ô đất
     * trong `coarseRadiusM`. Không dùng trung vị: đo trên nuScenes scene-0061, mái nhà / sàn cao phẳng bị nhận là ô đất
     * kéo trung vị lên tới 11 m; mặt đất thật luôn nằm dưới các mặt đó.
     */
    function coarseHeightAt(x, y) {
      const heights = groundCellsNear(x, y, o.coarseRadiusM).map((g) => g.z).sort((a, b) => a - b);
      return heights.length >= 5 ? heights[Math.floor(o.coarsePercentile * (heights.length - 1))] : null;
    }

    return { available: true, cellM: cell, heightAt, coarseHeightAt, groundCellCount: ground.reduce((s, v) => s + v, 0) };
  }

  function unavailable() {
    return { available: false, cellM: 0, heightAt: () => null, coarseHeightAt: () => null, groundCellCount: 0 };
  }

  /**
   * Đo tiếp đất của một box (không pitch / roll) từ mặt đất dưới 4 góc footprint. Trả về null khi dưới 3 góc đo được.
   * - Chỉ dùng ô đất trong ±`CONTACT_BAND_M` quanh đáy box: lệch hơn thế thì kiểm tra Z thô (mặt đất chung của vùng)
   *   bắt, không để mái hiên / nóc vật chưa gán nhãn kéo số đo đi vài mét.
   * - `contactZ`: mặt đất thấp nhất dưới footprint (box đúng chạm đường ở góc thấp nhất); `topContactZ`: cao nhất.
   * - `gapM`: đáy box nằm ngoài [contactZ, topContactZ] bao xa (dương: lơ lửng, âm: lún, 0: nằm trong khoảng). Trên bờ
   *   vỉa / dốc không biết box tựa mặt nào nên chấp nhận cả khoảng, tránh báo nhầm.
   * - `pointsBelowBottom`: điểm trong footprint cao hơn mặt đất cao nhất mà thấp hơn đáy box: điểm của chính vật
   *   (bánh xe, chân) dưới đáy box là bằng chứng lơ lửng trực tiếp. So với mặt cao nhất để điểm vỉa hè không bị đếm.
   */
  function measureContact(terrain, grid, box) {
    if (!terrain.available) return null;
    const bottom = B.bottomZ(box);
    const band = { minZ: bottom - CONTACT_BAND_M, maxZ: bottom + CONTACT_BAND_M };
    const samples = B.footprint(box).map(([x, y]) => terrain.heightAt(x, y, band)).filter(Boolean);
    if (samples.length < 3) return null;
    const heights = samples.map((s) => s.z);
    const contactZ = Math.min(...heights), topContactZ = Math.max(...heights);
    const gapM = bottom > topContactZ ? bottom - topContactZ : bottom < contactZ ? bottom - contactZ : 0;
    let below = 0;
    const p = grid.positions;
    for (const i of Grid.pointsNearBox(grid, box, 0)) {
      const z = p[3 * i + 2];
      if (z > topContactZ + 0.08 && z < bottom - 0.05) below += 1;
    }
    return {
      contactZ,
      topContactZ,
      gapM,
      spreadM: topContactZ - contactZ,
      confidence: samples.reduce((s, x) => s + x.confidence, 0) / 4,
      pointsBelowBottom: below,
    };
  }

  const api = { build, measureContact, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapTerrain = api;
})(globalThis);
