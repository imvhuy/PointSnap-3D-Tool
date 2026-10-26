'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/annotator/box.js');

const box = (center, dims, yaw = 0) => ({ center, dims, rotation: [0, 0, yaw] });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('toLocal đảo ngược toWorld với box xoay ba trục', () => {
  const b = { center: [3, -2, 1], dims: [4, 2, 1.5], rotation: [0.1, -0.2, 2.5] };
  const p = [1.2, -0.4, 0.3];
  B.toLocal(b, B.toWorld(b, p)).forEach((v, i) => close(v, p[i]));
});

test('bottomZ là góc đáy thấp nhất', () => {
  close(B.bottomZ(box([0, 0, 1], [4, 2, 2])), 0);
});

test('toCvatPoints giữ phần đuôi 7 số của points gốc', () => {
  const points = [1, 2, 3, 0, 0, 0.5, 4, 2, 1.5, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual(B.toCvatPoints(B.fromCvatPoints(points), points), points);
  assert.equal(B.fromCvatPoints([1, 2, 3, 0, 0, 0, -1, 2, 2]), null);
});

test('overlapRatio: trùng = 1, rời = 0, box nhỏ nằm trong box lớn = 1', () => {
  close(B.overlapRatio(box([0, 0, 0], [4, 2, 1.5]), box([0, 0, 0], [4, 2, 1.5])), 1, 1e-9);
  assert.equal(B.overlapRatio(box([0, 0, 0], [4, 2, 1.5]), box([10, 0, 0], [4, 2, 1.5])), 0);
  close(B.overlapRatio(box([0, 0, 0], [1, 1, 1]), box([0, 0, 0], [4, 4, 2])), 1, 1e-9);
});

test('overlapRatio: chồng chút ít theo chiều cao vẫn tính, chạm mép (≤ 1 cm) thì không', () => {
  close(B.overlapRatio(box([0, 0, 0], [4, 2, 1]), box([0, 0, 0.9], [4, 2, 1])), 1, 1e-9);
  assert.equal(B.overlapRatio(box([0, 0, 0], [4, 2, 1]), box([0, 0, 0.995], [4, 2, 1])), 0);
  close(B.overlapRatio(box([0, 0, 0], [4, 2, 1]), box([3.98, 0, 0], [4, 2, 1])), 0.005, 1e-9);
  assert.equal(B.overlapRatio(box([0, 0, 0], [4, 2, 1]), box([4.0, 0, 0], [4, 2, 1])), 0);
});

test('overlapRatio với box xoay 45°: hình vuông 2×2 và hình thoi cùng tâm chung diện tích 8(√2 − 1)', () => {
  const ratio = B.overlapRatio(box([0, 0, 0], [2, 2, 1]), box([0, 0, 0], [2, 2, 1], Math.PI / 4));
  close(ratio, (8 * (Math.SQRT2 - 1)) / 4, 1e-9);
});

test('wrapAngle / angleDiff đi theo cung ngắn nhất', () => {
  close(B.angleDiff(Math.PI - 0.1, -Math.PI + 0.1), 0.2, 1e-12);
  close(B.wrapAngle(3 * Math.PI), -Math.PI, 1e-12);
});
