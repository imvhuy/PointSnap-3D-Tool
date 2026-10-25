'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../hosts.js');
const Hosts = globalThis.PointSnapHosts;

test('hosts: địa chỉ dán nguyên URL trang job vẫn lấy đúng origin; URL có tài khoản bị từ chối', () => {
  assert.equal(Hosts.httpOrigin('https://cvat.congty.vn/tasks/3/jobs/9?frame=2'), 'https://cvat.congty.vn');
  assert.throws(() => Hosts.httpOrigin('https://user:pass@cvat.congty.vn'));
  assert.throws(() => Hosts.httpOrigin('chrome://extensions'));
});

test('hosts: origin chưa có cấu hình riêng dùng cấu hình chung cũ; có cấu hình riêng thì chỉ dùng nó', () => {
  const local = { annotatorEnabled: false, annotatorGuideline: '{"maxDistanceM":80}', annotatorProfiles: {
    'https://cvat.congty.vn': { enabled: true, guidelineName: 'du-an-vn', guidelineJson: '{"maxDistanceM":60}' },
  } };
  assert.deepEqual(Hosts.profileFor(local, 'http://localhost:8080'),
    { enabled: false, guidelineName: 'Cấu hình chung', guidelineJson: '{"maxDistanceM":80}' });
  assert.deepEqual(Hosts.profileFor(local, 'https://cvat.congty.vn'),
    { enabled: true, guidelineName: 'du-an-vn', guidelineJson: '{"maxDistanceM":60}' });
  assert.deepEqual(Hosts.profileFor({}, 'https://moi.vn'), { enabled: true, guidelineName: '', guidelineJson: '' });
});
