'use strict';
// Probe review: assertion xác nhận lỗi hiện tại, không phải test nghiệm thu.
// Chỉ chạy module trong VM với CVAT giả; không ghi nhãn hoặc truy cập mạng.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const B = require('../../extension/src/annotator/box.js');
const G = require('../../extension/src/annotator/guideline.js');
const Ops = require('../../extension/src/annotator/track-ops.js');
const src = path.resolve(__dirname, '../../extension/src/annotator');
const findings = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const box = { center: [10, 0, 2], rotation: [0, 0, 0], dims: [4, 2, 2] };

async function stalePreview() {
  const pending = deferred(), writes = [];
  const jobA = { id: 101 }, jobB = { id: 202 };
  const wide = { ...box, dims: [6, 2, 2] };
  let selected = { clientID: 7, objectType: 'track', points: B.toCvatPoints(wide) };
  const keyframes = [box, wide].map((b, frame) => ({ frame, box: b,
    state: { ...selected, frame, points: B.toCvatPoints(b) } }));
  const A = {
    connect() {},
    activeClientId: () => selected.clientID,
    frameStates: () => [selected],
    trackKeyframes: (job) => job.id === jobA.id ? pending.promise : Promise.resolve(keyframes),
    async applyEdits(job, byFrame, edits) {
      writes.push({ jobId: job.id, frames: edits.map((e) => e.frame), dims: edits[0].box.dims });
      return { saved: edits.length, locked: 0, undo: 'pointsnap', record: [] };
    },
  };
  const c = vm.createContext({ PointSnapCvatAdapter: A, PointSnapBox: B, PointSnapGuideline: G,
    PointSnapTrackOps: Ops, PointSnapAnnotatorPanel: {}, PointSnapMeasure: {}, performance,
    window: { addEventListener() {}, postMessage() {} }, location: { origin: 'http://localhost' } });
  const source = fs.readFileSync(path.join(src, 'annotator.js'), 'utf8').replace(
    'root.PointSnapAnnotator = { state: S, health };',
    'root.PointSnapAnnotator = { state: S, health, onJobChanged, preparePlan, applyPlan };');
  vm.runInContext(source, c);
  const C = c.PointSnapAnnotator;
  C.onJobChanged(jobA.id, null);
  const preparing = C.preparePlan({ job: jobA, frame: 1 }, 'sync-size', { dims: [6, 2, 2], source: 'current' });
  // Đổi job trước khi API đọc keyframe của job A trả kết quả.
  selected = { ...selected, points: B.toCvatPoints(box) }; // Job B đang mở frame 0, clientID được dùng lại.
  C.onJobChanged(jobB.id, null);
  assert.equal(C.state.plan, null);
  pending.resolve(keyframes);
  await preparing;
  assert.equal(C.state.jobId, jobB.id);
  assert.ok(C.state.plan, 'Promise của job cũ dựng lại plan sau khi reset');
  await C.applyPlan({ job: jobB, frame: 0 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].jobId, jobB.id);
  assert.deepEqual(writes[0].dims, [6, 2, 2]);
  findings.push({ id: 'ASYNC-01', expected: 'Kết quả preparePlan của job cũ bị hủy; không được áp vào job mới.',
    actual: { previewRequestedForJob: jobA.id, activeJob: C.state.jobId, writes } });
}

function adapterFixture() {
  const pending = deferred(), dispatches = [];
  const job = { id: 101, annotations: { get: () => pending.promise }, actions: { get: async () => [] } };
  const dom = {}, views = {};
  for (const name of ['perspective', 'top', 'side', 'front']) {
    dom[name] = { getDrawnObjects() { return []; } };
    views[name] = { renderer: { domElement: dom[name] }, camera: { projectionMatrix: { elements: new Array(16) } } };
  }
  const annotation = { job: { instance: job }, canvas: { instance: { html: () => dom, view: { views } } },
    player: { frame: { number: 0, fetching: false } }, annotations: { states: [], filters: [] } };
  const store = { getState: () => ({ annotation, settings: { workspace: {} } }), dispatch(action) { dispatches.push(action); } };
  const c = vm.createContext({ PointSnapBox: B, cvatUI: { registerComponent(fn) { fn({ store }); } } });
  vm.runInContext(fs.readFileSync(path.join(src, 'cvat-adapter.js'), 'utf8'), c);
  c.PointSnapCvatAdapter.connect(() => {});
  return { A: c.PointSnapCvatAdapter, annotation, views, pending, dispatches, job };
}

async function staleRefresh() {
  const { A, annotation, pending, dispatches } = adapterFixture();
  const refreshing = A.refresh();
  annotation.player.frame.number = 1;
  pending.resolve([{ frame: 0, clientID: 7 }]);
  await refreshing;
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].payload.states[0].frame, 0);
  assert.equal(annotation.player.frame.number, 1);
  findings.push({ id: 'ASYNC-02', expected: 'refresh bỏ kết quả nếu job/frame đang mở đã đổi sau await.',
    actual: { playerFrame: annotation.player.frame.number, dispatchedStateFrame: dispatches[0].payload.states[0].frame } });
}

async function wrongJobCloud() {
  const { A, annotation, views, job } = adapterFixture();
  const cloudB = new Float32Array([202, 0, 0]);
  views.perspective.scene = { children: [{ isPoints: true, geometry: { attributes: { position: { array: cloudB } } } }] };
  annotation.job.instance = { id: 202 };
  const result = await A.frameCloud({ job }, 0);
  assert.equal(result, cloudB);
  findings.push({ id: 'ASYNC-03', expected: 'frameCloud chỉ dùng cloud đang vẽ khi cả job và frame trùng yêu cầu.',
    actual: { requestedJobId: job.id, activeJobId: annotation.job.instance.id, returnedCloud: [...result] } });
}

(async () => {
  await stalePreview();
  await staleRefresh();
  await wrongJobCloud();
  console.log(JSON.stringify({ meaning: 'Assertions xác nhận lỗi tái hiện; không phải test nghiệm thu sản phẩm', findings }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
