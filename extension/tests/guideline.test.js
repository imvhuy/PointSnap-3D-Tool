'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/annotator/guideline.js');

test('ghi đè chỉ thay phần được ghi, giữ phần còn lại của mặc định', () => {
  const { guideline, errors } = G.resolve({ zRange: { maxM: 0.4 }, maxDistanceM: 80 });
  assert.deepEqual(errors, []);
  assert.equal(guideline.zRange.maxM, 0.4);
  assert.equal(guideline.zRange.minM, G.DEFAULT_GUIDELINE.zRange.minM);
  assert.equal(guideline.maxDistanceM, 80);
  assert.ok(guideline.size.ranges.car);
});

test('ghi đè sai kiểu thì dùng mặc định và trả lỗi đọc được', () => {
  const { guideline, errors } = G.resolve({ size: { ranges: { car: { length: [5, 3] } } } });
  assert.equal(guideline, G.DEFAULT_GUIDELINE);
  assert.ok(errors[0].includes('size.ranges["car"]'));
});

test('classKey dùng Class/subtype khi có khoảng kích thước cho khóa đó', () => {
  const g = G.DEFAULT_GUIDELINE;
  assert.equal(G.classKey(g, 'Vehicle', { subtype: 'van' }), 'Vehicle/van');
  assert.equal(G.classKey(g, 'Vehicle', { subtype: 'spaceship' }), 'Vehicle');
  assert.equal(G.classKey(g, 'car', {}), 'car');
});

test('diff: chỉ lưu phần khác mặc định; merge lại cho đúng bản đã sửa, kể cả khi bỏ một khoảng kích thước', () => {
  const D = G.DEFAULT_GUIDELINE, edited = JSON.parse(JSON.stringify(D));
  edited.size.keyAttributes['Two-wheels'] = 'rider_state';
  edited.size.ranges['Two-wheels/true'] = { length: [1.2, 2.8], width: [0.45, 1.45], height: [1.5, 2.0] };
  delete edited.size.ranges.car;
  edited.ground.warningM = 0.15;
  const override = G.diff(D, edited);
  assert.ok(JSON.stringify(override).length < 400, 'không lưu cả bộ mặc định');
  assert.equal(override.size.ranges.car, null);
  const { guideline, errors } = G.resolve(override);
  assert.deepEqual(errors, []);
  assert.deepEqual(guideline, edited);
  assert.equal(G.diff(D, JSON.parse(JSON.stringify(D))), undefined);
  assert.equal(G.resolve({ maxDistanceM: null }).guideline.maxDistanceM, null, 'null giá trị đơn vẫn là "không kiểm"');
});

test('classKey: thuộc tính checkbox chia ngưỡng theo "true" / "false"', () => {
  const { guideline } = G.resolve({ size: { keyAttributes: { Bike: 'has_rider' },
    ranges: { 'Bike/true': { length: [1, 2], width: [0.4, 1], height: [1.5, 2] } } } });
  assert.equal(G.classKey(guideline, 'Bike', { has_rider: 'true' }), 'Bike/true');
  assert.equal(G.classKey(guideline, 'Bike', { has_rider: 'false' }), 'Bike');
});
