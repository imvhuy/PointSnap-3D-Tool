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
