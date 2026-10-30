'use strict';

/* Nghiệm thu các lỗi của review 30/10/2026 (docs/review-extension-2026-10-30/REVIEW.md). Module production chạy trong VM
 * với CVAT giả, không cần trình duyệt / CVAT thật. Mỗi test kiểm hành vi đúng (ngược với probe review chỉ tái hiện lỗi). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('../src/annotator/box.js');
const G = require('../src/annotator/guideline.js');
const Ops = require('../src/annotator/track-ops.js');
const Grid = require('../src/annotator/spatial-grid.js');
const Terrain = require('../src/annotator/terrain.js');
const Measure = require('../src/annotator/measure.js');

const SRC = path.join(__dirname, '..', 'src', 'annotator');
const DEG = Math.PI / 180;
const box = (extra = {}) => ({ center: [10, 0, 2], rotation: [0, 0, 0], dims: [4.5, 2, 1.5], ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
// Mảng tạo trong VM khác realm: so bằng JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ adapter (cvat-adapter.js)

function loadAdapter(extra = {}) {
  const c = vm.createContext({ PointSnapBox: B, ...extra });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'cvat-adapter.js'), 'utf8'), c);
  return c.PointSnapCvatAdapter;
}

/** CVAT giả: mỗi frame một ObjectState; `save()` lưu points hiện tại, `failSave(frame, points)` quyết định frame nào lỗi. */
function fakeJob(failSave) {
  const persisted = new Map(), old = B.toCvatPoints(box());
  const states = [0, 1, 2].map((frame) => ({
    frame, clientID: 7, points: old.slice(), keyframe: true, attributes: {},
    async save() {
      if (failSave(frame, this.points)) throw new Error(`lỗi lưu frame ${frame}`);
      persisted.set(frame, this.points.slice());
    },
  }));
  const job = { annotations: { async get(frame) { return [states[frame]]; } }, actions: { async freeze() {} } };
  return { job, states, persisted, old, byFrame: new Map(states.map((s) => [s.frame, { state: s }])) };
}

test('[P1] ghi batch lỗi giữa chừng: trả lại frame đã lưu, không để thay đổi mồ côi', async () => {
  const A = loadAdapter();
  const { job, byFrame, persisted, old } = fakeJob((frame) => frame === 1);
  const edits = [0, 1, 2].map((frame) => ({ frame, box: box({ center: [11, 0, 2] }) }));
  const error = await A.applyEdits(job, byFrame, edits).catch((e) => e);
  assert.match(error.message, /lỗi lưu frame 1/);
  assert.match(error.message, /đã trả lại 1 keyframe/);
  assert.equal(error.record.length, 0);
  assert.deepEqual(persisted.get(0), old, 'frame 0 đã lưu được trả về như trước');
});

test('[P1] ghi batch lỗi mà trả lại cũng lỗi: lỗi mang bản ghi Hoàn tác của phần còn đổi', async () => {
  const A = loadAdapter();
  const old = B.toCvatPoints(box());
  // Frame 1 luôn lỗi; frame 0 lưu được lần đầu nhưng lỗi khi trả về điểm cũ.
  const { job, byFrame } = fakeJob((frame, points) => frame === 1 || (frame === 0 && points.every((v, i) => v === old[i])));
  const edits = [0, 1, 2].map((frame) => ({ frame, box: box({ center: [11, 0, 2] }) }));
  const error = await A.applyEdits(job, byFrame, edits).catch((e) => e);
  assert.match(error.message, /1 keyframe đã ghi mà chưa trả lại được/);
  assert.equal(error.record.length, 1);
  assert.equal(error.record[0].frame, 0);
  assert.deepEqual(plain(error.record[0].before.points), old);
});

test('[P1] ghi batch thành công mà vẽ lại / đọc lại lỗi: vẫn trả bản ghi Hoàn tác', async () => {
  const A = loadAdapter();
  const { job, byFrame } = fakeJob(() => false);
  job.annotations.get = async () => { throw new Error('đọc lại lỗi'); };
  const result = await A.applyEdits(job, byFrame, [{ frame: 0, box: box({ center: [11, 0, 2] }) }]);
  assert.equal(result.record.length, 1);
  assert.ok(result.record[0].after.points.length);
});

/** Store CVAT giả với một job 3D đang mở ở frame 0. */
function adapterWithStore(jobGet) {
  const dispatches = [], job = { id: 101, annotations: { get: jobGet }, actions: { get: async () => [] } };
  const dom = {}, views = {};
  for (const name of ['perspective', 'top', 'side', 'front']) {
    dom[name] = { getDrawnObjects() { return []; } };
    views[name] = { renderer: { domElement: dom[name] }, camera: { projectionMatrix: { elements: new Array(16) } } };
  }
  const annotation = { job: { instance: job }, canvas: { instance: { html: () => dom, view: { views } } },
    player: { frame: { number: 0, fetching: false } }, annotations: { states: [], filters: [] } };
  const store = { getState: () => ({ annotation, settings: { workspace: {} } }), dispatch(action) { dispatches.push(action); } };
  const A = loadAdapter({ cvatUI: { registerComponent(fn) { fn({ store }); } } });
  A.connect(() => {});
  return { A, annotation, views, dispatches, job };
}

test('[P2] vẽ lại: đổi frame trong lúc chờ thì bỏ nhãn của frame cũ; hai lần vẽ lại về ngược thứ tự thì giữ lần mới', async () => {
  const pending = deferred();
  const { A, annotation, dispatches } = adapterWithStore(() => pending.promise);
  const refreshing = A.refresh();
  annotation.player.frame.number = 1;
  pending.resolve([{ frame: 0 }]);
  await refreshing;
  assert.equal(dispatches.length, 0);

  const answers = [deferred(), deferred()];
  let call = 0;
  const two = adapterWithStore(() => answers[call++].promise);
  const older = two.A.refresh(), newer = two.A.refresh();
  answers[1].resolve([{ frame: 0, gen: 'mới' }]);
  await newer;
  answers[0].resolve([{ frame: 0, gen: 'cũ' }]);
  await older;
  assert.deepEqual(two.dispatches.map((d) => d.payload.states[0].gen), ['mới']);
});

test('[P2] point cloud: không dùng cloud đang vẽ của job khác dù cùng số frame', async () => {
  const { A, annotation, views, job } = adapterWithStore(async () => []);
  const cloudOfJobB = new Float32Array([202, 0, 0]);
  views.perspective.scene = { children: [{ isPoints: true, geometry: { attributes: { position: { array: cloudOfJobB } } } }] };
  annotation.job.instance = { id: 202, annotations: job.annotations, actions: job.actions };
  // Job 101 không còn đang mở: phải đọc gói frame của job 101 (ở đây thiếu zip.js nên báo lỗi), không trả cloud job 202.
  await assert.rejects(A.frameCloud({ job }, 0));
  annotation.job.instance = job;
  assert.equal(await A.frameCloud({ job }, 0), cloudOfJobB, 'cùng job, cùng frame thì vẫn dùng cloud đang vẽ');
});

// ------------------------------------------------------------------ controller (annotator.js)

/** Controller trong VM với adapter giả; xuất thêm hàm nội bộ để test, mã còn lại nguyên văn production. */
function loadController(A) {
  const c = vm.createContext({ PointSnapCvatAdapter: { connect() {}, ...A }, PointSnapBox: B, PointSnapGuideline: G,
    PointSnapTrackOps: Ops, PointSnapTerrain: Terrain, PointSnapGrid: Grid, PointSnapMeasure: Measure, PointSnapAnnotatorPanel: {},
    performance, window: { addEventListener() {}, postMessage() {} }, location: { origin: 'http://localhost' } });
  const source = fs.readFileSync(path.join(SRC, 'annotator.js'), 'utf8').replace(
    'root.PointSnapAnnotator = { state: S, health };',
    'root.PointSnapAnnotator = { state: S, health, onJobChanged, preparePlan, applyPlan, measureActive, frameData };');
  vm.runInContext(source, c);
  return c.PointSnapAnnotator;
}

test('[P1] bản xem trước của job cũ về muộn: không dựng lại, không ghi vào job mới cùng clientID', async () => {
  const pending = deferred(), writes = [];
  const jobA = { id: 101 }, jobB = { id: 202 }, small = box({ dims: [4, 2, 2] }), wide = box({ dims: [6, 2, 2] });
  let selected = { clientID: 7, objectType: 'track', points: B.toCvatPoints(wide) };
  const keyframes = [small, wide].map((b, frame) => ({ frame, box: b, outside: false, state: { ...selected, frame, points: B.toCvatPoints(b) } }));
  const C = loadController({
    activeClientId: () => selected.clientID,
    frameStates: () => [selected],
    context: () => ({ job: jobB, frame: 0 }),
    trackKeyframes: (job) => (job.id === jobA.id ? pending.promise : Promise.resolve(keyframes)),
    async applyEdits(job, byFrame, edits) { writes.push(job.id); return { saved: edits.length, locked: 0, undo: 'pointsnap', record: [] }; },
  });
  C.onJobChanged(jobA.id, null);
  const preparing = C.preparePlan({ job: jobA, frame: 1 }, 'sync-size', { dims: [6, 2, 2], source: 'current' });
  selected = { ...selected, points: B.toCvatPoints(small) };
  C.onJobChanged(jobB.id, null);
  pending.resolve(keyframes);
  await preparing;
  assert.equal(C.state.plan, null);
  await C.applyPlan({ job: jobB, frame: 0 });
  assert.deepEqual(writes, []);
});

test('[P1] áp dụng bản xem trước: job đổi trong lúc đọc track thì không ghi', async () => {
  const writes = [], jobA = { id: 101 };
  let current = jobA;
  const b = box({ dims: [4, 2, 2] }), selected = { clientID: 7, objectType: 'track', points: B.toCvatPoints(b) };
  const keyframes = [0, 1].map((frame) => ({ frame, box: b, outside: false, state: { ...selected, frame } }));
  let gate = null;
  const C = loadController({
    activeClientId: () => 7, frameStates: () => [selected], context: () => ({ job: current, frame: 0 }),
    trackKeyframes: () => (gate ? gate.promise : Promise.resolve(keyframes)),
    async applyEdits(job) { writes.push(job.id); return { saved: 1, locked: 0, undo: 'pointsnap', record: [] }; },
  });
  C.onJobChanged(jobA.id, null);
  await C.preparePlan({ job: jobA, frame: 0 }, 'sync-size', { dims: [6, 2, 2], source: 'current' });
  assert.ok(C.state.plan && C.state.plan.jobId === jobA.id);
  gate = deferred();
  const applying = C.applyPlan({ job: jobA, frame: 0 });
  current = { id: 202 };
  C.onJobChanged(202, null);
  gate.resolve(keyframes);
  await applying;
  assert.deepEqual(writes, []);
});

test('[P1] checklist tính lại khi đổi class, và khi sửa nội dung keyframe khác dù giữ nguyên số keyframe', () => {
  let frames = [];
  const C = loadController({
    activeClientId: () => 7, frameStates: () => frames,
    liveBox: (_, s) => B.fromCvatPoints(s.points), attributesOf: (s) => s.attributes,
  });
  const b = box();
  const cache = { ...Measure.buildFrame(new Float32Array([0, 0, 0]), [b], G.DEFAULT_GUIDELINE), key: 'job:0:1', boxesKey: '' };
  const ctx = { frame: 0 };
  frames = [{ clientID: 7, points: B.toCvatPoints(b), label: { name: 'car' }, attributes: {}, occluded: false }];
  assert.equal(C.measureActive(ctx, cache).label, 'car');
  frames = [{ ...frames[0], label: { name: 'pedestrian' } }];
  const relabeled = C.measureActive(ctx, cache);
  assert.equal(relabeled.label, 'pedestrian');
  assert.ok(relabeled.issues.some((i) => i.rule === 'size.class_range'), 'kích thước xe sai với pedestrian');

  frames = [{ ...frames[0], label: { name: 'car' } }];
  C.state.track = { clientID: 7, loading: false, keyframes: [0, 1, 2].map((f) => ({ frame: f, box: b, outside: false })) };
  assert.equal(C.measureActive(ctx, cache).issues.some((i) => i.rule === 'size.in_track'), false);
  C.state.track = { ...C.state.track, keyframes: [0, 1, 2].map((f) => ({ frame: f, box: f === 0 ? b : box({ dims: [8, 2, 1.5] }), outside: false })) };
  assert.ok(C.measureActive(ctx, cache).issues.some((i) => i.rule === 'size.in_track'));
});

test('[P2] bản đồ mặt đất dựng lại khi box cùng frame đổi, khớp với một lần dựng mới', () => {
  let frames = [];
  const points = [];
  for (let x = -2; x <= 2; x += 0.1) for (let y = -2; y <= 2; y += 0.1) points.push(x, y, 0);
  const cloud = new Float32Array(points);
  const C = loadController({ activeClientId: () => null, frameStates: () => frames, pointCloud: () => cloud });
  const ctx = { job: { id: 1 }, frame: 0 };
  assert.equal(C.frameData(ctx).terrain.available, true);
  const big = box({ center: [0, 0, 0.5], dims: [20, 20, 3] });
  frames = [{ points: B.toCvatPoints(big), outside: false }];
  const cached = C.frameData(ctx);
  const fresh = Measure.buildFrame(cloud, [big], G.DEFAULT_GUIDELINE);
  assert.equal(cached.terrain.available, fresh.terrain.available);
  assert.equal(cached.terrain.groundCellCount, fresh.terrain.groundCellCount);
  // Box chuyển outside: điểm lại thành mặt đất.
  frames = [{ points: B.toCvatPoints(big), outside: true }];
  assert.equal(C.frameData(ctx).terrain.available, true);
});

// ------------------------------------------------------------------ hình học (track-ops.js, spatial-grid.js)

test('[P1] đồng bộ kích thước giữ đáy box có pitch / roll (dương, âm, nhỏ) trong 1 mm', () => {
  for (const rotation of [[0, 30 * DEG, 0], [0, -30 * DEG, 0], [15 * DEG, 0, 0], [-15 * DEG, 0, 40 * DEG], [0, 3 * DEG, 0], [2 * DEG, -4 * DEG, 120 * DEG]]) {
    const before = box({ rotation, dims: [4, 2, 2], center: [10, 0, 3] });
    const after = Ops.planSizeSync([{ frame: 0, box: before, outside: false }], [6, 2.2, 1.8]).edits[0].box;
    assert.ok(Math.abs(B.bottomZ(after) - B.bottomZ(before)) < 1e-3, `rotation ${rotation.map((r) => Math.round(r / DEG))}°`);
    assert.deepEqual(after.dims, [6, 2.2, 1.8]);
  }
});

test('[P2] truy vấn điểm quanh box nghiêng chứa mọi điểm thật nằm trong box', () => {
  const tilted = box({ center: [0, 0, 0], rotation: [0, Math.PI / 2, 0], dims: [1, 1, 10] });
  assert.equal(Grid.pointsNearBox(Grid.build(new Float32Array([3, 0, 0])), tilted, 0.5).length, 1);
  // Lấy mẫu điểm trong box với nhiều độ nghiêng: mọi điểm phải có trong tập ứng viên.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const rotation of [[0, 20 * DEG, 0], [0, -60 * DEG, 30 * DEG], [45 * DEG, 10 * DEG, -90 * DEG], [-5 * DEG, 0, 0]]) {
    const b = box({ center: [5, -3, 1], rotation, dims: [4, 2, 1.6] });
    const inside = Array.from({ length: 200 }, () => B.toWorld(b, b.dims.map((d) => (rand() - 0.5) * d * 0.98)));
    const found = Grid.pointsNearBox(Grid.build(new Float32Array(inside.flat())), b, 0);
    assert.equal(found.length, inside.length, `rotation ${rotation.map((r) => Math.round(r / DEG))}°`);
  }
});
