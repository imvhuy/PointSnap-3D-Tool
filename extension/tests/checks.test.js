'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Checks = require('../src/annotator/checks.js');
const G = require('../src/annotator/guideline.js');

const g = G.DEFAULT_GUIDELINE;
const box = (dims, center = [10, 0, -1]) => ({ center, dims, rotation: [0, 0, 0] });
const goodContact = { contactZ: -1.8, gapM: 0, spreadM: 0, confidence: 1, pointsBelowBottom: 0 };
const run = (overrides, guideline = g) => Checks.checkBox({
  box: box([4.5, 1.9, 1.6]), label: 'car', classKey: 'car', attributes: {}, occluded: false, trackDims: null,
  contact: goodContact, coarseGroundZ: -1.8, others: [], pointsInside: 200, ...overrides,
}, guideline);
const rules = (issues) => issues.map((i) => i.rule);

test('box đúng không có vấn đề', () => {
  assert.deepEqual(run({}), []);
});

test('kích thước ngoài ngưỡng: vượt 25% là Lỗi, vượt 10% là Cảnh báo', () => {
  assert.equal(run({ box: box([8.0, 1.9, 1.6]) })[0].severity, 'error');
  assert.equal(run({ box: box([6.6, 1.9, 1.6]) })[0].severity, 'warning');
});

test('scale không đồng bộ so với trung vị track; người đi bộ không xét', () => {
  const trackDims = [[4.5, 1.9, 1.6], [4.5, 1.9, 1.6], [4.52, 1.9, 1.6]];
  assert.deepEqual(rules(run({ box: box([5.0, 1.9, 1.6]), trackDims })), ['size.in_track']);
  const ped = run({ box: box([0.7, 0.7, 1.4]), label: 'pedestrian', classKey: 'pedestrian', trackDims: [[0.7, 0.7, 1.8], [0.7, 0.7, 1.8]] });
  assert.ok(!rules(ped).includes('size.in_track'));
});

test('lơ lửng: Cảnh báo > 20 cm, Lỗi > 35 cm; điểm dưới đáy box là Lỗi', () => {
  assert.equal(run({ contact: { ...goodContact, gapM: 0.25 } })[0].severity, 'warning');
  assert.deepEqual(run({ contact: { ...goodContact, gapM: 0.15 } }), []);
  assert.equal(run({ contact: { ...goodContact, gapM: -0.35 } })[0].title, 'Box lún');
  assert.ok(rules(run({ contact: { ...goodContact, gapM: 0.1, pointsBelowBottom: 20 } })).includes('ground.points_below'));
});

test('box xa hơn 50 m không đánh giá cao độ', () => {
  const far = run({ box: box([4.5, 1.9, 1.6], [60, 0, -1]), contact: { ...goodContact, gapM: 0.6 } });
  assert.deepEqual(far.map((i) => [i.rule, i.severity]), [['ground.no_evidence', 'info']]);
});

test('thiếu bằng chứng mặt đất chỉ là Thông tin', () => {
  const issues = run({ contact: null });
  assert.deepEqual(issues.map((i) => [i.rule, i.severity]), [['ground.no_evidence', 'info']]);
});

test('Z ngoài ngưỡng so với mặt đất chung của vùng, chỉ trong 35 m', () => {
  assert.ok(rules(run({ coarseGroundZ: -4.2 })).includes('z.range'));
  assert.deepEqual(rules(run({ coarseGroundZ: -3.2 })), [], 'đứng trên bục cao 1,4 m vẫn hợp lệ');
  assert.deepEqual(rules(run({ box: box([4.5, 1.9, 1.6], [40, 0, -1]), coarseGroundZ: -9 })), []);
});

test('quá xa chỉ kiểm khi guideline có maxDistanceM', () => {
  const far = { box: box([4.5, 1.9, 1.6], [90, 0, -1]) };
  assert.ok(!rules(run(far)).includes('range.too_far'));
  assert.ok(rules(run(far, G.resolve({ maxDistanceM: 80 }).guideline)).includes('range.too_far'));
});

test('chồng lấn: cứ chồng là Lỗi, cặp spec cho phép chỉ Thông tin', () => {
  const other = { box: box([4.5, 1.9, 1.6], [10.5, 0, -1]), label: 'car', classKey: 'car', clientId: 7 };
  const found = run({ others: [other] }).find((i) => i.rule === 'overlap');
  assert.equal(found.otherClientId, 7);
  const graze = run({ others: [{ ...other, box: box([4.5, 1.9, 1.6], [10, 1.88, -1]) }] }).find((i) => i.rule === 'overlap');
  assert.equal(graze.severity, 'error', 'lấn 2 cm vẫn là Lỗi');
  assert.match(graze.short, /chồng 1%/);
  const cone = { box: box([0.4, 0.4, 0.8], [12.2, 0.8, -1.4]), label: 'Obstacle', classKey: 'Obstacle', clientId: 9 };
  assert.ok(rules(run({ others: [cone] })).includes('overlap'), 'mọi class đều kiểm');
  const listed = G.resolve({ overlap: { classes: ['car'] } }).guideline;
  assert.ok(!rules(run({ others: [cone] }, listed)).includes('overlap'), 'spec liệt kê class thì chỉ kiểm các class đó');
  const ped = { box: box([0.7, 0.7, 1.7], [10, 0, -1]), label: 'pedestrian', classKey: 'pedestrian', clientId: 8 };
  const allowed = run({ others: [ped] });
  assert.ok(!rules(allowed).includes('overlap'));
  assert.deepEqual(allowed.filter((i) => i.rule === 'overlap.allowed').map((i) => i.severity), ['info'], 'cặp được phép vẫn hiện ở mức Thông tin');
});

test('box rỗng và box occluded', () => {
  assert.ok(rules(run({ pointsInside: 0 })).includes('fit.empty'));
  assert.deepEqual(rules(run({ pointsInside: 0, occluded: true, contact: null })), []);
});

test('thiếu thuộc tính bắt buộc theo spec-vn', () => {
  const issues = run({ label: 'Vehicle', classKey: 'Vehicle', attributes: { subtype: '' } });
  assert.ok(rules(issues).includes('attr.missing'));
});

test('angleOutliers bắt keyframe lật đúng 180° (unwrap không bắt được) và không đánh dấu xe rẽ', () => {
  const DEG = Math.PI / 180;
  const turning = Array.from({ length: 30 }, (_, i) => (i < 15 ? 0 : (i - 15) * 6) * DEG);
  assert.ok(Checks.angleOutliers(turning, 15).every((v) => !v));
  const flipped = turning.slice();
  flipped[20] += Math.PI;
  assert.deepEqual(Checks.angleOutliers(flipped, 15).flatMap((v, i) => (v ? [i] : [])), [20]);
});

test('madOutliers đánh dấu frame lệch, không báo khi cả track gần như bằng nhau', () => {
  assert.deepEqual(Checks.madOutliers([4.5, 4.5, 4.51, 4.49, 5.4, 4.5], 0.05), [false, false, false, false, true, false]);
  assert.ok(Checks.madOutliers([4.5, 4.51, 4.52, 4.5], 0.05).every((v) => !v));
});
