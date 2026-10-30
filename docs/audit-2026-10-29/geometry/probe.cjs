'use strict';
/* Probe kiểm toán: xác nhận lỗi ở e845e7d. Không sửa code sản phẩm, không cần CVAT hoặc dữ liệu thật.
 * Assertion cố ý xác nhận hành vi lỗi hiện hữu; exit 0 nghĩa là đã tái hiện lỗi, KHÔNG phải sản phẩm đạt.
 * Chạy từ bất kỳ thư mục: node docs/audit-2026-10-29/geometry/probe.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const src = path.join(root, 'extension/src/annotator');
const B = require(path.join(src, 'box.js'));
const Ops = require(path.join(src, 'track-ops.js'));
const Grid = require(path.join(src, 'spatial-grid.js'));
const G = require(path.join(src, 'guideline.js'));
const Measure = require(path.join(src, 'measure.js'));
const findings = [];
const record = (id, expected, actual) => findings.push({ id, expected, actual });
const box = (extra = {}) => ({ center: [10, 0, 2], rotation: [0, 0, 0], dims: [4.5, 2, 1.5], ...extra });

function adapter() {
  const c = vm.createContext({ PointSnapBox: B });
  vm.runInContext(fs.readFileSync(path.join(src, 'cvat-adapter.js'), 'utf8'), c);
  return c.PointSnapCvatAdapter;
}

async function partialSave() {
  const A = adapter(), persisted = new Map(), freeze = [];
  const old = B.toCvatPoints(box());
  const states = [0, 1, 2].map((frame) => ({ frame, clientID: 7, points: old.slice(), keyframe: true,
    async save() { if (frame === 1) throw new Error('Lỗi lưu frame 1 được cài có chủ đích'); persisted.set(frame, this.points.slice()); } }));
  const job = { annotations: {}, actions: { async freeze(v) { freeze.push(v); } } };
  let returned = null, error;
  try {
    returned = await A.applyEdits(job, new Map(states.map((s) => [s.frame, { state: s }])),
      states.map((s) => ({ frame: s.frame, box: box({ center: [11, 0, 2] }) })));
  } catch (e) { error = e.message; }
  assert.match(error, /frame 1/);
  assert.deepEqual([...persisted.keys()], [0]);
  assert.equal(returned, null);
  assert.deepEqual(freeze, [true, false]);
  record('GEO-01', 'Thất bại giữa batch phải rollback phần đã ghi, hoặc trả journal có thể Undo cả phần đã ghi.',
    { persistedFrames: [...persisted.keys()], undoRecordReturned: returned !== null, historyFrozenDuringSave: freeze, error });

  // Control: thành công thì caller có record để Undo và restore được cả nhóm.
  const ok = [0, 1, 2].map((frame) => ({ frame, clientID: 8, points: old.slice(), keyframe: true, async save() {} }));
  const goodJob = { annotations: { async get(frame) { return [ok[frame]]; } }, actions: { async freeze() {} } };
  const result = await A.applyEdits(goodJob, new Map(ok.map((s) => [s.frame, { state: s }])),
    ok.map((s) => ({ frame: s.frame, box: box({ center: [11, 0, 2] }) })));
  assert.equal(result.record.length, 3);
  assert.equal((await A.undoEdits(goodJob, result.record)).restored, 3);
  for (const s of ok) assert.deepEqual(s.points, old);
}

function tiltedSize() {
  const before = box({ rotation: [0, Math.PI / 6, 0], dims: [4, 2, 2], center: [10, 0, 3] });
  const after = Ops.planSizeSync([{ frame: 0, box: before, outside: false }], [6, 2, 2]).edits[0].box;
  const drift = B.bottomZ(after) - B.bottomZ(before);
  assert.ok(Math.abs(drift + 1) < 1e-9);
  const upright = box({ dims: [4, 2, 2], center: [10, 0, 3] });
  const uprightAfter = Ops.planSizeSync([{ frame: 0, box: upright }], [6, 2, 2]).edits[0].box;
  assert.ok(Math.abs(B.bottomZ(uprightAfter) - B.bottomZ(upright)) < 1e-9);
  record('GEO-02', 'Đồng bộ kích thước giữ đáy theo mô tả, hoặc từ chối box roll/pitch chưa hỗ trợ.',
    { pitchDeg: 30, dimsBefore: before.dims, dimsAfter: after.dims, bottomBeforeM: B.bottomZ(before), bottomAfterM: B.bottomZ(after), driftM: drift });
}

function tiltedGrid() {
  const b = box({ center: [0, 0, 0], rotation: [0, Math.PI / 2, 0], dims: [1, 1, 10] });
  const p = [3, 0, 0], local = B.toLocal(b, p);
  assert.ok(local.every((v, i) => Math.abs(v) < b.dims[i] / 2));
  const indices = Grid.pointsNearBox(Grid.build(new Float32Array(p)), b, 0.5);
  assert.equal(indices.length, 0);
  record('GEO-03', 'Truy vấn ứng viên phải chứa mọi điểm thực sự trong OBB nếu chấp nhận roll/pitch.',
    { point: p, localPoint: local, actuallyInside: true, candidates: indices });
}

function controller() {
  let frames = [], cloud = new Float32Array([0, 0, 0]);
  const A = { activeClientId: () => 7, frameStates: () => frames,
    liveBox: (_, s) => B.fromCvatPoints(s.points), attributesOf: (s) => s.attributes,
    pointCloud: () => cloud, connect() {} };
  const c = vm.createContext({ PointSnapCvatAdapter: A, PointSnapBox: B, PointSnapGuideline: G,
    PointSnapAnnotatorPanel: {}, PointSnapMeasure: Measure,
    window: { addEventListener() {}, postMessage() {} }, location: { origin: 'http://localhost' } });
  // Chỉ thêm export test cho closure hiện hữu; các hàm/cache là nguyên văn production.
  const source = fs.readFileSync(path.join(src, 'annotator.js'), 'utf8')
    .replace('root.PointSnapAnnotator = { state: S, health };', 'root.PointSnapAnnotator = { state: S, health, measureActive, frameData };');
  vm.runInContext(source, c);
  return { ...c.PointSnapAnnotator, setFrames(v) { frames = v; }, setCloud(v) { cloud = v; } };
}

function staleMeasure() {
  const C = controller(), b = box();
  let selected = { clientID: 7, points: B.toCvatPoints(b), label: { name: 'car' }, attributes: {}, occluded: false };
  C.setFrames([selected]);
  const frame = { ...Measure.buildFrame(new Float32Array([0, 0, 0]), [b], G.DEFAULT_GUIDELINE), key: 'job:0:1' };
  const ctx = { frame: 0 };
  const first = C.measureActive(ctx, frame);
  assert.equal(first.label, 'car');
  selected = { ...selected, label: { name: 'pedestrian' } };
  C.setFrames([selected]);
  const cached = C.measureActive(ctx, frame);
  const fresh = Measure.measureBox(frame, { box: b, label: 'pedestrian', attributes: {}, clientId: 7 }, [], null, G.DEFAULT_GUIDELINE);
  assert.equal(cached.label, 'car');
  assert.equal(cached.issues.some((i) => i.rule === 'size.class_range'), false);
  assert.equal(fresh.issues.some((i) => i.rule === 'size.class_range'), true);
  record('GEO-04a', 'Đổi class phải tính lại checklist ngay, kể cả không đổi hình học/thuộc tính.',
    { labelOnCVAT: selected.label.name, labelInCachedMeasurement: cached.label, cachedSizeError: false, freshSizeError: true });

  C.state.measureKey = '';
  C.setFrames([{ ...selected, label: { name: 'car' } }]);
  C.state.track = { clientID: 7, loading: false, keyframes: [0, 1, 2].map((f) => ({ frame: f, box: b, outside: false })) };
  C.measureActive(ctx, frame);
  C.state.track = { ...C.state.track, keyframes: [0, 1, 2].map((f) => ({ frame: f, box: f === 0 ? b : box({ dims: [8, 2, 1.5] }), outside: false })) };
  const cachedTrack = C.measureActive(ctx, frame);
  const freshTrack = Measure.measureBox(frame, { box: b, label: 'car', attributes: {}, clientId: 7 }, [], [[8, 2, 1.5], [8, 2, 1.5]], G.DEFAULT_GUIDELINE);
  assert.equal(cachedTrack.issues.some((i) => i.rule === 'size.in_track'), false);
  assert.equal(freshTrack.issues.some((i) => i.rule === 'size.in_track'), true);
  record('GEO-04b', 'Sau reload track phải tính lại theo nội dung keyframe, không chỉ theo số lượng.',
    { keyframeCount: 3, cachedTrackSizeError: false, freshTrackSizeError: true });
}

function staleTerrain() {
  const C = controller(), points = [];
  for (let x = -2; x <= 2; x += 0.1) for (let y = -2; y <= 2; y += 0.1) points.push(x, y, 0);
  const cloud = new Float32Array(points);
  C.setCloud(cloud); C.setFrames([]);
  const ctx = { job: { id: 1 }, frame: 0 };
  const before = C.frameData(ctx);
  assert.equal(before.terrain.available, true);
  const b = box({ center: [0, 0, 0.5], dims: [20, 20, 3] });
  C.setFrames([{ points: B.toCvatPoints(b), outside: false }]);
  const cached = C.frameData(ctx);
  const fresh = Measure.buildFrame(cloud, [b], G.DEFAULT_GUIDELINE);
  assert.equal(cached.terrain.available, true);
  assert.equal(fresh.terrain.available, false);
  record('GEO-05', 'Đổi box dùng để loại điểm phải invalidation terrain, hoặc báo số đo tạm cũ đến khi rebuild.',
    { sameFrameSameCloud: true, cachedGroundCells: cached.terrain.groundCellCount, recomputedGroundCells: fresh.terrain.groundCellCount });
}

(async () => {
  await partialSave(); tiltedSize(); tiltedGrid(); staleMeasure(); staleTerrain();
  console.log(JSON.stringify({ baseline: 'e845e7d', meaning: 'Assertions xác nhận lỗi tái hiện, không phải test nghiệm thu sản phẩm', findings }, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; });
