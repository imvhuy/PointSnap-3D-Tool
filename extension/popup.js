'use strict';
// Popup trên thanh trình duyệt: PointSnap có đang chạy không, mở nhanh web PointSnap / CVAT / Tùy chọn.

const DEFAULTS = { pointsnapUrl: 'http://127.0.0.1:8765', cvatUrls: [] };
const $ = (id) => document.getElementById(id);

function origin(value, fallback) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : fallback;
  } catch (_) {
    return fallback;
  }
}

function setServer(kind, text, sub) {
  $('server').className = `status ${kind}`;
  $('server-text').textContent = text;
  $('server-sub').textContent = sub || '';
}

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  const web = origin(cfg.pointsnapUrl, DEFAULTS.pointsnapUrl);
  const cvat = origin((cfg.cvatUrls || [])[0], 'http://localhost:8080');
  $('open-web').addEventListener('click', () => { chrome.tabs.create({ url: `${web}/app#results` }); window.close(); });
  $('open-cvat').addEventListener('click', () => { chrome.tabs.create({ url: cvat }); window.close(); });

  chrome.runtime.sendMessage({ type: 'pointsnap', method: 'GET', path: '/api/projects' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setServer('err', 'Không hỏi được PointSnap', 'Tải lại extension ở chrome://extensions rồi thử lại.');
    } else if (res.ok) {
      const n = Array.isArray(res.data) ? res.data.length : 0;
      setServer('ok', `PointSnap đang chạy · ${n} dự án`, web.replace(/^https?:\/\//, ''));
    } else {
      setServer('err', 'PointSnap chưa chạy', `Chạy "pointsnap ui" rồi mở lại popup (${web.replace(/^https?:\/\//, '')}).`);
    }
  });
});

$('open-options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
