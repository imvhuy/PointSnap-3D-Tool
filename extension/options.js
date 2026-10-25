'use strict';

const DEFAULTS = { pointsnapUrl: 'http://127.0.0.1:8765', cvatUrls: [], autoFilter: false, autoHighlight: true, autoExpand: true, showScanPanel: false };
// chrome.storage.local: guideline có thể dài hơn giới hạn 8 KB mỗi mục của storage.sync.
const ANNOTATOR_DEFAULTS = { annotatorEnabled: true, annotatorGuideline: '' };
const BUILT_IN = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  $('status').textContent = text;
  $('status').className = kind || '';
}

function readForm() {
  function originOf(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URL không hợp lệ');
    return url.origin;
  }
  const urls = $('cvat-urls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const origins = [];
  for (const url of urls) {
    try {
      const origin = originOf(url);
      if (!BUILT_IN.has(origin) && !origins.includes(origin)) origins.push(origin);
    } catch (_) {
      return { error: 'Địa chỉ CVAT phải là HTTP(S) origin, không chứa tài khoản, đường dẫn, query hoặc fragment.' };
    }
  }
  let pointsnap;
  try {
    pointsnap = originOf($('pointsnap-url').value.trim() || DEFAULTS.pointsnapUrl);
  } catch (_) {
    return { error: 'Địa chỉ PointSnap không hợp lệ' };
  }
  return {
    pointsnapUrl: pointsnap,
    cvatUrls: origins,
    autoFilter: $('auto-filter').checked,
    autoHighlight: $('auto-highlight').checked,
    autoExpand: $('auto-expand').checked,
    showScanPanel: $('show-scan-panel').checked,
  };
}

/** Guideline ghi đè phải là một object JSON; ngưỡng cụ thể được kiểm lại trong trang CVAT. */
function readAnnotatorForm() {
  const text = $('annotator-guideline').value.trim();
  if (text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { error: `Guideline không phải JSON hợp lệ: ${error.message}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Guideline phải là một object JSON { … }' };
  }
  return { annotatorEnabled: $('annotator-enabled').checked, annotatorGuideline: text };
}

chrome.storage.sync.get(DEFAULTS, (data) => {
  $('pointsnap-url').value = data.pointsnapUrl;
  $('cvat-urls').value = (data.cvatUrls || []).join('\n');
  $('auto-filter').checked = !!data.autoFilter;
  $('auto-highlight').checked = !!data.autoHighlight;
  $('auto-expand').checked = !!data.autoExpand;
  $('show-scan-panel').checked = !!data.showScanPanel;
});
chrome.storage.local.get(ANNOTATOR_DEFAULTS, (data) => {
  $('annotator-enabled').checked = data.annotatorEnabled !== false;
  $('annotator-guideline').value = data.annotatorGuideline || '';
});

$('save').addEventListener('click', () => {
  const values = readForm();
  const annotator = readAnnotatorForm();
  const error = values.error || annotator.error;
  if (error) {
    setStatus(error, 'err');
    return;
  }
  // Xin quyền ngay trong lần bấm (Chrome chỉ cho xin quyền khi người dùng vừa thao tác).
  const origins = [...values.cvatUrls, values.pointsnapUrl].map((o) => `${o}/*`);
  chrome.permissions.request({ origins }, (granted) => {
    if (!granted) {
      setStatus('Chưa được cấp quyền truy cập các địa chỉ trên, chưa lưu.', 'err');
      return;
    }
    chrome.storage.local.set(annotator, () => chrome.storage.sync.set(values,
      () => setStatus('Đã lưu. Bảng annotator cập nhật ngay; tải lại trang CVAT cho các tùy chọn khác.', 'ok')));
  });
});

/** Hỏi PointSnap đã lưu trong Tùy chọn; cập nhật ô trạng thái (và dòng trạng thái khi bấm Kiểm tra). */
function checkConnection(fromButton) {
  if (fromButton) setStatus('Đang kiểm tra…');
  chrome.runtime.sendMessage({ type: 'pointsnap', method: 'GET', path: '/api/projects' }, (res) => {
    const ok = !chrome.runtime.lastError && res && res.ok;
    const text = ok ? `PointSnap đang chạy · ${res.data.length} dự án` : ((res && res.error) || 'Không kết nối được PointSnap — chạy "pointsnap ui".');
    $('conn').className = `status ${ok ? 'ok' : 'err'}`;
    $('conn-text').textContent = text;
    if (fromButton) setStatus(ok ? `Kết nối được PointSnap: ${res.data.length} dự án.` : text, ok ? 'ok' : 'err');
  });
}

$('test').addEventListener('click', () => checkConnection(true));
checkConnection(false);
