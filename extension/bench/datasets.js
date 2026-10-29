'use strict';
/*
 * Đọc chuỗi frame của bộ dữ liệu công khai cho phần đo (không nạp vào extension): point cloud hệ cảm biến như CVAT thấy,
 * box nhãn chuẩn cùng hệ đó (dạng box của PointSnap, chỉ yaw), và pose thật (cảm biến → thế giới) để đo chuyển động xe.
 * - nuScenes (bản mini): keyframe LIDAR_TOP 2 Hz hoặc cả sweep 20 Hz, pose = ego_pose · calibrated_sensor.
 * - Argoverse 2: thư mục do av2_to_cvat.py xuất (pointcloud/*.pcd hệ ego, annotations.json dạng CVAT, poses.json ego → city).
 * Frame: { index, time (s), positions: Float32Array xyz, boxes: [{ box, label, track }], pose: { R, t } }.
 */
const fs = require('fs');
const path = require('path');
const B = require('../src/annotator/box.js');
const Pcd = require('../src/annotator/pcd.js');

// ------------------------------------------------------------------ phép biến đổi cứng { R (3×3), t }

const mul = (A, Bm) => A.map((row) => [0, 1, 2].map((j) => row[0] * Bm[0][j] + row[1] * Bm[1][j] + row[2] * Bm[2][j]));
const tr = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);
const apply3 = (R, v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

/** a ∘ b: áp b trước rồi a. */
function compose(a, b) {
  const t = apply3(a.R, b.t);
  return { R: mul(a.R, b.R), t: [t[0] + a.t[0], t[1] + a.t[1], t[2] + a.t[2]] };
}

function invert(a) {
  const Rt = tr(a.R), t = apply3(Rt, a.t);
  return { R: Rt, t: [-t[0], -t[1], -t[2]] };
}

const applyT = (a, p) => { const q = apply3(a.R, p); return [q[0] + a.t[0], q[1] + a.t[1], q[2] + a.t[2]]; };

function quatToR([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Góc (roll, pitch, yaw) theo thứ tự Z-Y-X của ma trận quay. */
function eulerZYX(R) {
  return { roll: Math.atan2(R[2][1], R[2][2]), pitch: Math.asin(Math.max(-1, Math.min(1, -R[2][0]))), yaw: Math.atan2(R[1][0], R[0][0]) };
}

// ------------------------------------------------------------------ nuScenes

const NUS_CLASS = [
  [/^vehicle\.car/, 'car'], [/^vehicle\.truck/, 'truck'], [/^vehicle\.bus/, 'bus'], [/^vehicle\.trailer/, 'trailer'],
  [/^vehicle\.construction/, 'construction_vehicle'], [/^vehicle\.motorcycle/, 'motorcycle'], [/^vehicle\.bicycle/, 'bicycle'],
  [/^human\.pedestrian/, 'pedestrian'], [/^movable_object\.trafficcone/, 'traffic_cone'], [/^movable_object\.barrier/, 'barrier'],
];
const nusLabel = (category) => (NUS_CLASS.find(([re]) => re.test(category)) || [null, category.split('.').pop()])[1];

const nusCache = new Map();
function nusTables(root) {
  if (!nusCache.has(root)) {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, 'v1.0-mini', `${name}.json`), 'utf8'));
    const byToken = (rows) => new Map(rows.map((r) => [r.token, r]));
    const t = {
      scene: read('scene'), sample: byToken(read('sample')), sampleData: read('sample_data'),
      egoPose: byToken(read('ego_pose')), calib: byToken(read('calibrated_sensor')), instance: byToken(read('instance')),
      category: byToken(read('category')), annotations: new Map(),
    };
    for (const a of read('sample_annotation')) {
      if (!t.annotations.has(a.sample_token)) t.annotations.set(a.sample_token, []);
      t.annotations.get(a.sample_token).push(a);
    }
    t.lidarOfSample = new Map(t.sampleData.filter((d) => d.is_key_frame && d.filename.startsWith('samples/LIDAR_TOP/')).map((d) => [d.sample_token, d]));
    nusCache.set(root, t);
  }
  return nusCache.get(root);
}

const nusScenes = (root) => nusTables(root).scene.map((s) => s.name);

/**
 * Frame LIDAR_TOP của một cảnh nuScenes: keyframe 2 Hz (như khi nhập vào CVAT), hoặc `sweeps: true` cả sweep 20 Hz.
 * Sweep không có nhãn: lấy box của keyframe gần nhất theo thời gian, đổi sang hệ cảm biến của sweep (vật đang chạy lệch
 * tối đa 0,25 s).
 */
function loadNuScenes(root, sceneName, { sweeps = false } = {}) {
  const t = nusTables(root);
  const scene = t.scene.find((s) => s.name === sceneName);
  if (!scene) throw new Error(`Không có cảnh ${sceneName}`);
  const keyTokens = [];
  for (let token = scene.first_sample_token; token; token = t.sample.get(token).next) keyTokens.push(token);
  let datas = keyTokens.map((token) => t.lidarOfSample.get(token));
  if (sweeps) {
    const byToken = t.sampleDataByToken || (t.sampleDataByToken = new Map(t.sampleData.map((d) => [d.token, d])));
    const last = datas[datas.length - 1];
    datas = [];
    for (let d = t.lidarOfSample.get(keyTokens[0]); d; d = d.next ? byToken.get(d.next) : null) {
      datas.push(d);
      if (d === last) break;
    }
  }
  const keyTimes = keyTokens.map((token) => t.lidarOfSample.get(token).timestamp);
  return {
    name: `nuScenes ${sceneName}${sweeps ? ' (sweep 20 Hz)' : ''}`,
    frames: datas.map((sd, index) => {
      const ego = t.egoPose.get(sd.ego_pose_token), cal = t.calib.get(sd.calibrated_sensor_token);
      const pose = compose({ R: quatToR(ego.rotation), t: ego.translation }, { R: quatToR(cal.rotation), t: cal.translation }); // cảm biến → thế giới
      const toSensor = invert(pose);
      const raw = new Float32Array(fs.readFileSync(path.join(root, sd.filename)).buffer.slice(0));
      const positions = new Float32Array((raw.length / 5) * 3);
      for (let i = 0, j = 0; i < raw.length; i += 5, j += 3) { positions[j] = raw[i]; positions[j + 1] = raw[i + 1]; positions[j + 2] = raw[i + 2]; }
      const nearest = keyTimes.reduce((best, kt, k) => (Math.abs(kt - sd.timestamp) < Math.abs(keyTimes[best] - sd.timestamp) ? k : best), 0);
      // Box không có điểm LiDAR nào (gán từ camera) bị bỏ, như bộ đánh giá của nuScenes: người gán trên CVAT không thấy chúng.
      const boxes = (t.annotations.get(keyTokens[nearest]) || []).filter((a) => a.num_lidar_pts > 0).map((a) => {
        const center = applyT(toSensor, a.translation);
        const R = mul(toSensor.R, quatToR(a.rotation));
        const label = nusLabel(t.category.get(t.instance.get(a.instance_token).category_token).name);
        // nuScenes ghi size = [rộng, dài, cao]; PointSnap / CVAT: [dài, rộng, cao], chỉ yaw (như khi nhập vào CVAT).
        return { box: { center, dims: [a.size[1], a.size[0], a.size[2]], rotation: [0, 0, Math.atan2(R[1][0], R[0][0])] }, label, track: a.instance_token };
      });
      return { index, time: sd.timestamp / 1e6, positions, boxes, pose, keyframe: sd.is_key_frame };
    }),
  };
}

// ------------------------------------------------------------------ Argoverse 2 (bản xuất av2_to_cvat.py)

function loadAv2(dir) {
  const poses = JSON.parse(fs.readFileSync(path.join(dir, 'poses.json'), 'utf8'));
  const ann = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  const frames = poses.map((p, index) => ({
    index, time: index * 0.1, pose: { R: p.R, t: p.t }, boxes: [],
    positions: Pcd.parse(fs.readFileSync(path.join(dir, 'pointcloud', `${String(index).padStart(6, '0')}.pcd`))),
  }));
  ann.tracks.forEach((track, ti) => {
    for (const s of track.shapes) {
      if (s.outside || !frames[s.frame]) continue;
      const box = B.fromCvatPoints(s.points);
      if (box) frames[s.frame].boxes.push({ box, label: track.label, track: `t${ti}` });
    }
  });
  return { name: `Argoverse 2 ${path.basename(path.dirname(dir))}/${path.basename(dir)}`, frames };
}

module.exports = { loadNuScenes, nusScenes, loadAv2, compose, invert, applyT, quatToR, eulerZYX };
