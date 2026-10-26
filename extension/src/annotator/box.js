/*
 * Hình học cuboid thuần (không đụng CVAT, không đụng DOM). Đơn vị: mét, radian; z hướng lên.
 * Box: { center: [x, y, z], rotation: [rx, ry, rz], dims: [dài, rộng, cao] }, góc Euler XYZ như three.js / CVAT.
 * `points` CVAT 3D: [px, py, pz, rx, ry, rz, sx, sy, sz, 0 × 7].
 */
(function (root) {
  'use strict';

  const TWO_PI = Math.PI * 2;

  /** Góc quy về [−π, π). */
  function wrapAngle(a) {
    return ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  }

  /** Hiệu góc ngắn nhất b − a, trong [−π, π). */
  function angleDiff(a, b) {
    return wrapAngle(b - a);
  }

  function isFiniteVec(v, n) {
    return Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  }

  function isValidBox(box) {
    return !!box && isFiniteVec(box.center, 3) && isFiniteVec(box.rotation, 3)
      && isFiniteVec(box.dims, 3) && box.dims.every((d) => d > 0);
  }

  function fromCvatPoints(points) {
    if (!Array.isArray(points) || points.length < 9) return null;
    const box = { center: points.slice(0, 3), rotation: points.slice(3, 6), dims: points.slice(6, 9) };
    return isValidBox(box) ? box : null;
  }

  /** Ghi box vào mảng points CVAT, giữ nguyên phần đuôi của mảng gốc. */
  function toCvatPoints(box, original) {
    const tail = Array.isArray(original) && original.length > 9 ? original.slice(9) : new Array(7).fill(0);
    return [...box.center, ...box.rotation, ...box.dims, ...tail];
  }

  /** Ma trận quay Euler XYZ (R = Rx · Ry · Rz), cùng thứ tự với three.js. */
  function rotationMatrix([x, y, z]) {
    const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
    return [
      [c * e, -c * f, d],
      [a * f + b * e * d, a * e - b * f * d, -b * c],
      [b * f - a * e * d, b * e + a * f * d, a * c],
    ];
  }

  function toWorld(box, local) {
    const m = rotationMatrix(box.rotation);
    return [0, 1, 2].map((i) => box.center[i] + m[i][0] * local[0] + m[i][1] * local[1] + m[i][2] * local[2]);
  }

  function toLocal(box, point) {
    const m = rotationMatrix(box.rotation);
    const q = [point[0] - box.center[0], point[1] - box.center[1], point[2] - box.center[2]];
    return [0, 1, 2].map((i) => m[0][i] * q[0] + m[1][i] * q[1] + m[2][i] * q[2]);
  }

  const CORNER_SIGNS = [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1], [1, -1, 1]];
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

  /** 8 góc: 4 góc đáy rồi 4 góc nóc. */
  function corners(box) {
    return CORNER_SIGNS.map((s) => toWorld(box, s.map((v, i) => v * box.dims[i] / 2)));
  }

  function bottomZ(box) {
    return Math.min(...corners(box).slice(0, 4).map((p) => p[2]));
  }

  /** Footprint nhìn từ trên theo yaw (bỏ roll / pitch, như core Python), ngược chiều kim đồng hồ. */
  function footprint(box, margin = 0) {
    const [cx, cy] = box.center, yaw = box.rotation[2];
    const hl = box.dims[0] / 2 + margin, hw = box.dims[1] / 2 + margin;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [[hl, hw], [-hl, hw], [-hl, -hw], [hl, -hw]].map(([x, y]) => [cx + c * x - s * y, cy + s * x + c * y]);
  }

  function polygonArea(poly) {
    let sum = 0;
    for (let i = 0; i < poly.length; i += 1) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  }

  /** Cắt đa giác lồi `subject` theo đa giác lồi `clip` (Sutherland–Hodgman); cả hai ngược chiều kim đồng hồ. */
  function clipConvex(subject, clip) {
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let output = subject;
    for (let i = 0; i < clip.length && output.length; i += 1) {
      const a = clip[i], b = clip[(i + 1) % clip.length], input = output;
      output = [];
      for (let j = 0; j < input.length; j += 1) {
        const p = input[j], q = input[(j + 1) % input.length];
        const pIn = cross(a, b, p) >= 0, qIn = cross(a, b, q) >= 0;
        if (pIn) output.push(p);
        if (pIn !== qIn) {
          const dx = q[0] - p[0], dy = q[1] - p[1];
          const denom = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx;
          const t = ((b[0] - a[0]) * (a[1] - p[1]) - (b[1] - a[1]) * (a[0] - p[0])) / denom;
          output.push([p[0] + t * dx, p[1] + t * dy]);
        }
      }
    }
    return output;
  }

  /**
   * Tỉ lệ chồng: diện tích chồng nhìn từ trên / diện tích box nhỏ hơn, khi hai box có phần thể tích chung. Chia cho box
   * nhỏ hơn để bắt cả box nhỏ nằm gọn trong box lớn (IoU bỏ sót). Chồng theo chiều cao dưới 1 cm hoặc phần chung nhìn
   * từ trên dưới 1 cm² là chạm mép / sai số làm tròn, không tính.
   */
  function overlapRatio(a, b) {
    const top = (box) => box.center[2] + box.dims[2] / 2;
    const bottom = (box) => box.center[2] - box.dims[2] / 2;
    const zOverlap = Math.min(top(a), top(b)) - Math.max(bottom(a), bottom(b));
    if (zOverlap <= 0.01) return 0;
    const reach = (Math.hypot(a.dims[0], a.dims[1]) + Math.hypot(b.dims[0], b.dims[1])) / 2;
    if (Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) > reach) return 0;
    const fa = footprint(a), fb = footprint(b);
    const smaller = Math.min(polygonArea(fa), polygonArea(fb)), shared = polygonArea(clipConvex(fa, fb));
    return smaller > 0 && shared > 1e-4 ? shared / smaller : 0;
  }

  /** Khoảng cách nhìn từ trên từ tâm box tới gốc cảm biến. */
  function rangeXY(box, origin = [0, 0, 0]) {
    return Math.hypot(box.center[0] - origin[0], box.center[1] - origin[1]);
  }

  const api = {
    wrapAngle, angleDiff, isValidBox, fromCvatPoints, toCvatPoints, rotationMatrix, toWorld, toLocal,
    corners, EDGES, bottomZ, footprint, polygonArea, clipConvex, overlapRatio, rangeXY,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapBox = api;
})(globalThis);
