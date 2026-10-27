'use strict';
/* Edge case của luật đứt track (track.fragment): mỗi ca là nhãn giả + kết quả mong đợi (bắt / không báo). */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/tracks');
const G = require('../../extension/src/annotator/guideline.js');
const R = require('../lib/trackrules');
const { QC_FULL_DEFAULTS } = require('../lib/rules');
const LABELS = [{ id: 1, name: 'car', attributes: [] }, { id: 2, name: 'traffic_cone', attributes: [] }, { id: 3, name: 'pedestrian', attributes: [] }, { id: 4, name: 'truck', attributes: [] }];
const DIMS = { 1: [4.5, 1.9, 1.6], 2: [0.45, 0.45, 0.75], 3: [0.8, 0.7, 1.75], 4: [8, 2.5, 3] };
const STOP = 30;

/** Track: `path(f)` → [x, y] (toạ độ thế giới), có mặt ở các frame `[a, b]`; `ego(f)` dịch toàn cảnh (xe thu chạy). */
function track(id, label, from, to, path, { outsideAfter = true, dims } = {}, ego = () => [0, 0]) {
  const shapes = [];
  for (let f = from; f <= to; f += 1) {
    const [x, y] = path(f), [ex, ey] = ego(f);
    shapes.push({ frame: f, type: 'cuboid', outside: false, attributes: [], points: [x - ex, y - ey, -1, 0, 0, 0, ...(dims || DIMS[label]), 0, 0, 0, 0, 0, 0, 0] });
  }
  if (outsideAfter && to < STOP) shapes.push({ ...shapes.at(-1), frame: to + 1, outside: true });
  return { id, label_id: label, attributes: [], shapes };
}
// Vài vật đứng yên để ước lượng chuyển động xe thu.
const statics = (ego) => [[60, 15], [65, -12], [80, 20], [40, -25]].map(([x, y], i) => track(900 + i, 1, 0, STOP, () => [x, y], {}, ego));

const J = (f, k) => 0.2 * Math.sin(f * 12.9898 + k * 78.233);
const cases = [
  // ---- phải bắt
  { name: 'xe chạy, đứt ngay frame sau', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 11, 20, (f) => [2 * f, 0])] },
  { name: 'xe chạy, bị che 3 frame rồi ID mới', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 14, 20, (f) => [2 * f, 0])] },
  { name: 'đoạn đầu chỉ 1 keyframe', want: true, tracks: () => [track(1, 1, 5, 5, (f) => [2 * f, 0]), track(2, 1, 6, 20, (f) => [2 * f, 0])] },
  { name: 'xe đang rẽ (đường cong)', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [20 * Math.sin(f / 8), 20 - 20 * Math.cos(f / 8)]), track(2, 1, 11, 20, (f) => [20 * Math.sin(f / 8), 20 - 20 * Math.cos(f / 8)])] },
  { name: 'nón đứng yên, đứt 2 frame', want: true, tracks: () => [track(1, 2, 0, 10, () => [15, 3]), track(2, 2, 13, 20, () => [15.05, 3])] },
  { name: 'nón đứng yên, xe thu chạy 8 m/frame', want: true, ego: (f) => [8 * f, 0], tracks: (ego) => [track(1, 2, 0, 10, () => [100, 3], {}, ego), track(2, 2, 12, 20, () => [100, 3], {}, ego)] },
  { name: 'người đi bộ, đứt 2 frame', want: true, tracks: () => [track(1, 3, 0, 10, (f) => [5 + 0.15 * f, 2]), track(2, 3, 13, 20, (f) => [5 + 0.15 * f, 2])] },
  { name: 'pre-label: kích thước đoạn sau lệch 15%', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 11, 20, (f) => [2 * f, 0], { dims: [5.2, 2.1, 1.7] })] },
  { name: 'đoạn trước không có keyframe outside (CVAT giữ box tới hết job)', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0], { outsideAfter: false }), track(2, 1, 11, 20, (f) => [2 * f, 0])] },
  { name: 'nhãn rung ±20 cm, đứt 2 frame', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f + J(f, 1), J(f, 2)]), track(2, 1, 13, 20, (f) => [2 * f + J(f, 3), J(f, 4)])] },
  { name: 'cách đúng 5 frame (biên)', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 16, 25, (f) => [2 * f, 0])] },
  { name: 'xe buýt 12 m, đứt 1 frame', want: true, tracks: () => [track(1, 4, 0, 10, (f) => [1.5 * f, 0], { dims: [12, 2.6, 3.2] }), track(2, 4, 12, 20, (f) => [1.5 * f, 0], { dims: [12, 2.6, 3.2] })] },
  { name: 'xe nhanh 15 m/frame, đứt 2 frame', want: true, tracks: () => [track(1, 1, 0, 10, (f) => [15 * f, 0]), track(2, 1, 13, 20, (f) => [15 * f, 0])] },
  // ---- không được báo
  { name: 'xe nhanh 15 m/frame, xe khác làn bên cạnh (3,5 m)', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [15 * f, 0]), track(2, 1, 13, 20, (f) => [15 * f, 3.5])] },
  { name: 'xe nhanh: xe khác cùng làn chậm hơn 40%', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [15 * f, 0]), track(2, 1, 13, 20, (f) => [150 + 9 * (f - 10) - 8, 0])] },
  { name: 'cách 6 frame', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 17, 25, (f) => [2 * f, 0])] },
  { name: 'hai nón cách 0,6 m', want: false, tracks: () => [track(1, 2, 0, 10, () => [15, 3]), track(2, 2, 12, 20, () => [15, 3.6])] },
  { name: 'hai nón cạnh nhau 1,3 m, thay nhau hiện', want: false, tracks: () => [track(1, 2, 0, 10, () => [15, 3]), track(2, 2, 12, 20, () => [15, 4.3])] },
  { name: 'xe sau chạy tới chỗ xe trước vừa rời (kẹt xe 0,3 m/frame)', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [0.3 * f, 0]), track(2, 1, 14, 20, (f) => [0.3 * f - 1.5, 0])] },
  { name: 'xe khác làn cách 3,5 m', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 11, 20, (f) => [2 * f, 3.5])] },
  { name: 'xe khác chạy ngược chiều', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 11, 20, (f) => [42 - 2 * (f - 11), 0.5])] },
  { name: 'cách quá 5 frame', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 1, 17, 25, (f) => [2 * f, 0])] },
  { name: 'hai track cùng có mặt một lúc', want: false, tracks: () => [track(1, 1, 0, 12, (f) => [2 * f, 0]), track(2, 1, 12, 20, (f) => [2 * f, 0])] },
  { name: 'khác class (car → truck)', want: false, tracks: () => [track(1, 1, 0, 10, (f) => [2 * f, 0]), track(2, 4, 11, 20, (f) => [2 * f, 0])] },
  { name: 'cùng một track ra rồi vào lại (đúng, cùng ID)', want: false, tracks: () => { const t = track(1, 1, 0, 10, (f) => [2 * f, 0]); t.shapes.push(...track(1, 1, 13, 20, (f) => [2 * f, 0]).shapes); return [t]; } },
  { name: 'track kết thúc ở frame cuối job', want: false, tracks: () => [track(1, 1, 0, STOP, (f) => [f, 0])] },
  { name: 'người đi cùng nhóm: người khác xuất hiện cách 1 m', want: false, tracks: () => [track(1, 3, 0, 10, (f) => [5 + 0.15 * f, 2]), track(2, 3, 11, 20, (f) => [5 + 0.15 * f - 1, 2.3])] },
];

for (const c of cases) {
  test(`đứt track: ${c.want ? 'bắt' : 'không báo'} — ${c.name}`, () => {
    const ego = c.ego || (() => [0, 0]);
    const ann = { shapes: [], tracks: [...c.tracks(ego), ...statics(ego)] };
    const ex = T.expand(ann, LABELS, { start: 0, stop: STOP });
    const hits = R.trackRules({ ...ex, stop: STOP }, G.DEFAULT_GUIDELINE, QC_FULL_DEFAULTS).hits
      .filter((h) => h.issue.rule === 'track.fragment' && !h.objKey.startsWith('track:90'));
    assert.equal(hits.length > 0, c.want, hits.map((h) => `${h.objKey}@${h.frame} ${h.issue.message}`).join('; '));
  });
}
