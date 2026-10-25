'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Grid = require('../src/annotator/spatial-grid.js');
const Terrain = require('../src/annotator/terrain.js');

/** Mặt đường z = f(x, y) lấy mẫu đều mỗi `step` mét trong hình vuông nửa cạnh `half` quanh (0, 0). */
function road(f, half = 15, step = 0.1) {
  const pts = [];
  for (let x = -half; x <= half; x += step) for (let y = -half; y <= half; y += step) pts.push(x, y, f(x, y));
  return pts;
}

/** Xe 4,5 × 1,9 × 1,6 m đặt sát đất tại (0, 0), mặt đường dưới gầm bị che (bỏ điểm đất trong footprint). */
function scene(groundZ = -1.8) {
  const pts = [];
  const flat = road(() => groundZ);
  for (let i = 0; i < flat.length; i += 3) {
    if (Math.abs(flat[i]) <= 2.25 && Math.abs(flat[i + 1]) <= 0.95) continue;
    pts.push(flat[i], flat[i + 1], flat[i + 2]);
  }
  for (let x = -2.2; x <= 2.2; x += 0.1) for (let z = groundZ + 0.3; z <= groundZ + 1.6; z += 0.1) pts.push(x, -0.95, z);
  const car = { center: [0, 0, groundZ + 0.8], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] };
  return { pts, car };
}

function measure(points, boxes, target) {
  const grid = Grid.build(new Float32Array(points), 1);
  const terrain = Terrain.build(grid, boxes);
  return { terrain, contact: Terrain.measureContact(terrain, grid, target) };
}

test('nội suy được mặt đất dưới gầm xe và đo box sát đất ≈ 0', () => {
  const { pts, car } = scene();
  const { terrain, contact } = measure(pts, [car], car);
  assert.ok(Math.abs(terrain.heightAt(0, 0).z + 1.8) < 0.02);
  assert.ok(Math.abs(contact.gapM) < 0.02, `gap ${contact.gapM}`);
});

test('box lơ lửng 30 cm: gapM ≈ +0,30', () => {
  const { pts, car } = scene();
  const floating = { ...car, center: [0, 0, car.center[2] + 0.3] };
  const { contact } = measure(pts, [floating], floating);
  assert.ok(Math.abs(contact.gapM - 0.3) < 0.03, `gap ${contact.gapM}`);
});

test('điểm phản xạ dưới mặt đất không kéo mặt đất xuống', () => {
  const { pts, car } = scene();
  for (let x = 3; x < 8; x += 0.4) pts.push(x, 3, -3.2);
  const { terrain } = measure(pts, [car], car);
  assert.ok(Math.abs(terrain.heightAt(5, 3).z + 1.8) < 0.03);
});

test('điểm của vật nằm dưới đáy box là bằng chứng lơ lửng', () => {
  const { pts, car } = scene();
  for (let x = -1.8; x <= 1.8; x += 0.3) for (let z = -1.7; z <= -1.55; z += 0.05) pts.push(x, 0.5, z);
  const floating = { ...car, center: [0, 0, car.center[2] + 0.35] };
  const { contact } = measure(pts, [floating], floating);
  assert.ok(contact.pointsBelowBottom >= 8, `${contact.pointsBelowBottom} điểm`);
});

test('đường dốc: tiếp đất tính ở góc thấp nhất của footprint', () => {
  const slope = 0.08;
  const pts = road((x) => slope * x - 1.8, 20);
  const box = { center: [10, 0, 0], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] };
  const lowestCorner = slope * (10 - 2.25) - 1.8;
  const { contact } = measure(pts, [], { ...box, center: [10, 0, lowestCorner + 0.8] });
  assert.ok(Math.abs(contact.gapM) < 0.03, `gap ${contact.gapM}`);
  assert.ok(contact.spreadM > 0.3);
});

test('mặt phẳng trên cao (mái hiên, nóc vật chưa gán) không thành mặt đất của box', () => {
  const pts = road(() => -1.8, 6);
  for (let x = -1.5; x <= 1.5; x += 0.1) for (let y = 1.0; y <= 4; y += 0.1) pts.push(x, y, 2.2);
  const ped = { center: [0, 0.6, -1.0], dims: [0.6, 0.6, 1.6], rotation: [0, 0, 0] };
  const { contact } = measure(pts, [ped], ped);
  assert.ok(Math.abs(contact.gapM) < 0.03, `gap ${contact.gapM}`);
});

test('bờ vỉa dưới footprint: đáy box giữa mặt đường và vỉa hè không bị báo, điểm vỉa hè không bị coi là điểm của vật', () => {
  const pts = road((x, y) => (y > 0 ? -1.65 : -1.8));
  const car = { center: [5, 0.2, -1.65 + 0.8], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] };
  const { contact } = measure(pts, [car], car);
  assert.equal(contact.gapM, 0);
  assert.ok(contact.spreadM > 0.1);
  assert.equal(contact.pointsBelowBottom, 0);
});

test('không có điểm đất quanh box thì không đoán', () => {
  const box = { center: [0, 0, 0], dims: [4, 2, 1.5], rotation: [0, 0, 0] };
  const pts = road(() => -1.8, 2).map((v, i) => (i % 3 === 0 ? v + 50 : v));
  const { contact } = measure(pts, [], box);
  assert.equal(contact, null);
});

test('thân vật chưa gán nhãn không bị coi là mặt đất', () => {
  const pts = road(() => -1.8, 10);
  for (let z = -1.8; z <= 0.5; z += 0.05) for (let a = 0; a < 6; a += 1) pts.push(5 + 0.1 * Math.cos(a), 5 + 0.1 * Math.sin(a), z);
  const { terrain } = measure(pts, [], { center: [0, 0, -1], dims: [1, 1, 1], rotation: [0, 0, 0] });
  const pole = terrain.heightAt(5, 5);
  assert.ok(pole && Math.abs(pole.z + 1.8) < 0.05, 'cột: lấy mặt đất nội suy, không lấy độ cao thân cột');
});
