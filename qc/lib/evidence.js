'use strict';
/*
 * Bằng chứng point cloud cho "đứt track": ở chỗ nối có một vật hay hai vật?
 * - Frame đầu đoạn sau (fs): đặt box đoạn trước vào chỗ nó lẽ ra phải tới (box "ma"). Nếu ở đó có một cụm điểm không thuộc
 *   box đoạn sau (và không thuộc box nào khác) thì vật cũ vẫn còn đó, đoạn sau là vật khác → hai vật.
 * - Frame cuối đoạn trước (fe): làm ngược lại với box đoạn sau lùi về.
 * - Cụm điểm: điểm cao hơn đáy box 25 cm, nối nhau trong 0,6 m. Một cụm chạm box thật của frame đó thì là của vật đó (box
 *   đặt lệch / xoay sai vẫn không bị tính thành vật thứ hai).
 * Tính trong toạ độ đã bù chuyển động xe thu (poses từ icp.js), chỉ trong vùng quanh hai box.
 */
const B = require('../../extension/src/annotator/box.js');
const { apply } = require('./icp');

const OPT = { margin: 0.3, lift: 0.25, link: 0.6, window: 12, minPts: 6, minShare: 0.25 };

/** Box sensor → box toạ độ frame đầu (tâm + góc). */
function boxToWorld(box, T) {
  const [x, y] = apply(T, box.center[0], box.center[1]);
  return { ...box, center: [x, y, box.center[2]], rotation: [box.rotation[0], box.rotation[1], box.rotation[2] + Math.atan2(T.s, T.c)] };
}

/** Điểm (toạ độ đã bù) trong cửa sổ quanh `around`, cao hơn `bottom + lift`. */
function localPoints(positions, T, around, bottom, o) {
  const out = [];
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y] = apply(T, positions[i], positions[i + 1]), z = positions[i + 2];
    if (z < bottom + o.lift || z > bottom + 4) continue;
    if (around.some((c) => Math.abs(x - c[0]) < o.window && Math.abs(y - c[1]) < o.window)) out.push([x, y, z]);
  }
  return out;
}

const inBox = (box, p, m) => {
  const l = B.toLocal(box, p);
  return Math.abs(l[0]) <= box.dims[0] / 2 + m && Math.abs(l[1]) <= box.dims[1] / 2 + m;
};

/** Nhãn cụm (nối nhau trong `link` m, nhìn từ trên) cho từng điểm. */
function clusters(pts, link) {
  const cell = new Map(), key = (x, y) => `${Math.floor(x / link)},${Math.floor(y / link)}`;
  pts.forEach((p, i) => { const k = key(p[0], p[1]); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); });
  const label = new Array(pts.length).fill(-1);
  let next = 0;
  for (let s = 0; s < pts.length; s += 1) {
    if (label[s] >= 0) continue;
    label[s] = next;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop(), cx = Math.floor(pts[i][0] / link), cy = Math.floor(pts[i][1] / link);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of cell.get(`${cx + dx},${cy + dy}`) || []) {
          if (label[j] >= 0 || Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) > link) continue;
          label[j] = next;
          stack.push(j);
        }
      }
    }
    next += 1;
  }
  return label;
}

/**
 * Ở một frame: `real` là box thật của vật ở frame đó, `ghost` là chỗ vật kia lẽ ra phải ở. Đếm điểm của vật thật và điểm
 * trong box ma mà không thuộc cụm của vật thật, không thuộc box đã gán nào khác.
 */
function check(pts, real, ghost, others, o) {
  const label = clusters(pts, o.link);
  const mine = new Set(), own = [];
  pts.forEach((p, i) => { if (inBox(real, p, o.margin)) { mine.add(label[i]); own.push(i); } });
  let extra = 0;
  pts.forEach((p, i) => {
    if (!inBox(ghost, p, 0.1) || mine.has(label[i]) || inBox(real, p, o.margin) || others.some((b) => inBox(b, p, o.margin))) return;
    extra += 1;
  });
  return { own: own.length, extra };
}

/**
 * `end`/`start`: { positions, T (pose), real (box sensor của vật ở frame đó), ghost (box toạ độ đã bù: chỗ vật kia lẽ ra ở),
 * others: [box sensor] }. Trả về { verdict: 'one' | 'two' | 'unknown', end: {own, extra}, start: {own, extra} }.
 */
function junction(end, start, o = OPT) {
  const side = (s) => {
    const real = boxToWorld(s.real, s.T), others = s.others.map((b) => boxToWorld(b, s.T));
    const bottom = Math.min(B.bottomZ(real), B.bottomZ(s.ghost));
    return check(localPoints(s.positions, s.T, [real.center, s.ghost.center], bottom, o), real, s.ghost, others, o);
  };
  const e = side(end), s = side(start);
  const need = (r) => Math.max(o.minPts, o.minShare * r.own);
  const verdict = e.extra >= need(e) || s.extra >= need(s) ? 'two' : e.own + s.own >= 2 * o.minPts ? 'one' : 'unknown';
  return { verdict, end: e, start: s };
}

/** Ngược của boxToWorld: box toạ độ frame đầu → toạ độ xe thu của frame có phép `T`. */
function boxToSensor(box, T) {
  const x = box.center[0] - T.tx, y = box.center[1] - T.ty;
  return { ...box, center: [T.c * x + T.s * y, -T.s * x + T.c * y, box.center[2]],
    rotation: [box.rotation[0], box.rotation[1], box.rotation[2] - Math.atan2(T.s, T.c)] };
}

module.exports = { junction, boxToWorld, boxToSensor, OPT };
