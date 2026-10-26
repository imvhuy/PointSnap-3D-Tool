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
    { enabled: false, guidelineName: 'Cấu hình chung', guidelineJson: '{"maxDistanceM":80}', scope: 'shared' });
  assert.deepEqual(Hosts.profileFor(local, 'https://cvat.congty.vn'),
    { enabled: true, guidelineName: 'du-an-vn', guidelineJson: '{"maxDistanceM":60}', scope: 'site' });
  assert.deepEqual(Hosts.profileFor({}, 'https://moi.vn'), { enabled: true, guidelineName: '', guidelineJson: '', scope: 'shared' });
});

test('hosts: project có bộ ngưỡng riêng thì dùng nó; chưa có thì dùng của địa chỉ CVAT; bật / tắt luôn theo địa chỉ', () => {
  const site = 'https://cvat.congty.vn', key = Hosts.projectKey(site, 12);
  assert.equal(key, 'https://cvat.congty.vn#project-12');
  assert.equal(Hosts.projectKey(site, null), site);
  assert.equal(Hosts.projectKey(site, 0), site);
  const local = { annotatorProfiles: { [site]: { enabled: false, guidelineName: 'chung', guidelineJson: '{"maxDistanceM":60}' } } };
  assert.deepEqual(Hosts.profileFor(local, key), { enabled: false, guidelineName: 'chung', guidelineJson: '{"maxDistanceM":60}', scope: 'site' });
  local.annotatorProfiles[key] = { guidelineName: 'ADAS', guidelineJson: '{"maxDistanceM":90}' };
  assert.deepEqual(Hosts.profileFor(local, key), { enabled: false, guidelineName: 'ADAS', guidelineJson: '{"maxDistanceM":90}', scope: 'project' });
});
