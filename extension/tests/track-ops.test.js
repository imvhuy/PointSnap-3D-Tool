'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ops = require('../src/annotator/track-ops.js');

const DEG = Math.PI / 180;
const box = (x, y, yaw = 0, dims = [4.5, 1.9, 1.6], z = -1) => ({ center: [x, y, z], dims: [...dims], rotation: [0, 0, yaw] });
const kf = (frame, b, extra = {}) => ({ frame, box: b, outside: false, occluded: false, attrsKey: '{}', ...extra });
const TOL = { centerM: 0.05, dimsM: 0.02, yawDeg: 1 };

test('interpolate đi theo cung ngắn nhất qua ±180° như CVAT', () => {
  const mid = Ops.interpolate(box(0, 0, 179 * DEG), box(0, 0, -179 * DEG), 0.5);
  assert.ok(Math.abs(Math.abs(mid.rotation[2]) - Math.PI) < 1e-9);
});

test('đồng bộ kích thước giữ mặt nhìn thấy từ LiDAR, kéo dài về phía bị che, giữ đáy', () => {
  // Xe ở x = 10 quay đầu +x: LiDAR ở gốc thấy mặt đuôi (x = 7,75); kéo dài 1 m thì mặt đuôi phải đứng yên.
  const { edits } = Ops.planSizeSync([kf(0, box(10, 0))], [5.5, 1.9, 2.0]);
  const b = edits[0].box;
  assert.ok(Math.abs((b.center[0] - b.dims[0] / 2) - 7.75) < 1e-9);
  assert.ok(Math.abs((b.center[2] - b.dims[2] / 2) - (-1.8)) < 1e-9);
  assert.equal(b.center[1], 0);
});

test('đồng bộ kích thước bỏ qua keyframe đã đúng cỡ và keyframe outside', () => {
  const keyframes = [kf(0, box(10, 0)), kf(1, box(11, 0, 0, [4.0, 1.9, 1.6])), kf(2, box(12, 0), { outside: true })];
  const { edits } = Ops.planSizeSync(keyframes, [4.5, 1.9, 1.6]);
  assert.deepEqual(edits.map((e) => e.frame), [1]);
});

test('tỉa keyframe: chuyển động thẳng đều chỉ giữ hai đầu', () => {
  const keyframes = Array.from({ length: 20 }, (_, i) => kf(i, box(i * 0.5, 2)));
  const { edits, summary } = Ops.planThinning(keyframes, TOL);
  assert.equal(summary.kept, 2);
  assert.equal(edits.length, 18);
  assert.ok(edits.every((e) => e.keyframe === false));
});

test('tỉa keyframe: giữ đỉnh của đoạn rẽ và sai số sau tỉa ≤ dung sai', () => {
  const keyframes = Array.from({ length: 21 }, (_, i) => kf(i, box(i, i <= 10 ? 0 : (i - 10) * 0.8)));
  const { edits, summary } = Ops.planThinning(keyframes, TOL);
  assert.ok(!edits.some((e) => e.frame === 10));
  assert.ok(summary.maxCenterErrorM <= TOL.centerM + 1e-9);
});

test('tỉa keyframe: không bỏ keyframe kề chỗ đổi thuộc tính, occluded hoặc outside', () => {
  const keyframes = Array.from({ length: 12 }, (_, i) => kf(i, box(i, 0), {
    attrsKey: i >= 6 ? '{"rider_state":"with_rider"}' : '{}', outside: i === 11,
  }));
  const removed = new Set(Ops.planThinning(keyframes, TOL).edits.map((e) => e.frame));
  for (const frame of [0, 5, 6, 10, 11]) assert.ok(!removed.has(frame), `frame ${frame} phải giữ`);
});

test('làm mượt yaw: sửa keyframe lật 180°, giữ đoạn rẽ thật', () => {
  const yaws = Array.from({ length: 15 }, (_, i) => (i < 7 ? 0 : (i - 6) * 10 * DEG));
  yaws[3] = Math.PI;
  const keyframes = yaws.map((y, i) => kf(i, box(i, 0, y)));
  const { edits, summary } = Ops.planYawSmoothing(keyframes, { window: 5, minChangeDeg: 2, flipToleranceDeg: 30 });
  assert.equal(summary.flips, 1);
  const fixed = edits.find((e) => e.frame === 3);
  assert.ok(fixed && Math.abs(fixed.box.rotation[2]) < 1e-9);
  assert.ok(!edits.some((e) => e.frame === 14), 'cuối đoạn rẽ không bị kéo về 0');
});

test('hạ đáy box: đáy chạm mặt đất, giữ XY và kích thước', () => {
  const b = Ops.snapToGround(box(3, 4, 0, [4, 2, 1.6], -1.2), -1.8);
  assert.ok(Math.abs(b.center[2] - b.dims[2] / 2 + 1.8) < 1e-9);
  assert.deepEqual(b.center.slice(0, 2), [3, 4]);
});

// Mọi frame nhìn thấy trong job như adapter trả về: `keyframe` đánh dấu keyframe, frame còn lại là frame nội suy.
const fr = (frame, b, keyframe, extra = {}) => ({ frame, box: b, keyframe, outside: false, attributes: {}, ...extra });
const zBox = (bottom) => box(0, 0, 0, [4.5, 1.9, 1.6], bottom + 0.8);

test('gán nhiều thuộc tính: ghi keyframe đang khác và frame đầu job nối từ job trước, frame nội suy theo keyframe', () => {
  const frames = [
    fr(10, zBox(-1), false, { attributes: { 7: 'without_rider', 8: 'moving' } }), // keyframe chi phối nằm ở job trước
    fr(11, zBox(-1), false, { attributes: { 7: 'without_rider', 8: 'moving' } }),
    fr(12, zBox(-1), true, { attributes: { 7: 'with_rider', 8: 'moving' } }),
    fr(13, zBox(-1), false, { attributes: { 7: 'with_rider', 8: 'moving' } }),
    fr(20, zBox(-1), true, { attributes: { 7: 'without_rider', 8: 'parked' } }), // xuất hiện lại sau outside
  ];
  const { edits, summary } = Ops.planAttributes(frames, { 7: 'with_rider', 8: 'parked' });
  assert.deepEqual(edits, [
    { frame: 10, attributes: { 7: 'with_rider', 8: 'parked' } },
    { frame: 12, attributes: { 8: 'parked' } },
    { frame: 20, attributes: { 7: 'with_rider' } },
  ]);
  assert.deepEqual(summary, { changed: 3, wrongFrames: 5, total: 5 });
});

test('gán thuộc tính không đổi theo frame: ghi một lần cho cả track', () => {
  const frames = [fr(0, zBox(-1), true, { attributes: { 9: 'sedan' } }), fr(1, zBox(-1), true, { attributes: { 9: 'sedan' } })];
  assert.deepEqual(Ops.planAttributes(frames, { 9: 'suv' }, new Set(['9'])).edits, [{ frame: 0, attributes: { 9: 'suv' } }]);
  assert.deepEqual(Ops.planAttributes(frames, { 9: 'sedan' }, new Set(['9'])).edits, []);
});

test('hạ đáy mọi frame: dời keyframe, thêm keyframe ở frame nội suy còn lệch, sau đó mọi frame đo được sát đất', () => {
  // Đường dốc: đất hạ dần từ -1 xuống -1,6 qua 13 frame; box chỉ có keyframe 0 và 12, đều nổi 0,3 m; giữa có chỗ gồ.
  const groundZ = new Map(Array.from({ length: 13 }, (_, i) => [i, -1 - 0.05 * i + (i === 6 ? 0.2 : 0)]));
  groundZ.set(9, null); // frame không đo được mặt đất
  const frames = Array.from({ length: 13 }, (_, i) => fr(i, zBox(-0.7 - 0.05 * i), i === 0 || i === 12));
  const { edits, summary } = Ops.planGroundSnap(frames, groundZ, 0.05);
  const keys = new Map([[0, -1], [12, -1.6], ...edits.map((e) => [e.frame, e.box.center[2] - e.box.dims[2] / 2])]);
  const anchors = [...keys.keys()].sort((a, b) => a - b);
  for (let f = 0; f <= 12; f += 1) {
    const z = groundZ.get(f);
    if (z === null) continue;
    const a = anchors.filter((k) => k <= f).pop(), b = anchors.find((k) => k >= f);
    const bottom = a === b ? keys.get(a) : keys.get(a) + (keys.get(b) - keys.get(a)) * (f - a) / (b - a);
    assert.ok(Math.abs(bottom - z) <= 0.05 + 1e-9, `frame ${f} lệch ${bottom - z}`);
  }
  assert.deepEqual(edits.slice(0, 1).map((e) => e.frame), [0]);
  assert.equal(summary.moved, 2);
  assert.ok(summary.added >= 1 && summary.added <= 3, `thêm ${summary.added} keyframe`);
  assert.equal(summary.unmeasured, 1);
  assert.ok(edits.every((e) => e.box.center[0] === 0 && e.box.dims[2] === 1.6));
});

test('hạ đáy mọi frame: track nối từ job trước thì ghim frame đầu job; đã sát đất thì không ghi gì', () => {
  const frames = [fr(10, zBox(-1), false), fr(11, zBox(-1), false), fr(12, zBox(-1), true)];
  const pinned = Ops.planGroundSnap(frames, new Map([[10, -1], [11, -1.14], [12, -1.3]]), 0.05);
  assert.deepEqual(pinned.edits.map((e) => e.frame), [10, 12]);
  assert.equal(pinned.edits[0].box.center[2], zBox(-1).center[2]);
  assert.deepEqual(Ops.planGroundSnap(frames, new Map([[10, -1.02], [11, -1], [12, -0.97]]), 0.05).edits, []);
});
