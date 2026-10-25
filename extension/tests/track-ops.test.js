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
