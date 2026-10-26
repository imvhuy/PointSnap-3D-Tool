/*
 * Đo một box trên point cloud của một frame rồi chạy bộ luật. Dùng chung cho bảng annotator (box đang chọn, trong
 * trình duyệt) và bộ quét QC (mọi box của job, chạy bằng Node), để hai bên luôn ra cùng một kết luận trên cùng một box.
 * Hàm thuần: không đọc CVAT, không vẽ.
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox || require('./box.js');
  const Grid = root.PointSnapGrid || require('./spatial-grid.js');
  const Terrain = root.PointSnapTerrain || require('./terrain.js');
  const ObjectPoints = root.PointSnapObjectPoints || require('./object-points.js');
  const Checks = root.PointSnapChecks || require('./checks.js');
  const G = root.PointSnapGuideline || require('./guideline.js');

  /** Chỉ mục điểm + bản đồ địa hình của một frame. `boxes`: mọi box có mặt ở frame (để bỏ điểm của vật khỏi mặt đất). */
  function buildFrame(positions, boxes, g) {
    const grid = Grid.build(positions, 1);
    return { positions, grid, terrain: Terrain.build(grid, boxes, { origin: g.sensorOrigin }) };
  }

  /**
   * Mặt đất ngay dưới (x, y) trên bản đồ địa hình, nhớ theo ô để không tra lại cho từng điểm. Chỉ dùng ô đất trong ±1 m
   * quanh đáy box (như đo tiếp đất) để mái hiên / nóc vật bên cạnh không thành "mặt đất"; không đo được thì dùng `fallback`.
   */
  function localGround(frame, box, fallback) {
    const bottom = B.bottomZ(box), band = { minZ: bottom - 1, maxZ: bottom + 1 }, cell = frame.terrain.cellM || 0.4;
    const memo = new Map();
    return (x, y) => {
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      if (!memo.has(key)) memo.set(key, frame.terrain.heightAt(x, y, band)?.z ?? fallback);
      return memo.get(key);
    };
  }

  /** Điểm của vật quanh box (A4): điểm trong box, điểm lòi ra, khoảng hở từng mặt nhìn thấy. */
  function objectPoints(frame, box, otherBoxes, fallbackGroundZ, g) {
    const p = frame.positions;
    // Phần tử thứ 4 là chỉ số điểm trong point cloud, để annotator tô màu đúng điểm đó.
    const near = Grid.pointsNearBox(frame.grid, box, ObjectPoints.DEFAULTS.marginM).map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2], i]);
    const sensor = g.sensorOrigin, half = box.dims.map((d) => d / 2 + 0.3);
    // Mặt bị vật khác che (điểm chắn trên tia LiDAR → tâm mặt, trừ điểm của chính vật quanh box) thì không đo khoảng hở.
    const ownPoint = (i) => B.toLocal(box, [p[3 * i], p[3 * i + 1], p[3 * i + 2]]).every((v, k) => Math.abs(v) <= half[k]);
    return ObjectPoints.measure(near, box, otherBoxes, localGround(frame, box, fallbackGroundZ), sensor, {
      faceOccluded: (faceCenter) => Grid.segmentBlocked(frame.grid, sensor, faceCenter, { ignore: ownPoint }),
    });
  }

  /**
   * Đo và kiểm một box. `target`: { box, label, attributes ({tên: giá trị}), occluded, clientId };
   * `others`: các box khác cùng frame, cùng dạng (giữ nguyên mọi trường khác, ví dụ `state` của CVAT);
   * `trackDims`: kích thước các keyframe khác cùng track (null khi không phải track hoặc chưa đọc xong).
   * Trả về { input, issues, contact, classKey, points }.
   */
  function measureBox(frame, target, others, trackDims, g) {
    const { box, label } = target;
    const classKey = G.classKey(g, label, target.attributes || {});
    const contact = Terrain.measureContact(frame.terrain, frame.grid, box);
    const points = objectPoints(frame, box, others.map((o) => o.box), contact ? contact.topContactZ : B.bottomZ(box), g);
    const input = {
      box, label, classKey, attributes: target.attributes || {}, occluded: !!target.occluded, trackDims, contact,
      clientId: target.clientId,
      coarseGroundZ: frame.terrain.coarseHeightAt(box.center[0], box.center[1]),
      others: others.map((o) => ({ ...o, classKey: G.classKey(g, o.label, o.attributes || {}) })),
      pointsInside: points.insideAboveFloor,
    };
    return { input, issues: Checks.checkBox(input, g), contact, classKey, points };
  }

  const api = { buildFrame, measureBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PointSnapMeasure = api;
})(globalThis);
