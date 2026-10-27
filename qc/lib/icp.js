'use strict';
/*
 * Chuyển động xe thu giữa hai frame liền nhau, khớp point cloud (CVAT không lưu pose). Chỉ dùng "nền tĩnh": bỏ mặt đất
 * (thấp hơn 30 cm so với điểm thấp nhất của ô 1 m) và bỏ điểm trong box đã gán (vật có thể đang chạy), chiếu xuống mặt
 * phẳng, lấy mỗi ô 0,3 m một điểm. Tìm thô quanh dự đoán (lưới tịnh tiến + góc quay, chấm bằng số ô trùng), rồi ICP điểm–điểm
 * 2D có cắt bỏ cặp xa. Kết quả: phép biến đổi T sao cho T(điểm frame sau) ≈ điểm frame trước, kèm tỉ lệ điểm khớp.
 */
const B = require('../../extension/src/annotator/box.js');

const OPT = { minRange: 2.5, maxRange: 70, groundCell: 1, groundLift: 0.3, maxHeight: 4, cell: 0.3, boxMargin: 0.5,
  occCell: 0.5, matchM: 0.3, minQuality: 0.35 };

/** Điểm nền tĩnh 2D (Float32Array x,y xen kẽ) của một frame. */
function structure(positions, boxes = [], o = OPT) {
  const n = positions.length / 3, low = new Map(), key = (x, y, c) => `${Math.floor(x / c)},${Math.floor(y / c)}`;
  for (let i = 0; i < n; i += 1) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2], r = Math.hypot(x, y);
    if (r < o.minRange || r > o.maxRange) continue;
    const k = key(x, y, o.groundCell);
    if (!(low.get(k) <= z)) low.set(k, z);
  }
  const near = boxes.map((b) => ({ b, reach: Math.hypot(b.dims[0], b.dims[1]) / 2 + o.boxMargin }));
  const seen = new Set(), out = [];
  for (let i = 0; i < n; i += 1) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2], r = Math.hypot(x, y);
    if (r < o.minRange || r > o.maxRange) continue;
    const g = low.get(key(x, y, o.groundCell));
    if (z < g + o.groundLift || z > g + o.maxHeight) continue;
    if (near.some(({ b, reach }) => Math.abs(x - b.center[0]) < reach && Math.abs(y - b.center[1]) < reach
      && (([lx, ly]) => Math.abs(lx) <= b.dims[0] / 2 + o.boxMargin && Math.abs(ly) <= b.dims[1] / 2 + o.boxMargin)(B.toLocal(b, [x, y, b.center[2]])))) continue;
    const k = key(x, y, o.cell);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x, y);
  }
  return Float32Array.from(out);
}

/** Khoá số của ô (ix, iy) cho Map / Set. */
const cellKey = (ix, iy) => (ix + 1e5) * 2e5 + (iy + 1e5);

const apply = (T, x, y) => [T.c * x - T.s * y + T.tx, T.s * x + T.c * y + T.ty];
const make = (yaw, tx, ty) => ({ c: Math.cos(yaw), s: Math.sin(yaw), tx, ty });
const yawOf = (T) => Math.atan2(T.s, T.c);

/** Lưới băm điểm của frame trước: tra điểm gần nhất trong 3×3 ô. */
function grid(pts, cell) {
  const g = new Map();
  for (let i = 0; i < pts.length; i += 2) {
    const k = cellKey(Math.floor(pts[i] / cell), Math.floor(pts[i + 1] / cell));
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(i);
  }
  return { g, cell, pts };
}
function nearest({ g, cell, pts }, x, y) {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  let best = -1, bd = Infinity;
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
    for (const i of g.get(cellKey(cx + dx, cy + dy)) || []) {
      const d = (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return [best, Math.sqrt(bd)];
}

/** Lưới chiếm chỗ của frame trước (mảng byte, ô `occCell` m, phủ ± maxRange). */
function occupancy(prev, o = OPT) {
  const n = Math.ceil((2 * o.maxRange + 40) / o.occCell), half = n / 2, grid = new Uint8Array(n * n);
  for (let i = 0; i < prev.length; i += 2) {
    const ix = Math.floor(prev[i] / o.occCell + half), iy = Math.floor(prev[i + 1] / o.occCell + half);
    if (ix >= 0 && iy >= 0 && ix < n && iy < n) grid[iy * n + ix] = 1;
  }
  return { grid, n, half, cell: o.occCell };
}

/** Tìm thô: lưới tịnh tiến ± `span` m quanh `guess`, góc ± `yawSpan`; điểm = số điểm frame sau rơi vào ô có điểm frame trước. */
function coarse(cur, occ, guess, { span, step, yawSpan, yawStep }) {
  const { grid, n, half, cell } = occ;
  // Mẫu tối đa 800 điểm cho nhanh.
  const stride = Math.max(1, Math.floor(cur.length / 2 / 800)) * 2;
  let best = { score: -1, T: guess };
  const g0 = yawOf(guess);
  for (let dyaw = -yawSpan; dyaw <= yawSpan + 1e-9; dyaw += yawStep) {
    const c = Math.cos(g0 + dyaw), s = Math.sin(g0 + dyaw);
    for (let dx = -span; dx <= span + 1e-9; dx += step) {
      for (let dy = -span; dy <= span + 1e-9; dy += step) {
        const tx = guess.tx + dx, ty = guess.ty + dy;
        let score = 0;
        for (let i = 0; i < cur.length; i += stride) {
          const ix = Math.floor((c * cur[i] - s * cur[i + 1] + tx) / cell + half), iy = Math.floor((s * cur[i] + c * cur[i + 1] + ty) / cell + half);
          if (ix >= 0 && iy >= 0 && ix < n && iy < n && grid[iy * n + ix]) score += 1;
        }
        if (score > best.score) best = { score, T: { c, s, tx, ty } };
      }
    }
  }
  return best.T;
}

/** Tìm thô hai tầng: lưới thưa rồi lưới mịn quanh chỗ tốt nhất. */
function search(cur, occ, guess, wide) {
  const deg = Math.PI / 180;
  const T1 = coarse(cur, occ, guess, wide ? { span: 16, step: 2, yawSpan: 6 * deg, yawStep: 2 * deg } : { span: 3, step: 1, yawSpan: 3 * deg, yawStep: deg });
  const T2 = coarse(cur, occ, T1, wide ? { span: 2, step: 0.5, yawSpan: 2 * deg, yawStep: deg } : { span: 1, step: 0.25, yawSpan: 1 * deg, yawStep: 0.5 * deg });
  return T2;
}

/** ICP điểm–điểm 2D, cắt bỏ cặp xa hơn ngưỡng (ngưỡng thu dần). */
function refine(cur, prev, T0, o = OPT) {
  const G = grid(prev, 1.0);
  let T = T0;
  for (const maxD of [1.0, 0.8, 0.6, 0.5, 0.4, 0.4, 0.3, 0.3, 0.3, 0.3]) {
    let n = 0, sx = 0, sy = 0, dx = 0, dy = 0;
    const pairs = [];
    for (let i = 0; i < cur.length; i += 2) {
      const [x, y] = apply(T, cur[i], cur[i + 1]);
      const [j, d] = nearest(G, x, y);
      if (j < 0 || d > maxD) continue;
      pairs.push([cur[i], cur[i + 1], prev[j], prev[j + 1]]);
      sx += cur[i]; sy += cur[i + 1]; dx += prev[j]; dy += prev[j + 1]; n += 1;
    }
    if (n < 20) break;
    sx /= n; sy /= n; dx /= n; dy /= n;
    let a = 0, b = 0;
    for (const [x, y, u, v] of pairs) { a += (x - sx) * (u - dx) + (y - sy) * (v - dy); b += (x - sx) * (v - dy) - (y - sy) * (u - dx); }
    const r = Math.hypot(a, b) || 1, c = a / r, s = b / r;
    T = { c, s, tx: dx - (c * sx - s * sy), ty: dy - (s * sx + c * sy) };
  }
  let ok = 0;
  for (let i = 0; i < cur.length; i += 2) {
    const [x, y] = apply(T, cur[i], cur[i + 1]);
    if (nearest(G, x, y)[1] <= o.matchM) ok += 1;
  }
  return { T, quality: cur.length ? ok / (cur.length / 2) : 0 };
}

/**
 * Khớp frame sau (`cur`) vào frame trước (`prev`). `guess`: chuyển động bước trước (xe thu chạy đều); không có thì tìm
 * rộng. Trả về { T, quality, ok }: `ok` khi đủ điểm khớp để tin.
 */
function register(cur, prev, guess = null, o = OPT) {
  if (cur.length < 60 || prev.length < 60) return { T: null, quality: 0, ok: false };
  const occ = occupancy(prev, o);
  let best = refine(cur, prev, search(cur, occ, guess || make(0, 0, 0), !guess), o);
  // Dự đoán sai (xe thu phanh / tăng tốc mạnh) thì thử thêm tìm rộng.
  if (guess && best.quality < o.minQuality) {
    const wide = refine(cur, prev, search(cur, occ, make(0, 0, 0), true), o);
    if (wide.quality > best.quality) best = wide;
  }
  return { ...best, ok: best.quality >= o.minQuality };
}

const compose = (A, Bt) => ({ c: A.c * Bt.c - A.s * Bt.s, s: A.s * Bt.c + A.c * Bt.s, tx: A.c * Bt.tx - A.s * Bt.ty + A.tx, ty: A.s * Bt.tx + A.c * Bt.ty + A.ty });

/**
 * `steps`: Map frame → phép biến đổi frame đó → frame trước (null khi khớp kém). Bước thiếu lấy bước gần nhất khớp được
 * (xe thu chạy đều); không bước nào khớp thì trả null. Trả về { poses: Map frame → toạ độ frame đầu, weak: [frame] }.
 */
function chain(steps, start, stop) {
  const good = [...steps].filter(([, T]) => T).map(([f]) => f);
  if (!good.length) return { poses: null, weak: [...steps.keys()] };
  const near = (f) => good.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
  const poses = new Map(), weak = [];
  let world = { c: 1, s: 0, tx: 0, ty: 0 };
  for (let f = start; f <= stop; f += 1) {
    if (f > start) {
      const T = steps.get(f);
      if (!T) weak.push(f);
      world = compose(world, T || steps.get(near(f)));
    }
    poses.set(f, world);
  }
  return { poses, weak };
}

module.exports = { structure, register, chain, apply, make, OPT };
