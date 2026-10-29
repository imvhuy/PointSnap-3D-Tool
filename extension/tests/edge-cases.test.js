'use strict';

/*
 * Edge case của các module tính toán: dữ liệu rỗng / hỏng (NaN, Infinity), góc quanh ±180°, track ngắn, cấu hình
 * ghi đè sai kiểu. Mỗi test là một tình huống gặp được trên CVAT thật, không phải hình mẫu đẹp.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const B = require('../src/annotator/box.js');
const Grid = require('../src/annotator/spatial-grid.js');
const Terrain = require('../src/annotator/terrain.js');
const Checks = require('../src/annotator/checks.js');
const G = require('../src/annotator/guideline.js');
const Ops = require('../src/annotator/track-ops.js');
const ObjectPoints = require('../src/annotator/object-points.js');
require('../src/annotator/cloud-colors.js');
const Colors = globalThis.PointSnapCloudColors;

const GROUND = -1.8;
const g = G.DEFAULT_GUIDELINE;
const box = (center, dims = [4.5, 1.9, 1.6], yaw = 0) => ({ center, dims, rotation: [0, 0, yaw] });
const car = box([10, 0, GROUND + 0.8]);

function road(f = () => GROUND, half = 15, step = 0.1) {
  const pts = [];
  for (let x = -half; x <= half; x += step) for (let y = -half; y <= half; y += step) pts.push(x, y, f(x, y));
  return pts;
}

// ------------------------------------------------------------------ box

test('box: points CVAT hỏng (thiếu phần tử, NaN, kích thước 0 / âm) thì không thành box', () => {
  assert.equal(B.fromCvatPoints(null), null);
  assert.equal(B.fromCvatPoints([1, 2, 3]), null);
  assert.equal(B.fromCvatPoints([0, 0, NaN, 0, 0, 0, 1, 1, 1]), null);
  assert.equal(B.fromCvatPoints([0, 0, 0, 0, 0, 0, 1, 0, 1]), null);
  assert.equal(B.fromCvatPoints([0, 0, 0, 0, 0, 0, 1, -1, 1]), null);
  assert.ok(B.fromCvatPoints([0, 0, 0, 0, 0, 0, 1, 1, 1]), 'đủ 9 số là đọc được');
});

test('box: ghi lại points giữ đủ 16 phần tử kể cả khi mảng gốc ngắn', () => {
  assert.equal(B.toCvatPoints(car, [1, 2, 3]).length, 16);
  assert.deepEqual(B.toCvatPoints(car, [...new Array(9).fill(0), 7, 7, 7, 7, 7, 7, 7]).slice(9), new Array(7).fill(7));
});

test('box: góc quanh ±180° lấy hiệu ngắn nhất', () => {
  assert.ok(Math.abs(B.angleDiff(Math.PI - 0.01, -Math.PI + 0.01) - 0.02) < 1e-9);
  assert.ok(Math.abs(B.wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
  assert.ok(Math.abs(B.wrapAngle(-7 * Math.PI / 2) - Math.PI / 2) < 1e-9);
});

test('box: toLocal ∘ toWorld là đồng nhất kể cả khi box có pitch / roll', () => {
  const tilted = { center: [3, -2, 1], dims: [2, 1, 1], rotation: [0.2, -0.3, 2.5] };
  const back = B.toLocal(tilted, B.toWorld(tilted, [0.4, -0.3, 0.2]));
  [0.4, -0.3, 0.2].forEach((v, i) => assert.ok(Math.abs(back[i] - v) < 1e-9));
});

test('box: chồng lấn – trùng khít, nằm gọn trong, xếp chồng theo chiều cao, chạm mép, xoay 90°', () => {
  assert.ok(Math.abs(B.overlapRatio(car, car) - 1) < 1e-9);
  assert.ok(Math.abs(B.overlapRatio(car, box([10, 0, GROUND + 0.8], [1, 1, 1.6])) - 1) < 1e-9, 'box nhỏ nằm gọn trong box lớn');
  assert.equal(B.overlapRatio(car, box([10, 0, GROUND + 0.8 + 1.7])), 0, 'box ở tầng trên không chồng');
  assert.ok(B.overlapRatio(car, box([14.5, 0, GROUND + 0.8])) < 1e-6, 'chỉ chạm mép');
  const square = box([0, 0, 0], [2, 2, 1]);
  assert.ok(Math.abs(B.overlapRatio(square, box([0, 0, 0], [2, 2, 1], Math.PI / 2)) - 1) < 1e-9);
});

// ------------------------------------------------------------------ chỉ mục không gian

test('grid: cloud rỗng không lỗi, không trả điểm', () => {
  const grid = Grid.build(new Float32Array(0), 1);
  assert.deepEqual(Grid.pointsNearBox(grid, car, 0.5), []);
  assert.equal(Grid.segmentBlocked(grid, [0, 0, 0], [10, 0, 0]), false);
});

test('grid: điểm NaN (PCD có tia không phản xạ) bị bỏ qua, điểm thật vẫn tra được', () => {
  const grid = Grid.build(new Float32Array([NaN, NaN, NaN, 10, 0, -1, NaN, 5, 0]), 1);
  assert.deepEqual(Grid.pointsNearBox(grid, car, 0), [1]);
});

test('grid / terrain: điểm Infinity không làm treo trang', () => {
  const script = `
    const Grid = require(${JSON.stringify(path.join(__dirname, '../src/annotator/spatial-grid.js'))});
    const Terrain = require(${JSON.stringify(path.join(__dirname, '../src/annotator/terrain.js'))});
    const grid = Grid.build(new Float32Array([Infinity, 0, 0, 0, 0, -1.8, 1, 0, -1.8]), 1);
    Terrain.build(grid, []);
    process.stdout.write(String(Grid.pointsNearBox(grid, { center: [0.5, 0, -1], dims: [2, 2, 2], rotation: [0, 0, 0] }, 0).length));
  `;
  const run = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(run.signal, null, 'quá 5 s: vòng lặp vô hạn');
  assert.equal(run.stdout, '2');
});

test('grid: một điểm lạc rất xa (1e6 m) không làm hỏng tra cứu quanh box', () => {
  const pts = [...road(() => GROUND, 12, 0.5), 1e6, 1e6, 0];
  const grid = Grid.build(new Float32Array(pts), 1);
  assert.ok(Grid.pointsNearBox(grid, car, 0).length > 20);
});

// ------------------------------------------------------------------ mặt đất

test('terrain: cloud rỗng hoặc toàn điểm của box thì không đo, không lỗi', () => {
  const empty = Terrain.build(Grid.build(new Float32Array(0), 1), []);
  assert.equal(empty.available, false);
  assert.equal(Terrain.measureContact(empty, Grid.build(new Float32Array(0), 1), car), null);
  const inside = [];
  for (let x = 8; x <= 12; x += 0.2) inside.push(x, 0, GROUND + 0.5);
  const grid = Grid.build(new Float32Array(inside), 1);
  assert.equal(Terrain.build(grid, [car]).available, false);
});

test('terrain: điểm NaN lẫn trong mặt đường không làm độ cao thành NaN', () => {
  const pts = road();
  for (let i = 0; i < pts.length; i += 300) pts[i + 2] = NaN;
  const grid = Grid.build(new Float32Array(pts), 1);
  const terrain = Terrain.build(grid, []);
  const h = terrain.heightAt(10, 3);
  assert.ok(h && Math.abs(h.z - GROUND) < 0.02, `z = ${h && h.z}`);
  const contact = Terrain.measureContact(terrain, grid, car);
  assert.ok(contact && Number.isFinite(contact.gapM) && Math.abs(contact.gapM) < 0.02);
});

test('terrain: box nằm ngoài vùng có điểm thì không đo (không ngoại suy bừa)', () => {
  const grid = Grid.build(new Float32Array(road(() => GROUND, 5)), 1);
  assert.equal(Terrain.measureContact(Terrain.build(grid, []), grid, box([40, 0, GROUND + 0.8])), null);
});

test('terrain: quá ít điểm đất quanh box thì số đo không đủ tin để báo', () => {
  const pts = [];
  for (let x = 7.4; x <= 7.8; x += 0.1) for (let y = -1.2; y <= -0.8; y += 0.1) pts.push(x, y, GROUND);
  const grid = Grid.build(new Float32Array(pts), 1);
  const contact = Terrain.measureContact(Terrain.build(grid, []), grid, car);
  assert.equal(Checks.usableContact(contact, car, g), null);
});

test('terrain: box xoay 45° trên dốc 5% nằm sát mặt dốc thì không báo lơ lửng / lún', () => {
  const slope = (x) => GROUND + 0.05 * x;
  const grid = Grid.build(new Float32Array(road(slope, 20)), 1);
  const yawed = box([10, 0, 0], [4.5, 1.9, 1.6], Math.PI / 4);
  const fp = B.footprint(yawed).map(([x]) => slope(x));
  // Đáy box đặt ở giữa mặt dốc thấp nhất / cao nhất dưới footprint.
  yawed.center[2] = (Math.min(...fp) + Math.max(...fp)) / 2 + 0.8;
  const contact = Terrain.measureContact(Terrain.build(grid, []), grid, yawed);
  assert.equal(contact.gapM, 0);
  assert.ok(contact.spreadM > 0.15);
});

// ------------------------------------------------------------------ kiểm tra

const baseInput = (overrides = {}) => ({
  box: car, label: 'car', classKey: 'car', attributes: {}, occluded: false, trackDims: null,
  contact: null, coarseGroundZ: null, others: [], pointsInside: 50, ...overrides,
});

test('checks: class không có trong guideline thì không báo kích thước, không lỗi', () => {
  const issues = Checks.checkBox(baseInput({ label: 'ufo', classKey: 'ufo', box: box([10, 0, 0], [30, 30, 30]) }), g);
  assert.deepEqual(issues.filter((i) => i.severity !== 'info'), []);
});

test('checks: mặt đất kiểm mọi class mặc định (label CVAT công ty "vehicles"); spec liệt kê class thì chỉ kiểm các class đó', () => {
  const contact = { contactZ: GROUND, topContactZ: GROUND, gapM: 0.4, spreadM: 0, confidence: 1, pointsBelowBottom: 0 };
  const floating = baseInput({ label: 'vehicles', classKey: 'vehicles', contact, box: box([10, 0, GROUND + 1.2]) });
  assert.equal(Checks.checkBox(floating, g).find((i) => i.rule === 'ground.gap')?.severity, 'error');
  const listed = G.resolve({ ground: { classes: ['car'] } }).guideline;
  assert.ok(!Checks.checkBox(floating, listed).some((i) => i.rule.startsWith('ground.')));
});

test('checks: box occluded không bị báo lơ lửng / rỗng / Z', () => {
  const contact = { contactZ: GROUND - 0.5, topContactZ: GROUND - 0.5, gapM: 0.5, spreadM: 0, confidence: 1, pointsBelowBottom: 20 };
  const issues = Checks.checkBox(baseInput({ occluded: true, contact, coarseGroundZ: GROUND - 3, pointsInside: 0 }), g);
  assert.ok(!issues.some((i) => /^(ground|fit|z)\./.test(i.rule)), JSON.stringify(issues));
});

test('checks: thuộc tính bắt buộc rỗng ("") cũng là thiếu; giá trị "false" là đã chọn', () => {
  const missing = Checks.checkBox(baseInput({ label: 'Vehicle', classKey: 'Vehicle', attributes: { subtype: '' } }), g);
  assert.ok(missing.some((i) => i.rule === 'attr.missing'));
  const chosen = Checks.checkBox(baseInput({ label: 'Two-wheels', classKey: 'Two-wheels', attributes: { rider_state: 'false' } }), g);
  assert.ok(!chosen.some((i) => i.rule === 'attr.missing'));
});

test('checks: track 1–2 keyframe, hoặc người đi bộ, thì không kiểm scale theo track', () => {
  assert.ok(!Checks.checkBox(baseInput({ trackDims: [[3, 1.9, 1.6]] }), g).some((i) => i.rule === 'size.in_track'));
  const ped = baseInput({ label: 'pedestrian', classKey: 'pedestrian', box: box([10, 0, -1], [0.6, 0.6, 1.7]),
    trackDims: [[1.1, 0.6, 1.7], [0.5, 0.6, 1.7], [0.5, 0.6, 1.7]] });
  assert.ok(!Checks.checkBox(ped, g).some((i) => i.rule === 'size.in_track'));
});

test('checks: box rất xa – không đo cao độ (Thông tin), quá phạm vi gán nhãn khi cấu hình maxDistanceM', () => {
  const far = box([80, 0, GROUND + 0.8]);
  const { guideline } = G.resolve({ maxDistanceM: 60 });
  const issues = Checks.checkBox(baseInput({ box: far }), guideline);
  assert.ok(issues.some((i) => i.rule === 'ground.no_evidence' && i.severity === 'info'));
  assert.ok(issues.some((i) => i.rule === 'range.too_far'));
});

test('checks: chồng lấn với class không kiểm thì bỏ qua', () => {
  const others = [{ box: car, label: 'barrier', classKey: 'barrier', clientId: 9 }];
  const listed = G.resolve({ overlap: { classes: ['car'] } }).guideline;
  assert.deepEqual(Checks.checkBox(baseInput({ others }), listed).filter((i) => i.rule.startsWith('overlap')), []);
});

test('checks: ngoại lai – mảng rỗng / 1–2 phần tử / toàn bằng nhau không báo', () => {
  assert.deepEqual(Checks.madOutliers([], 0.05), []);
  assert.deepEqual(Checks.madOutliers([1, 5], 0.05), [false, false]);
  assert.deepEqual(Checks.madOutliers([2, 2, 2, 2], 0.05), [false, false, false, false]);
  assert.deepEqual(Checks.angleOutliers([0.1, 3], 15), [false, false]);
  assert.deepEqual(Checks.inTrackOutliers([], g), []);
});

test('checks: yaw dao động quanh ±180° không bị coi là bước nhảy; một frame quay ngang thì bị bắt', () => {
  const wrapped = [3.13, -3.13, 3.12, -3.12, 3.14, -3.11, 3.13];
  assert.ok(!Checks.angleOutliers(wrapped, 15).some(Boolean));
  const jump = wrapped.slice();
  jump[3] = Math.PI / 2;
  assert.deepEqual(Checks.angleOutliers(jump, 15).map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [3]);
});

test('checks: xe rẽ gắt ở ngã tư (nuScenes scene-1077, 2 Hz) không bị đánh dấu yaw', () => {
  const deg = [-156, 176, 153, 137, 122, 108].map((d) => (d * Math.PI) / 180);
  assert.ok(!Checks.angleOutliers(deg, 15).some(Boolean));
});

test('checks: keyframe lật 180° ở đầu hoặc cuối track vẫn bị bắt; keyframe thưa tính theo frame', () => {
  const yaw = [0.1, 0.12, 0.14, 0.16, 0.18, 0.2];
  const last = yaw.slice(); last[5] += Math.PI;
  assert.deepEqual(Checks.angleOutliers(last, 15).map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [5]);
  const first = yaw.slice(); first[0] += Math.PI;
  assert.deepEqual(Checks.angleOutliers(first, 15).map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [0]);
  // quay đều 3°/frame, keyframe cách nhau 1 rồi 10 frame: theo chỉ số thì như bước nhảy, theo frame thì đều
  const frames = [0, 1, 2, 12, 22, 23], spaced = frames.map((f) => (f * 3 * Math.PI) / 180);
  assert.ok(!Checks.angleOutliers(spaced, 15, frames).some(Boolean));
});

// ------------------------------------------------------------------ guideline ghi đè

test('guideline: ghi đè không phải object (null, mảng, chuỗi) thì dùng mặc định, không lỗi', () => {
  for (const override of [null, [], 'abc', 42]) {
    const { guideline, errors } = G.resolve(override);
    assert.equal(guideline, G.DEFAULT_GUIDELINE);
    assert.deepEqual(errors, []);
  }
});

test('guideline: ghi đè sai kiểu ở mọi phần luật dùng thì báo lỗi, không làm sập vòng vẽ', () => {
  const bad = [
    { size: null },
    { size: { ranges: { car: { length: null } } } }, // null cả khóa car là bỏ khoảng (hợp lệ); null một chiều thì không
    { size: { nonRigidClasses: 'pedestrian' } },
    { size: { inTrack: { warningAbsM: 'x' } } },
    { ground: null },
    { ground: { classes: 'car' } },
    { ground: { minConfidence: '0.3' } },
    { ground: { warningM: 0.5, errorM: 0.3 } },
    { overlap: { classes: null } },
    { overlap: { allowedPairs: [['car']] } },
    { overlap: { warning: 0.6, error: 0.5 } },
    { attributes: { required: { Vehicle: 'subtype' } } },
    { specNotes: { Vehicle: 'Không gán người trong xe' } },
    { trackOps: { yawJumpDeg: { rigid: 'a' } } },
    { trackOps: { thinning: { centerM: 0 } } },
    { trackOps: { yawSmoothing: null } },
    { sensorOrigin: [0, 0] },
  ];
  for (const override of bad) {
    let result;
    assert.doesNotThrow(() => { result = G.resolve(override); }, JSON.stringify(override));
    assert.ok(result.errors.length, `phải báo lỗi: ${JSON.stringify(override)}`);
    assert.equal(result.guideline, G.DEFAULT_GUIDELINE);
  }
});

// ------------------------------------------------------------------ thao tác track

const kf = (frame, center, yaw = 0, dims = [4.5, 1.9, 1.6], extra = {}) => ({
  frame, box: { center, rotation: [0, 0, yaw], dims }, outside: false, occluded: false, attrsKey: '{}', ...extra,
});
const tol = g.trackOps.thinning;

test('tỉa keyframe: track 0 / 1 / 2 keyframe không bỏ gì', () => {
  assert.equal(Ops.planThinning([], tol).edits.length, 0);
  assert.equal(Ops.planThinning([kf(0, [0, 0, 0])], tol).edits.length, 0);
  assert.equal(Ops.planThinning([kf(0, [0, 0, 0]), kf(5, [5, 0, 0])], tol).edits.length, 0);
});

test('tỉa keyframe: chuyển động đều (pre-label mọi frame) chỉ giữ đầu và cuối', () => {
  const frames = Array.from({ length: 20 }, (_, f) => kf(f, [f * 0.8, 0.02 * f, 0], 0.01 * f));
  const { edits, summary } = Ops.planThinning(frames, tol);
  assert.equal(summary.kept, 2);
  assert.equal(edits.length, 18);
  assert.ok(summary.maxCenterErrorM < 1e-9);
});

test('tỉa keyframe: giữ keyframe outside và hai bên chỗ đổi thuộc tính / occluded', () => {
  const frames = Array.from({ length: 12 }, (_, f) => kf(f, [f, 0, 0]));
  frames[4] = { ...frames[4], outside: true };
  frames[8] = { ...frames[8], attrsKey: '{"1":"parked"}' };
  frames[9] = { ...frames[9], attrsKey: '{"1":"parked"}' };
  const removed = new Set(Ops.planThinning(frames, tol).edits.map((e) => e.frame));
  for (const f of [0, 3, 4, 5, 7, 8, 9, 10, 11]) assert.ok(!removed.has(f), `frame ${f} phải giữ`);
});

test('tỉa keyframe: quay đều qua ±180° vẫn nội suy được (cung ngắn nhất) nên được tỉa', () => {
  const frames = Array.from({ length: 9 }, (_, f) => kf(f, [f, 0, 0], B.wrapAngle(Math.PI - 0.2 + 0.05 * f)));
  assert.equal(Ops.planThinning(frames, tol).summary.kept, 2);
});

test('mượt yaw: dưới 3 keyframe hoặc yaw quanh ±180° ổn định thì không đổi gì', () => {
  const s = g.trackOps.yawSmoothing;
  assert.equal(Ops.planYawSmoothing([kf(0, [0, 0, 0]), kf(1, [1, 0, 0], Math.PI)], s).edits.length, 0);
  const steady = [3.13, -3.13, 3.12, -3.12, 3.14].map((yaw, f) => kf(f, [f, 0, 0], yaw));
  assert.equal(Ops.planYawSmoothing(steady, s).edits.length, 0);
});

test('mượt yaw: một keyframe lật 180° được xoay lại; xe quay đầu thật (dần 0 → 180°) không bị lật', () => {
  const s = g.trackOps.yawSmoothing;
  const flipped = Array.from({ length: 7 }, (_, f) => kf(f, [f, 0, 0], f === 3 ? Math.PI : 0));
  const plan = Ops.planYawSmoothing(flipped, s);
  assert.equal(plan.summary.flips, 1);
  assert.deepEqual(plan.edits.map((e) => e.frame), [3]);
  assert.ok(Math.abs(B.wrapAngle(plan.edits[0].box.rotation[2])) < 1e-9);
  const uTurn = Array.from({ length: 13 }, (_, f) => kf(f, [f, 0, 0], B.wrapAngle((Math.PI * f) / 12)));
  const turn = Ops.planYawSmoothing(uTurn, s);
  assert.equal(turn.summary.flips, 0);
  assert.equal(turn.edits.length, 0, 'quay đều không cần sửa');
});

test('đồng bộ kích thước: bỏ qua keyframe outside, giữ đáy box, không đổi keyframe đã đúng cỡ', () => {
  const frames = [kf(0, [10, 0, -1], 0, [4.0, 1.8, 1.4]), kf(1, [11, 0, -1], 0, [4.5, 1.9, 1.6]), kf(2, [12, 0, -1], 0, [4.0, 1.8, 1.4], { outside: true })];
  const { edits } = Ops.planSizeSync(frames, [4.5, 1.9, 1.6]);
  assert.deepEqual(edits.map((e) => e.frame), [0]);
  assert.ok(Math.abs(B.bottomZ(edits[0].box) - B.bottomZ(frames[0].box)) < 1e-9);
  // LiDAR ở gốc, phía sau xe: mặt đuôi (x nhỏ) giữ nguyên, xe dài thêm về phía trước.
  assert.ok(Math.abs((edits[0].box.center[0] - 2.25) - (10 - 2.0)) < 1e-9);
});

test('đồng bộ kích thước: trung vị của track toàn outside là không có', () => {
  assert.equal(Ops.medianDims([kf(0, [0, 0, 0], 0, undefined, { outside: true })]), null);
  assert.equal(Ops.medianDims([]), null);
});

test('hạ đáy: box có pitch / roll vẫn đặt đúng đáy lên mặt đất', () => {
  const tilted = { center: [10, 0, -0.5], dims: [4.5, 1.9, 1.6], rotation: [0.05, 0.08, 0.3] };
  assert.ok(Math.abs(B.bottomZ(Ops.snapToGround(tilted, GROUND)) - GROUND) < 1e-9);
});

// ------------------------------------------------------------------ điểm của vật

test('điểm của vật: không có điểm nào thì trả rỗng, không đo mặt', () => {
  const r = ObjectPoints.measure([], car, [], () => GROUND, [0, 0, 0]);
  assert.deepEqual([r.inside.length, r.outside.length, r.faces.length, r.insideAboveFloor], [0, 0, 0, 0]);
});

test('điểm của vật: LiDAR nằm trong box (box của xe thu) không lỗi, không đo mặt', () => {
  const pts = [];
  for (let x = -2; x <= 2; x += 0.2) for (let z = -1.5; z <= 0; z += 0.2) pts.push([x, 0.9, z]);
  const ego = box([0, 0, -0.5], [4.5, 1.9, 1.6]); // nóc ở +0,3 m: LiDAR (0, 0, 0) nằm trong box
  const r = ObjectPoints.measure(pts, ego, [], () => GROUND, [0, 0, 0]);
  assert.deepEqual(r.faces, []);
});

test('điểm của vật: 60 000 điểm quanh box đo xong dưới 300 ms', () => {
  const pts = [];
  for (let i = 0; i < 60000; i += 1) pts.push([7.5 + Math.random() * 5, -1.2 + Math.random() * 2.4, GROUND + Math.random() * 2]);
  const t0 = performance.now();
  ObjectPoints.measure(pts, car, [], () => GROUND, [0, 0, 0]);
  assert.ok(performance.now() - t0 < 300, `${Math.round(performance.now() - t0)} ms`);
});

// ------------------------------------------------------------------ tô màu point cloud

const colorCloud = (n = 6) => ({ material: { vertexColors: true },
  geometry: { attributes: { color: { array: new Float32Array(3 * n).fill(0.5), needsUpdate: false } } } });

test('tô màu: cùng số điểm và cùng điểm đầu / cuối nhưng khác điểm giữa vẫn tô lại đúng', () => {
  const c = colorCloud();
  Colors.highlight(c, [0, 1, 4], []);
  Colors.highlight(c, [0, 2, 4], []);
  const a = c.geometry.attributes.color.array;
  assert.equal(a[3], 0.5, 'điểm 1 trả màu gốc');
  assert.ok(a[7] > 0.7, 'điểm 2 tô xanh');
  Colors.clear();
});

test('tô màu: đổi frame (geometry mới) không ghi màu cũ vào cloud mới; bỏ chọn trả màu cloud mới', () => {
  const first = colorCloud(), second = colorCloud();
  Colors.highlight(first, [0], []);
  second.geometry.attributes.color.array[0] = 0.9;
  Colors.highlight(second, [1], []);
  assert.equal(second.geometry.attributes.color.array[0], Math.fround(0.9), 'không chép màu gốc của cloud cũ sang');
  Colors.clear();
  Colors.clear();
  assert.equal(second.geometry.attributes.color.array[3], 0.5);
});

// ------------------------------------------------------------------ người lái / người trong xe (spec 4.3B, 4.3C)

const rider = (rs, height) => ({ box: box([10, 0, GROUND + height / 2], [1.9, 0.8, height]), label: 'Two-wheels', classKey: `Two-wheels/${rs}`, clientId: 7 });
const person = (x, bottom = GROUND, height = 1.7) => ({ box: box([x, 0, bottom + height / 2], [0.6, 0.6, height]), label: 'Pedestrian', classKey: 'Pedestrian/adult', clientId: 5 });
const rules = (target, others = []) => Checks.checkBox({ ...baseInput(), ...target, attributes: {}, others, clientId: target.clientId }, g).map((i) => i.rule);

test('spec: ghi with_rider mà box không gồm người (1,1 m), hoặc without_rider mà box gồm người (1,75 m), đều bị báo', () => {
  assert.ok(rules(rider('with_rider', 1.1)).includes('size.class_range'));
  assert.ok(rules(rider('without_rider', 1.75)).includes('size.class_range'));
  assert.ok(!rules(rider('with_rider', 1.75)).includes('size.class_range'));
  assert.ok(!rules(rider('without_rider', 1.1)).includes('size.class_range'));
});

test('spec: xe có người lái mà người lái còn box riêng thì báo ở cả hai box; người dắt xe không người thì được chồng', () => {
  assert.ok(rules(rider('with_rider', 1.75), [person(10.1)]).includes('spec.rider_double'));
  assert.ok(rules(person(10.1), [rider('with_rider', 1.75)]).includes('spec.rider_double'));
  const walking = rules(rider('without_rider', 1.1), [person(10.9)]);
  assert.ok(!walking.includes('spec.rider_double') && walking.includes('overlap.allowed'));
});

test('spec: người trong xe con bị báo; người đứng trên thùng xe tải (đáy cao hơn 0,6 m) thì không', () => {
  const car = { box: box([10, 0, GROUND + 0.8], [4.5, 1.9, 1.6]), label: 'Vehicle', classKey: 'Vehicle/car', clientId: 9 };
  assert.ok(rules(person(10.3, GROUND, 1.2), [car]).includes('spec.inside'));
  const truck = { box: box([10, 0, GROUND + 0.6], [6, 2.3, 1.2]), label: 'Vehicle', classKey: 'Vehicle/truck', clientId: 9 };
  assert.ok(!rules(person(10, GROUND + 1.2), [truck]).includes('spec.inside'));
});
