/*
 * Điểm LiDAR của vật quanh một box (hàm thuần), cùng cách làm với core/box_points.py của backend:
 * lấy điểm trong box nới `marginM`, bỏ điểm mặt đất và điểm của box khác, rồi chỉ giữ điểm **nối liền** (loang qua ô
 * lưới `voxelM`) với điểm nằm trong hoặc sát box. Điểm rời ra (cây, tường, vật bên cạnh) không bị tính là điểm của vật.
 * Kết quả: điểm trong box, điểm của vật lòi ra ngoài box, và khoảng hở ở từng mặt LiDAR nhìn thấy.
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox || require('./box.js');

  const DEFAULTS = {
    marginM: 0.5,
    voxelM: 0.3,
    seedM: 0.3,
    insideToleranceM: 0.04,
    groundClearanceM: 0.15,
    topMarginM: 0.3,
    minFacePoints: 8,
    facePercentile: 0.98,
    // Mặt chỉ được đo khi LiDAR nhìn nó đủ thẳng: góc giữa pháp tuyến mặt và hướng tới LiDAR ≤ 70° (cos ≥ 0,34).
    // Nhìn xiên thì tia chỉ quét vài điểm ở mép, đo ra "dư" vô căn cứ (gặp trên Argoverse 2: "đuôi dư 72 cm").
    minFaceCos: 0.34,
  };
  const FACES = [
    { name: 'đầu', axis: 0, sign: 1 }, { name: 'đuôi', axis: 0, sign: -1 },
    { name: 'trái', axis: 1, sign: 1 }, { name: 'phải', axis: 1, sign: -1 },
    { name: 'nóc', axis: 2, sign: 1 },
  ];

  const inBox = (local, half, tol) => local.every((v, i) => Math.abs(v) <= half[i] + tol);

  /** Mask điểm nối liền với điểm hạt giống, loang qua các ô lưới `voxel` kề nhau (26 hướng). */
  function connected(locals, seeds, voxel) {
    const key = (p) => p.map((v) => Math.floor(v / voxel)).join(',');
    const cells = new Map();
    locals.forEach((p, i) => {
      const k = key(p);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(i);
    });
    const seen = new Set(), frontier = [];
    seeds.forEach((isSeed, i) => {
      const k = key(locals[i]);
      if (isSeed && !seen.has(k)) { seen.add(k); frontier.push(k); }
    });
    while (frontier.length) {
      const [x, y, z] = frontier.pop().split(',').map(Number);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
        const k = `${x + dx},${y + dy},${z + dz}`;
        if (cells.has(k) && !seen.has(k)) { seen.add(k); frontier.push(k); }
      }
    }
    const mask = new Array(locals.length).fill(false);
    for (const k of seen) for (const i of cells.get(k)) mask[i] = true;
    return mask;
  }

  function percentile(values, p) {
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  }

  /**
   * `points`: [[x, y, z, …]] quanh box (caller lấy bằng chỉ mục không gian, vùng ≥ box + marginM; phần tử thừa được giữ
   * nguyên trong kết quả). `others`: box khác trong frame. `groundAt(x, y)`: độ cao mặt đất **ngay dưới từng điểm**.
   * Không dùng một độ cao chung cho cả box: trên dốc / bờ vỉa, điểm mặt đường phía cao lọt qua ngưỡng và phép loang lan
   * theo vệt tia trên mặt đường (gặp trên Argoverse 2: 27/28 "điểm lòi ra" của một xe là điểm mặt đường).
   * `sensor`: vị trí LiDAR. `options.faceOccluded(tâm mặt)`: true khi mặt đó bị vật khác che, để không đo khoảng hở.
   * Trả về { inside, outside, insideAboveFloor, faces: [{ name, gapM, points }] }:
   * - `inside` / `outside`: điểm của vật trong box / lòi ra ngoài box (hệ point cloud);
   * - `insideAboveFloor`: số điểm trong box cao hơn đáy 10 cm (luật box rỗng);
   * - `faces`: mặt quay về LiDAR có đủ điểm; gapM > 0 là box dư so với vật, < 0 là vật lòi ra khỏi mặt đó.
   */
  function measure(points, box, others, groundAt, sensor, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const half = box.dims.map((d) => d / 2), bottom = B.bottomZ(box);
    const top = box.center[2] + half[2] + o.topMarginM;
    const nearOthers = others.filter((b) => B.rangeXY(b, box.center) < Math.hypot(...box.dims) + Math.hypot(...b.dims));
    const kept = [], locals = [];
    let insideAboveFloor = 0;
    for (const q of points) {
      const local = B.toLocal(box, q);
      if (!inBox(local, half, o.marginM)) continue;
      if (inBox(local, half, o.insideToleranceM) && q[2] > bottom + 0.1) insideAboveFloor += 1;
      if (q[2] > top || q[2] < groundAt(q[0], q[1]) + o.groundClearanceM) continue;
      if (nearOthers.some((b) => inBox(B.toLocal(b, q), b.dims.map((d) => d / 2), o.insideToleranceM))) continue;
      kept.push(q);
      locals.push(local);
    }
    const object = connected(locals, locals.map((l) => inBox(l, half, o.seedM)), o.voxelM);
    const inside = [], outside = [], objectLocals = [];
    kept.forEach((q, i) => {
      if (!object[i]) return;
      objectLocals.push(locals[i]);
      (inBox(locals[i], half, o.insideToleranceM) ? inside : outside).push(q);
    });

    const sensorLocal = B.toLocal(box, sensor);
    const faces = [];
    if (objectLocals.length >= o.minFacePoints) {
      for (const f of FACES) {
        // Hướng từ tâm mặt tới LiDAR, hệ box: mặt quay lưng hoặc bị nhìn quá xiên thì không có điểm để đo.
        const toSensor = sensorLocal.map((v, i) => v - (i === f.axis ? f.sign * half[i] : 0));
        if ((f.sign * toSensor[f.axis]) / Math.hypot(...toSensor) < o.minFaceCos) continue;
        const faceCenter = B.toWorld(box, [0, 1, 2].map((i) => (i === f.axis ? f.sign * half[i] : 0)));
        if (o.faceOccluded && o.faceOccluded(faceCenter)) continue;
        const extent = percentile(objectLocals.map((l) => f.sign * l[f.axis]), o.facePercentile);
        faces.push({ name: f.name, axis: f.axis, sign: f.sign, gapM: half[f.axis] - extent });
      }
    }
    return { inside, outside, insideAboveFloor, faces };
  }

  const api = { measure, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapObjectPoints = api;
})(globalThis);
