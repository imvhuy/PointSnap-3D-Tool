'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ObjectPoints = require('../src/annotator/object-points.js');

const GROUND = -1.8;
const car = { center: [10, 0, GROUND + 0.8], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] };

/** Mặt sau và mặt trái của xe (hình chữ L LiDAR thấy từ gốc), x ∈ [x0, x1], y ∈ [y0, y1]. */
function lShape(x0, x1, y0, y1) {
  const pts = [];
  for (let z = GROUND + 0.3; z <= GROUND + 1.5; z += 0.1) {
    for (let x = x0; x <= x1 + 1e-9; x += 0.1) pts.push([x, y0, z]);
    for (let y = y0; y <= y1 + 1e-9; y += 0.1) pts.push([x0, y, z]);
  }
  return pts;
}

test('box ôm khít vật: mọi điểm trong box, mặt nhìn thấy gần như không hở', () => {
  const r = ObjectPoints.measure(lShape(7.8, 12.2, -0.9, 0.9), car, [], () => GROUND, [0, 0, 0]);
  assert.equal(r.outside.length, 0);
  assert.ok(r.inside.length > 100);
  const tail = r.faces.find((f) => f.name === 'đuôi');
  assert.ok(tail && Math.abs(tail.gapM) < 0.06, `đuôi ${tail && tail.gapM}`);
  assert.ok(!r.faces.some((f) => f.name === 'đầu'), 'mặt đầu quay lưng về LiDAR: không đo');
});

test('box nhỏ hơn vật: điểm lòi ra tô đỏ, mặt đó báo lòi', () => {
  const r = ObjectPoints.measure(lShape(7.3, 12.2, -0.9, 0.9), car, [], () => GROUND, [0, 0, 0]);
  assert.ok(r.outside.length > 20);
  assert.ok(r.faces.find((f) => f.name === 'đuôi').gapM < -0.3);
});

test('box dư so với vật: mặt nhìn thấy báo dư', () => {
  const r = ObjectPoints.measure(lShape(8.3, 12.2, -0.9, 0.9), car, [], () => GROUND, [0, 0, 0]);
  assert.ok(r.faces.find((f) => f.name === 'đuôi').gapM > 0.4);
});

test('vật rời bên cạnh (cột cách 0,45 m) và điểm mặt đất không bị tính là điểm của vật', () => {
  const pts = lShape(7.8, 12.2, -0.9, 0.9);
  for (let z = GROUND; z <= GROUND + 2; z += 0.1) pts.push([7.3, 0, z]);
  for (let x = 6; x <= 14; x += 0.2) pts.push([x, 1.2, GROUND]);
  const r = ObjectPoints.measure(pts, car, [], () => GROUND, [0, 0, 0]);
  assert.equal(r.outside.length, 0);
});

test('điểm thuộc box khác không bị tính', () => {
  const pts = lShape(7.8, 12.2, -0.9, 0.9);
  for (let z = GROUND + 0.3; z <= GROUND + 1.5; z += 0.1) pts.push([7.5, 0, z]);
  const neighbour = { center: [7.5, 0, GROUND + 0.9], dims: [0.4, 0.4, 1.8], rotation: [0, 0, 0] };
  const r = ObjectPoints.measure(pts, car, [neighbour], () => GROUND, [0, 0, 0]);
  assert.equal(r.outside.length, 0);
});

test('vỉa hè cao hơn mặt đường cạnh box: điểm mặt đất không bị tính là điểm của vật, không loang theo vệt tia', () => {
  const sidewalk = (x, y) => (y > 1.0 ? GROUND + 0.16 : GROUND);
  const pts = lShape(7.8, 12.2, -0.9, 0.9);
  for (let x = 6; x <= 14; x += 0.1) for (let y = 1.0; y <= 2.5; y += 0.3) pts.push([x, y, sidewalk(x, y)]);
  const r = ObjectPoints.measure(pts, car, [], sidewalk, [0, 0, 0]);
  assert.equal(r.outside.length, 0);
  assert.ok(!r.faces.some((f) => f.name === 'trái' && f.gapM < -0.05), 'không báo "trái lòi" vì điểm vỉa hè');
});

test('mặt bị nhìn xiên quá 70° hoặc bị vật khác che thì không đo khoảng hở', () => {
  const pts = lShape(7.8, 12.2, -0.9, 0.9);
  const grazing = ObjectPoints.measure(pts, car, [], () => GROUND, [0, -30, 0]);
  assert.ok(!grazing.faces.some((f) => f.name === 'đuôi'), 'LiDAR lệch sang phải 30 m: mặt đuôi bị nhìn xiên');
  const hidden = ObjectPoints.measure(pts, car, [], () => GROUND, [0, 0, 0], { faceOccluded: () => true });
  assert.deepEqual(hidden.faces, []);
});
