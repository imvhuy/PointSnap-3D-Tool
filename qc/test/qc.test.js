'use strict';
/* Test các phần của dịch vụ QC: đọc zip / PCD, dựng box từng frame như CVAT, quét một job giả, bảo vệ lệnh ghi. */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readZip } = require('../lib/zip');
const { parsePcd } = require('../lib/pcd');
const Tracks = require('../lib/tracks');
const { scanJob } = require('../lib/scan');
const TrackRules = require('../lib/trackrules');
const Rules = require('../lib/rules');
const { Store } = require('../lib/store');
const { toCsv, cvatLink } = require('../lib/export');
const G = require('../../extension/src/annotator/guideline.js');

/** Zip tối giản (stored hoặc deflate) để thử bộ đọc. */
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of files) {
    const body = deflate ? zlib.deflateRawSync(data) : data, n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body); centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function binaryPcd(points) {
  const head = `VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA binary\n`;
  const body = Buffer.alloc(points.length * 16);
  points.forEach(([x, y, z], i) => { body.writeFloatLE(x, i * 16); body.writeFloatLE(y, i * 16 + 4); body.writeFloatLE(z, i * 16 + 8); });
  return Buffer.concat([Buffer.from(head), body]);
}

test('zip: đọc file stored và deflate theo thứ tự', () => {
  const zip = makeZip([{ name: '000000.pcd', data: Buffer.from('a') }, { name: '000001.pcd', data: Buffer.from('bb'.repeat(50)), deflate: true }]);
  const files = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['000000.pcd', '000001.pcd']);
  assert.equal(files[1].data.toString(), 'bb'.repeat(50));
  assert.throws(() => readZip(Buffer.from('không phải zip')));
});

test('zip của extension: đọc mục lục giống bản QC, trả dữ liệu thô và kiểu nén', () => {
  const Zip = require('../../extension/src/annotator/zip.js');
  const zip = makeZip([{ name: 'a/', data: Buffer.alloc(0) }, { name: '000000.pcd', data: Buffer.from('a') }, { name: '000001.pcd', data: Buffer.from('bb'.repeat(50)), deflate: true }]);
  const files = Zip.entries(new Uint8Array(zip));
  assert.deepEqual(files.map((f) => [f.name, f.method]), [['000000.pcd', 0], ['000001.pcd', 8]]);
  assert.equal(Buffer.from(files[0].raw).toString(), 'a');
  assert.equal(zlib.inflateRawSync(files[1].raw).toString(), 'bb'.repeat(50));
  assert.throws(() => Zip.entries(new Uint8Array(Buffer.from('không phải zip'))));
});

test('pcd: binary, ascii và binary_compressed; bỏ điểm NaN', () => {
  assert.deepEqual([...parsePcd(binaryPcd([[1, 2, 3], [NaN, 0, 0], [4, 5, 6]]))], [1, 2, 3, 4, 5, 6]);
  const ascii = Buffer.from('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA ascii\n1 2 3\n4 5 nan\n');
  assert.deepEqual([...parsePcd(ascii)], [1, 2, 3]);
  // binary_compressed: dữ liệu theo cột, nén LZF chỉ gồm đoạn chữ (literal) ≤ 32 byte.
  const cols = Buffer.alloc(24);
  [1, 4, 2, 5, 3, 6].forEach((v, i) => cols.writeFloatLE(v, i * 4));
  const lzf = Buffer.concat([Buffer.from([23]), cols]);
  const sizes = Buffer.alloc(8); sizes.writeUInt32LE(lzf.length, 0); sizes.writeUInt32LE(cols.length, 4);
  const head = Buffer.from('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA binary_compressed\n');
  assert.deepEqual([...parsePcd(Buffer.concat([head, sizes, lzf]))], [1, 2, 3, 4, 5, 6]);
});

const LABELS = [{ id: 1, name: 'car', attributes: [{ id: 10, name: 'parked', default_value: 'false' }] }];
const cuboid = (x, yaw = 0, dims = [4.5, 1.9, 1.6], z = -1) => [x, 0, z, 0, 0, yaw, ...dims, 0, 0, 0, 0, 0, 0, 0];

test('tracks: nội suy giữa keyframe như CVAT (góc theo cung ngắn), giữ box sau keyframe cuối, outside thì biến mất', () => {
  const ann = { shapes: [], tracks: [{ id: 7, label_id: 1, attributes: [], shapes: [
    { frame: 0, type: 'cuboid', points: cuboid(0, 3.0), outside: false, attributes: [{ spec_id: 10, value: 'true' }] },
    { frame: 2, type: 'cuboid', points: cuboid(10, -3.0), outside: false, attributes: [] },
    { frame: 4, type: 'cuboid', points: cuboid(20), outside: true, attributes: [] },
    { frame: 6, type: 'cuboid', points: cuboid(30), outside: false, attributes: [] },
  ] }] };
  const { frames, tracks } = Tracks.expand(ann, LABELS, { start: 0, stop: 8 });
  const at = (f) => frames.get(f)?.[0];
  assert.equal(at(1).box.center[0], 5);
  assert.ok(Math.abs(Math.abs(at(1).box.rotation[2]) - Math.PI) < 0.01, 'qua ±180° theo cung ngắn, không quay qua 0');
  assert.equal(at(1).keyframe, false);
  assert.equal(at(3).box.center[0], 15, 'nội suy về phía keyframe outside');
  assert.equal(at(4), undefined);
  assert.equal(at(5), undefined);
  assert.equal(at(8).box.center[0], 30, 'giữ box của keyframe cuối tới hết job');
  assert.equal(at(1).attributes.parked, 'true', 'thuộc tính lấy từ keyframe phía trước');
  assert.equal(tracks.get('track:7').keyframes.length, 4);
  assert.equal(Tracks.expand({ tags: [{}], shapes: [{ id: 3, type: 'polygon' }], tracks: ann.tracks }, LABELS, { start: 0, stop: 8 }).cvatIds.get('track:7'), 3,
    'số CVAT hiện: đếm tag, shape rồi track theo thứ tự API');
});

/** Job giả: mặt đường phẳng z = -1.8, một xe đặt đúng, một xe lơ lửng 50 cm, một track có keyframe lật 180°. */
function fakeClient() {
  const ground = [];
  for (let x = -30; x <= 30; x += 0.25) for (let y = -15; y <= 15; y += 0.25) ground.push([x, y, -1.8]);
  const carPoints = (cx) => { const p = []; for (let x = -2; x <= 2; x += 0.2) for (let z = -1.6; z <= -0.4; z += 0.2) p.push([cx + x, -0.9, z]); return p; };
  const frame = () => binaryPcd([...ground, ...carPoints(10), ...carPoints(-12)]);
  const yaw = [0, 0, 0, Math.PI, 0, 0, 0];
  const annotations = { shapes: [
    { id: 1, frame: 0, label_id: 1, type: 'cuboid', points: cuboid(10, 0, [4.5, 1.9, 1.6], -1.0), attributes: [] },
    { id: 2, frame: 0, label_id: 1, type: 'cuboid', points: cuboid(-12, 0, [4.5, 1.9, 1.6], -0.5), attributes: [] },
  ], tracks: [{ id: 9, label_id: 1, attributes: [], shapes: yaw.map((r, f) => ({ frame: f, type: 'cuboid', outside: false,
    points: cuboid(25, r, [4.5, 1.9, 1.6], -1.0), attributes: [] })) }] };
  return {
    job: async () => ({ id: 5, task_id: 3, start_frame: 0, stop_frame: 6, stage: 'annotation', state: 'new' }),
    task: async () => ({ id: 3, name: 'Thử', project_id: null }),
    labels: async () => LABELS,
    annotations: async () => annotations,
    meta: async () => ({ chunk_size: 3, deleted_frames: [] }),
    chunk: async (_, index) => Array.from({ length: index === 2 ? 1 : 3 }, (__, i) => ({ name: `${i}.pcd`, positions: parsePcd(frame()) })),
  };
}

test('scan: quét đủ frame theo gói, bắt xe lơ lửng và keyframe lật, gộp theo object + luật, gate KHÔNG ĐẠT / CẦN XEM', async () => {
  const progress = [];
  const result = await scanJob({ client: fakeClient(), jobId: 5, guideline: G.DEFAULT_GUIDELINE, onProgress: (p) => progress.push(p) });
  assert.equal(result.summary.frames, 7);
  assert.equal(result.summary.boxes, 2 + 7);
  assert.deepEqual(result.coverage.framesWithoutPoints, []);
  const rules = (key) => result.findings.filter((f) => f.objKey === key).map((f) => f.rule);
  assert.ok(rules('shape:2').some((r) => r.startsWith('ground.')), `xe lơ lửng phải bị báo: ${rules('shape:2')}`);
  assert.ok(!rules('shape:1').some((r) => r.startsWith('ground.')), `xe đặt đúng không bị báo mặt đất: ${rules('shape:1')}`);
  const flip = result.findings.find((f) => f.objKey === 'track:9' && f.rule === 'heading.jump');
  assert.deepEqual(flip?.frames, [3], 'chỉ keyframe lật bị đánh dấu');
  assert.ok(['fail', 'review'].includes(result.summary.gate.verdict));
  assert.ok(progress.at(-1).done === 7);
  const csv = toCsv(result, { [flip.key]: { verdict: 'confirmed' } }, 'http://cvat');
  assert.match(csv, /heading\.jump.*Đúng.*http:\/\/cvat\/tasks\/3\/jobs\/5\?frame=3&type=track&serverID=9/);
});

test('scan: hai box chồng nhau là một mục theo cặp, không phải hai mục', async () => {
  const base = fakeClient(), ann = await base.annotations();
  const dup = { ...ann.shapes[0], id: 3, points: cuboid(10.5, 0, [4.5, 1.9, 1.6], -1.0) };
  const client = { ...base, annotations: async () => ({ ...ann, shapes: [...ann.shapes, dup] }) };
  const result = await scanJob({ client, jobId: 5, guideline: G.DEFAULT_GUIDELINE });
  const pairs = result.findings.filter((f) => f.rule === 'overlap');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, 'shape:1+shape:3|overlap');
  assert.deepEqual([pairs[0].cvatId, pairs[0].otherCvatId], [1, 3]);
  assert.doesNotMatch(cvatLink('http://cvat', result.job, pairs[0]), /serverID/, 'mục theo cặp không lọc một object');
});

test('scan: gói frame lỗi thì ghi vào coverage, không dừng cả job', async () => {
  const client = { ...fakeClient(), chunk: async (_, index) => { if (index === 1) throw new Error('CVAT 500'); return fakeClient().chunk(0, index); } };
  const result = await scanJob({ client, jobId: 5, guideline: G.DEFAULT_GUIDELINE });
  assert.deepEqual(result.coverage.framesWithoutPoints, [3, 4, 5]);
  assert.match(result.coverage.chunkErrors[0], /frame 3–5: CVAT 500/);
  // Mọi object đều có trong danh sách duyệt, kể cả box ở frame thiếu point cloud.
  assert.deepEqual(result.objects.map((o) => o.key).sort(), ['shape:1', 'shape:2', 'track:9']);
  assert.equal(result.objects.find((o) => o.key === 'track:9').noPoints, 3);
  assert.ok(result.objects.every((o) => /^[0-9a-f]{16}$/.test(o.fingerprint)));
});

test('server: lệnh ghi thiếu header riêng bị từ chối; file tĩnh không thoát khỏi thư mục public', async () => {
  process.env.QC_HOME = require('node:path').join(require('node:os').tmpdir(), `pointsnap-qc-test-${process.pid}`);
  process.env.CVAT_TOKEN = '';
  const { route } = require('../server');
  const call = (method, url, headers = {}) => new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader() {}, writeHead(s) { this.statusCode = s; }, end(body) { resolve({ status: this.statusCode, body: String(body) }); } };
    const req = { method, url, headers, [Symbol.asyncIterator]: async function* gen() {} };
    route(req, res);
  });
  assert.equal((await call('POST', '/api/jobs/1/scan')).status, 403);
  assert.equal((await call('GET', '/../server.js')).status, 404);
  assert.equal((await call('GET', '/')).status, 200);
  assert.match((await call('GET', '/api/status')).body, /CVAT_TOKEN/);
});

/** Track giả: xe chạy đều theo x, 1 m mỗi frame; `edit(points, frame)` để cài lỗi. */
function trackAnn(specs) {
  return { shapes: [], tracks: specs.map(({ id, x = 5, y = 0, frames = [0, 12], edit = () => {}, dx = 1 }) => ({ id, label_id: 1, attributes: [],
    shapes: Array.from({ length: frames[1] - frames[0] + 1 }, (_, i) => {
      const f = frames[0] + i, points = cuboid(x + f * dx, 0);
      points[1] = y;
      edit(points, f);
      return { frame: f, type: 'cuboid', outside: false, points, attributes: [] };
    }) })) };
}
const runTrackRules = (ann) => {
  const ex = Tracks.expand(ann, LABELS, { start: 0, stop: 20 });
  return TrackRules.trackRules({ ...ex, stop: 20 }, G.DEFAULT_GUIDELINE, Rules.QC_FULL_DEFAULTS).hits;
};
// Vật đứng yên rải quanh xe thu (như cảnh thật) để ước lượng chuyển động xe thu.
const statics = [[21, 40, 18], [22, -30, 25], [23, 60, -22], [24, -15, -35]].map(([id, x, y]) => ({ id, x, y, dx: 0, frames: [0, 20] }));

test('trackrules: bắt box lệch một frame, đổi ID, đứt track, vẽ hai lần; nhãn sạch không báo', () => {
  assert.deepEqual(runTrackRules(trackAnn([{ id: 1 }, { id: 2, y: 8 }, ...statics])), []);
  const jump = runTrackRules(trackAnn([{ id: 1, edit: (p, f) => { if (f === 6) p[1] += 2; } }, ...statics]));
  assert.deepEqual(jump.map((h) => [h.issue.rule, h.frame]), [['track.jump', 6]]);
  const swap = runTrackRules(trackAnn([{ id: 1, edit: (p, f) => { if (f >= 6) p[1] = 8; } }, { id: 2, y: 8, edit: (p, f) => { if (f >= 6) p[1] = 0; } }, ...statics]));
  assert.ok(swap.some((h) => h.issue.rule === 'track.swap' && h.frame === 6), JSON.stringify(swap.map((h) => h.issue.rule)));
  const ann = trackAnn([{ id: 1, frames: [0, 5] }, { id: 2, frames: [7, 12] }, ...statics]);
  ann.tracks[0].shapes.push({ ...ann.tracks[0].shapes[5], frame: 6, outside: true });
  assert.ok(runTrackRules(ann).some((h) => h.issue.rule === 'track.fragment' && h.issue.otherClientId === 'track:2'));
  const dup = runTrackRules(trackAnn([{ id: 1 }, { id: 2, y: 0.2 }, ...statics]));
  assert.ok(dup.some((h) => h.issue.rule === 'track.duplicate'));
});

test('trackrules: box lệch ngang 1,2 m vẫn bắt khi xe thu chạy nhanh; lệch dọc hướng đi được nới theo quãng đường', () => {
  // Xe thu chạy 8 m mỗi frame: trong toạ độ xe thu mọi vật đứng yên trôi −8 m mỗi frame (ngưỡng dọc thành 2,4 m).
  const fast = statics.map((s) => ({ ...s, dx: -8 }));
  const parked = (edit) => runTrackRules(trackAnn([{ id: 1, x: 60, dx: -8, frames: [0, 12], edit }, ...fast]));
  assert.deepEqual(parked(), []);
  assert.deepEqual(parked((p, f) => { if (f === 6) p[1] += 1.2; }).map((h) => [h.issue.rule, h.frame]), [['track.jump', 6]], 'ngang 1,2 m');
  // Xe chạy 8 m/frame đổi tốc độ nhẹ: lệch dọc 1,2 m ở một frame không báo (vật chạy nhanh trong cả hai hệ toạ độ).
  const moving = [{ id: 1, dx: 8, frames: [0, 12], edit: (p, f) => { if (f === 6) p[0] += 1.2; } }, ...statics];
  assert.deepEqual(runTrackRules(trackAnn(moving)), [], 'dọc 1,2 m ở xe chạy nhanh');
});

test('guideline: lưu phiên bản, khôi phục, đọc file kiểu cũ; ghi đè sai bị từ chối', () => {
  const home = require('node:path').join(require('node:os').tmpdir(), `pointsnap-qc-spec-${process.pid}`);
  const store = new Store(home);
  store.write('specs', 'project-7', { name: 'Cũ', override: { maxDistanceM: 80 } });
  assert.equal(store.spec(7).v, 1);
  assert.equal(store.addSpecVersion(7, { name: 'ADAS', note: 'nới', override: { maxDistanceM: 60, qc: { disabledRules: ['fit.empty'] } } }), 2);
  assert.equal(store.spec(7).override.maxDistanceM, 60);
  assert.equal(store.spec(9), null, 'project khác không có, không có bản chung');
  const { qc, guideline } = Rules.resolveSpec(store.spec(7).override);
  assert.deepEqual(qc.disabledRules, ['fit.empty']);
  assert.equal(guideline.maxDistanceM, 60);
  assert.ok(Rules.resolveSpec({ qc: { jump: { posM: 'x' } } }).errors.length);
  assert.ok(Rules.resolveSpec({ ground: { warningM: 1, errorM: 0.5 } }).errors.length);
  const seen = store.setObjectReviews(5, [{ key: 'track:1', fingerprint: 'abc' }], 'ok', 'QC A');
  assert.equal(seen['track:1'].status, 'ok');
  assert.equal(seen['track:1'].by, 'QC A');
  assert.deepEqual(store.setObjectReviews(5, [{ key: 'track:1', fingerprint: 'abc' }], null), {});
});

test('icp: tìm lại chuyển động xe thu từ nền tĩnh (tường, cột), bỏ điểm trong box', () => {
  const Icp = require('../lib/icp');
  const pts = [];
  for (let x = -40; x <= 40; x += 0.2) for (const z of [-1.8, 0, 1]) { pts.push([x, 12, z], [x, -14, z]); } // hai bức tường
  for (let i = 0; i < 40; i += 1) for (const z of [-1.8, -0.5, 0.5, 1.5]) pts.push([-35 + i * 1.9, ((i * 7) % 20) - 10, z]); // cột
  for (let x = -40; x <= 40; x += 0.5) for (let y = -14; y <= 12; y += 0.5) pts.push([x, y, -1.8]); // mặt đất
  const truth = { yaw: 0.03, tx: 4.2, ty: -0.4 }; // frame sau = frame trước dịch / quay ngược
  const c = Math.cos(truth.yaw), s = Math.sin(truth.yaw);
  const toPos = (list) => Float32Array.from(list.flat());
  // Điểm frame sau: p_sau = R⁻¹ (p_trước − t), để T(p_sau) = p_trước.
  const later = pts.map(([x, y, z]) => [c * (x - truth.tx) + s * (y - truth.ty), -s * (x - truth.tx) + c * (y - truth.ty), z]);
  const car = { center: [3, 0, -1], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] };
  later.push(...Array.from({ length: 200 }, (_, i) => [1 + (i % 20) * 0.2, -0.5 + Math.floor(i / 20) * 0.1, -0.5])); // xe chạy: phải bị bỏ
  const r = Icp.register(Icp.structure(toPos(later), [car]), Icp.structure(toPos(pts)), { c: 1, s: 0, tx: 3.5, ty: 0 });
  assert.ok(r.ok, `khớp kém: ${r.quality}`);
  assert.ok(Math.abs(r.T.tx - truth.tx) < 0.1 && Math.abs(r.T.ty - truth.ty) < 0.1, JSON.stringify(r.T));
  assert.ok(Math.abs(Math.atan2(r.T.s, r.T.c) - truth.yaw) < 0.005);
});

test('evidence: chỗ nối có một cụm điểm là một vật; có thêm cụm ở chỗ vật cũ lẽ ra tới là hai vật', () => {
  const E = require('../lib/evidence');
  const I = { c: 1, s: 0, tx: 0, ty: 0 };
  const box = (x) => ({ center: [x, 0, -1], dims: [4.5, 1.9, 1.6], rotation: [0, 0, 0] });
  const carPoints = (x) => { const p = []; for (let dx = -2; dx <= 2; dx += 0.25) for (const z of [-1.4, -0.9, -0.4]) p.push(x + dx, 0.9, z); return p; };
  const ground = []; for (let x = -10; x <= 25; x += 0.5) for (let y = -6; y <= 6; y += 0.5) ground.push(x, y, -1.8);
  const frame = (...cars) => Float32Array.from([...ground, ...cars.flatMap(carPoints)]);
  // A hết ở frame trước tại x = 10 (chạy −5 m/frame); B bắt đầu ở x = 5.
  const one = E.junction({ positions: frame(10), T: I, real: box(10), ghost: box(10), others: [] },
    { positions: frame(5), T: I, real: box(5), ghost: box(5), others: [] });
  assert.equal(one.verdict, 'one', JSON.stringify(one));
  // Cùng lúc ở frame sau vẫn còn một xe (không gán nhãn) đúng chỗ A lẽ ra tới, còn B là xe khác ở x = 18.
  const two = E.junction({ positions: frame(10), T: I, real: box(10), ghost: box(23), others: [] },
    { positions: frame(5, 18), T: I, real: box(18), ghost: box(5), others: [] });
  assert.equal(two.verdict, 'two', JSON.stringify(two));
});

test('trackrules: ghép một-một (Hungarian) chọn tổng chi phí nhỏ nhất, bỏ cặp không được ghép', () => {
  assert.deepEqual(TrackRules.assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]]).sort(), [[0, 1], [1, 0], [2, 2]]);
  assert.deepEqual(TrackRules.assign([[1, Infinity], [Infinity, Infinity]]), [[0, 0]]);
});
