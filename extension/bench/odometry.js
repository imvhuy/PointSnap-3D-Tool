'use strict';
/*
 * Chuyển động xe thu 6 bậc (x, y, z, roll, pitch, yaw) giữa hai frame, khớp point cloud bằng ICP điểm – mặt phẳng.
 * CVAT không lưu pose; bước 1 của kế hoạch kiểm tới 80 m cần biết độ cao và độ chúc giữa các frame, nên không dùng bản
 * khớp 2D của QC (qc/lib/icp.js).
 * - Mỗi frame: bỏ điểm trong box đã gán (vật có thể đang chạy, nới `boxMargin`), giữ mặt đất (ghìm z / pitch / roll),
 *   lấy trọng tâm mỗi ô `voxel`.
 * - Đích: pháp tuyến từ PCA điểm lân cận, bỏ điểm không phẳng (cành cây, mép vật).
 * - Gauss – Newton điểm – mặt phẳng, trọng số Geman – McClure, khoảng ghép giảm dần theo `stages`.
 * Thuần, không phụ thuộc trình duyệt; test: extension/tests/odometry.test.js.
 */
const B = require('../src/annotator/box.js');

const OPT = {
  minRange: 3, maxRange: 80, voxel: 0.5, boxMargin: 0.3, normalRadius: 1.2, maxCurvature: 0.08,
  stages: [{ maxDist: 4, iters: 8 }, { maxDist: 1.5, iters: 8 }, { maxDist: 0.5, iters: 12 }],
};

const key = (ix, iy, iz) => `${ix},${iy},${iz}`;

/** Trọng tâm mỗi ô `voxel` của điểm trong tầm, ngoài các box (nới `boxMargin`). Trả về mảng [x, y, z]. */
function prepare(positions, boxes = [], o = OPT) {
  const near = boxes.map((b) => ({ b, reach: Math.hypot(b.dims[0], b.dims[1]) / 2 + o.boxMargin }));
  const cells = new Map();
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2], r = Math.hypot(x, y);
    if (!(r >= o.minRange && r <= o.maxRange) || !Number.isFinite(z)) continue;
    if (near.some(({ b, reach }) => Math.abs(x - b.center[0]) < reach && Math.abs(y - b.center[1]) < reach
      && B.toLocal(b, [x, y, z]).every((v, k) => Math.abs(v) <= b.dims[k] / 2 + o.boxMargin))) continue;
    const k = key(Math.floor(x / o.voxel), Math.floor(y / o.voxel), Math.floor(z / o.voxel));
    const c = cells.get(k);
    if (c) { c[0] += x; c[1] += y; c[2] += z; c[3] += 1; } else cells.set(k, [x, y, z, 1]);
  }
  return [...cells.values()].map(([x, y, z, n]) => [x / n, y / n, z / n]);
}

/** Trị riêng / vector riêng của ma trận đối xứng 3×3 (Jacobi). Trả về { values, vectors (cột) } tăng dần. */
function eigSym3(m) {
  const a = m.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 20; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]]) };
}

function hashOf(pts, cell) {
  const h = new Map();
  pts.forEach((p, i) => {
    const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell));
    if (h.has(k)) h.get(k).push(i); else h.set(k, [i]);
  });
  return h;
}

function neighbours(h, cell, pts, p, radius, visit) {
  const r = Math.ceil(radius / cell), ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell), iz = Math.floor(p[2] / cell);
  for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) for (let dz = -r; dz <= r; dz += 1) {
    const list = h.get(key(ix + dx, iy + dy, iz + dz));
    if (list) for (const i of list) visit(i, pts[i]);
  }
}

/** Đích ICP: điểm phẳng kèm pháp tuyến. */
function target(pts, o = OPT) {
  const h = hashOf(pts, o.normalRadius), keep = [], normals = [];
  pts.forEach((p) => {
    const near = [];
    neighbours(h, o.normalRadius, pts, p, o.normalRadius, (i, q) => {
      if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 <= o.normalRadius ** 2) near.push(q);
    });
    if (near.length < 5) return;
    const c = [0, 1, 2].map((k) => near.reduce((s, q) => s + q[k], 0) / near.length);
    const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => near.reduce((s, q) => s + (q[i] - c[i]) * (q[j] - c[j]), 0) / near.length));
    const { values, vectors } = eigSym3(cov);
    const sum = values[0] + values[1] + values[2];
    if (!(sum > 0) || values[0] / sum > o.maxCurvature) return;
    keep.push(p); normals.push(vectors[0]);
  });
  return { pts: keep, normals };
}

/** Giải hệ tuyến tính n×n (khử Gauss, chọn trụ). */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function rodrigues(w) {
  const th = Math.hypot(...w);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map((v) => v / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}

const mul = (A, Bm) => A.map((row) => [0, 1, 2].map((j) => row[0] * Bm[0][j] + row[1] * Bm[1][j] + row[2] * Bm[2][j]));
const apply3 = (R, v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const applyT = (T, p) => { const q = apply3(T.R, p); return [q[0] + T.t[0], q[1] + T.t[1], q[2] + T.t[2]]; };

/**
 * T sao cho T(điểm nguồn) ≈ điểm đích. `src`: kết quả `prepare`; `tgt`: kết quả `target`; `init`: { R, t } dự đoán.
 * Trả về { T, inliers (tỉ lệ điểm nguồn ghép được ở bước cuối), rmse }.
 */
function register(src, tgt, init = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }, o = OPT) {
  let T = { R: init.R.map((r) => r.slice()), t: init.t.slice() }, inliers = 0, rmse = 0;
  for (const { maxDist, iters } of o.stages) {
    const h = hashOf(tgt.pts, maxDist);
    for (let it = 0; it < iters; it += 1) {
      const H = Array.from({ length: 6 }, () => new Array(6).fill(0)), g = new Array(6).fill(0);
      let used = 0, sq = 0;
      const sigma = maxDist / 3;
      for (const p of src) {
        const q = applyT(T, p);
        let best = -1, bestD = maxDist * maxDist;
        neighbours(h, maxDist, tgt.pts, q, maxDist, (i, c) => {
          const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        });
        if (best < 0) continue;
        const n = tgt.normals[best], c = tgt.pts[best];
        const r = n[0] * (q[0] - c[0]) + n[1] * (q[1] - c[1]) + n[2] * (q[2] - c[2]);
        const w = 1 / (1 + (r / sigma) ** 2) ** 2;
        const J = [q[1] * n[2] - q[2] * n[1], q[2] * n[0] - q[0] * n[2], q[0] * n[1] - q[1] * n[0], n[0], n[1], n[2]];
        for (let a = 0; a < 6; a += 1) { g[a] += w * J[a] * r; for (let b = a; b < 6; b += 1) H[a][b] += w * J[a] * J[b]; }
        used += 1; sq += r * r;
      }
      for (let a = 0; a < 6; a += 1) for (let b = 0; b < a; b += 1) H[a][b] = H[b][a];
      if (used < 30) break;
      const d = solve(H, g.map((v) => -v));
      if (!d) break;
      const dR = rodrigues(d.slice(0, 3));
      T = { R: mul(dR, T.R), t: apply3(dR, T.t).map((v, k) => v + d[3 + k]) };
      inliers = used / src.length; rmse = Math.sqrt(sq / used);
      if (Math.hypot(d[0], d[1], d[2]) < 1e-5 && Math.hypot(d[3], d[4], d[5]) < 1e-4) break;
    }
  }
  return { T, inliers, rmse };
}

module.exports = { OPT, prepare, target, register, eigSym3, applyT };
