'use strict';
// Probe kiểm toán: chỉ dữ liệu tổng hợp, không đọc cấu hình hoặc gọi CVAT.
const assert = require('node:assert/strict');
const { scanJob, trackFindings } = require('../../../qc/lib/scan');
const { parsePcd, lzf } = require('../../../qc/lib/pcd');
const G = require('../../../extension/src/annotator/guideline');

const labels = [{ id: 1, name: 'car', attributes: [] }];
const points = (x = 10) => [x, 0, -1, 0, 0, 0, 4.5, 1.9, 1.6, 0, 0, 0, 0, 0, 0, 0];
function clientFor(annotations, { stop = 3, deleted = [], missing = false } = {}) {
  return {
    job: async () => ({ id: 1, task_id: 1, start_frame: 0, stop_frame: stop }),
    task: async () => ({ id: 1, name: 'Synthetic audit', project_id: null }),
    labels: async () => labels,
    annotations: async () => annotations,
    meta: async () => ({ chunk_size: stop + 1, deleted_frames: deleted }),
    chunk: async () => {
      if (missing) throw new Error('Synthetic CVAT 500');
      return Array.from({ length: stop + 1 }, () => ({ positions: new Float32Array([50, 50, -1.8]) }));
    },
  };
}

(async () => {
  const evidence = [];
  const missing = await scanJob({
    client: clientFor({ shapes: [{ id: 1, frame: 0, label_id: 1, type: 'cuboid', points: points(), attributes: [] }], tracks: [] }, { missing: true }),
    jobId: 1, guideline: G.DEFAULT_GUIDELINE,
  });
  assert.equal(missing.summary.gate.verdict, 'pass');
  assert.equal(missing.summary.boxes, 0);
  assert.equal(missing.coverage.framesWithoutPoints.length, 4);
  assert.equal(missing.objects[0].noPoints, 1);
  evidence.push({ id: 'SCAN-01', expected: 'Không thể pass khi không đọc được point cloud nào; cần trạng thái incomplete/review độc lập với finding.',
    actual: { gate: missing.summary.gate, boxes: missing.summary.boxes, summaryObjects: missing.summary.objects,
      actualObjects: missing.objects.length, framesWithoutPoints: missing.coverage.framesWithoutPoints, chunkErrors: missing.coverage.chunkErrors } });

  const tracks = [1, 2].map((id) => ({ id, label_id: 1, attributes: [], shapes: [
    { frame: 0, type: 'cuboid', outside: false, points: points(), attributes: [] },
    { frame: 3, type: 'cuboid', outside: true, points: points(), attributes: [] },
  ] }));
  const deleted = await scanJob({ client: clientFor({ shapes: [], tracks }, { deleted: [0, 1, 2] }), jobId: 1, guideline: G.DEFAULT_GUIDELINE });
  const duplicate = deleted.findings.find((f) => f.rule === 'track.duplicate');
  assert.deepEqual(duplicate.frames, [0, 1, 2]);
  assert.equal(deleted.objects.length, 2);
  assert.equal(deleted.summary.frames, 1);
  assert.equal(deleted.summary.boxes, 0);
  evidence.push({ id: 'SCAN-02', expected: 'Frame đã xóa không tham gia luật duplicate, danh sách object và tiến độ duyệt.',
    actual: { gate: deleted.summary.gate, summaryFrames: deleted.summary.frames, scannedBoxes: deleted.summary.boxes,
      duplicate: { rule: duplicate.rule, frames: duplicate.frames }, objects: deleted.objects.map(({ key, first, last, boxes }) => ({ key, first, last, boxes })) } });

  const head = Buffer.from('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary_compressed\n');
  const sizes = Buffer.alloc(8); sizes.writeUInt32LE(2, 0); sizes.writeUInt32LE(12, 4);
  // Chỉ có 1 byte chưa nén thay vì 12 byte đã khai báo: literal length=1 và byte 0.
  const decoded = lzf(Buffer.from([0, 0]), 12);
  assert.equal(decoded.length, 12);
  const fabricated = [...parsePcd(Buffer.concat([head, sizes, Buffer.from([0, 0])]))];
  assert.deepEqual(fabricated, [0, 0, 0]);
  evidence.push({ id: 'SCAN-03', expected: 'Từ chối luồng LZF giải nén thiếu byte; không tạo điểm từ vùng zero-fill.',
    actual: { decodedLength: decoded.length, validPointsReturned: fabricated } });

  const box = (yaw) => ({ center: [10, 0, -1], dims: [4.5, 1.9, 1.6], rotation: [0, 0, yaw] });
  // Vật biến mất từ frame 1 và quay lại từ frame 5: không có chứng cứ chuyển động/hướng trong khoảng outside.
  const keyframes = [[0, 0, false], [1, 0, true], [5, Math.PI, false], [6, Math.PI, false], [7, Math.PI, false]]
    .map(([frame, yaw, outside]) => ({ frame, box: box(yaw), outside }));
  const acrossOutside = trackFindings(new Map([['track:1', { key: 'track:1', label: 'car', keyframes }]]), G.DEFAULT_GUIDELINE);
  assert.deepEqual(acrossOutside.map((h) => [h.frame, h.issue.rule]), [[0, 'heading.jump']]);
  evidence.push({ id: 'SCAN-04', expected: 'Luật heading.jump chỉ so trong mỗi đoạn visible liên tục; đoạn chỉ có 1 keyframe không đủ bằng chứng báo hướng nhảy.',
    actual: acrossOutside.map(({ frame, issue }) => ({ frame, rule: issue.rule, severity: issue.severity })) });

  console.log(JSON.stringify({ baseline: 'e845e7d', syntheticOnly: true, confirmed: evidence }, null, 2));
})().catch((e) => { console.error(e); process.exitCode = 1; });
