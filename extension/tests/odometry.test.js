'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Odo = require('../bench/odometry.js');
const D = require('../bench/datasets.js');

/** Cảnh giả: đường dốc nhẹ, tường hai bên và hai mảng tường ngang, vài cột; đủ ràng buộc cả 6 bậc. */
function scene() {
  const pts = [];
  for (let x = -40; x <= 40; x += 0.25) for (let y = -12; y <= 12; y += 0.25) pts.push(x, y, -1.8 + 0.02 * x);
  for (let x = -40; x <= 40; x += 0.25) for (let z = -1.8; z <= 2; z += 0.25) { pts.push(x, 12, z); pts.push(x, -12 + 0.1 * Math.sin(x / 5), z); }
  // Hai mảng tường vuông góc hướng đi: thiếu chúng thì chiều dọc đường suy biến (như đường cao tốc trống).
  for (let y = 3; y <= 12; y += 0.25) for (let z = -1.8; z <= 2; z += 0.25) pts.push(18, y, z);
  for (let y = -12; y <= -3; y += 0.25) for (let z = -1.8; z <= 2; z += 0.25) pts.push(-25, y, z);
  for (const [cx, cy] of [[8, 6], [-15, -7], [22, -5], [-30, 4]]) {
    for (let a = 0; a < 2 * Math.PI; a += 0.3) for (let z = -1.8; z <= 2; z += 0.2) pts.push(cx + 0.3 * Math.cos(a), cy + 0.3 * Math.sin(a), z);
  }
  return new Float32Array(pts);
}

test('khớp 6 bậc tìm lại đúng chuyển động đã biết (tịnh tiến 2 m, quay 3°, chúc 0,5°)', () => {
  const cloud = scene();
  const truth = { R: D.quatToR(quat(0.004, 0.0087, 0.052)), t: [2.0, 0.3, 0.05] }; // điểm frame sau → frame trước
  const inv = D.invert(truth);
  const moved = new Float32Array(cloud.length);
  for (let i = 0; i < cloud.length; i += 3) moved.set(D.applyT(inv, [cloud[i], cloud[i + 1], cloud[i + 2]]), i);
  const o = { ...Odo.OPT, minRange: 0 };
  const res = Odo.register(Odo.prepare(moved, [], o), Odo.target(Odo.prepare(cloud, [], o), o), undefined, o);
  const err = D.compose(D.invert(truth), res.T);
  assert.ok(Math.hypot(...err.t) < 0.02, `lệch tịnh tiến ${Math.hypot(...err.t)}`);
  const e = D.eulerZYX(err.R);
  for (const k of ['roll', 'pitch', 'yaw']) assert.ok(Math.abs(e[k]) * 180 / Math.PI < 0.05, `lệch ${k} ${e[k] * 180 / Math.PI}°`);
});

/** Quaternion [w, x, y, z] từ góc roll, pitch, yaw nhỏ (rad). */
function quat(roll, pitch, yaw) {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
}
