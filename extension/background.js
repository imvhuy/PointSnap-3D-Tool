/*
 * Service worker của extension PointSnap cho CVAT (A15).
 * - Gọi API PointSnap thay cho content script (quyền host của extension nên PointSnap không cần mở CORS).
 * - Đăng ký content script cho địa chỉ CVAT khác mặc định mà người dùng đã cấp quyền ở trang Tùy chọn.
 */
'use strict';

const DEFAULTS = { pointsnapUrl: 'http://127.0.0.1:8765', cvatUrls: [] };
const METHODS = new Set(['GET', 'POST', 'PUT']);
const EARLY_JS = ['src/core.js', 'src/cvat-dom.js', 'src/cvat-api.js', 'src/seed.js'];
const MAIN_JS = ['src/manual-geometry.js','src/cvat-compat.js','src/manual-overlay.js','src/cvat-3d-hook.js'];
const PANEL_JS = ['src/panel-css.js','src/manual-controller.js','src/content.js'];

function originPattern(url) {
  return `${httpOrigin(url)}/*`;
}

function httpOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URL không hợp lệ');
  return url.origin;
}

function sameCvatOrigin(a, b) {
  const normalize = value => {
    const url = new URL(httpOrigin(value));
    const host = ['localhost','127.0.0.1','[::1]'].includes(url.hostname) ? 'localhost' : url.hostname;
    return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
  };
  return normalize(a) === normalize(b);
}

async function fetchPointSnap(base, path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function fetchCamera(base, path) {
  const res = await fetch(`${base}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { ok: false, status: res.status, error: 'Không có ảnh camera cho mục này; kiểm tra ảnh và pose của bản xuất' };
  if ((res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
    return { ok: false, error: 'Ảnh camera trả về sai định dạng' };
  }
  const limit = 2 * 1024 * 1024;
  if (Number(res.headers.get('Content-Length')) > limit) return { ok: false, error: 'Ảnh camera quá lớn' };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > limit || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) {
    return { ok: false, error: 'Ảnh camera không hợp lệ hoặc quá lớn' };
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return { ok: true, data: { image_url: `data:image/jpeg;base64,${btoa(binary)}`,
                            channel: (res.headers.get('X-Camera-Channel') || '').slice(0, 80) } };
}

function requestRoute(method, path, body, sender) {
  if (!METHODS.has(method) || typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..') || path.includes('#')) return null;
  const url = new URL(path, 'http://pointsnap.invalid');
  if (url.pathname.includes('%') || url.origin !== 'http://pointsnap.invalid') return null;
  if ((sender.url || '').startsWith(chrome.runtime.getURL(''))) {
    return method === 'GET' && path === '/api/projects' ? { options: true } : null;
  }
  const page = new URL(sender.url);
  const job = page.pathname.match(/^\/tasks\/\d+\/jobs\/(\d+)\/?$/);
  if (!job) return null;
  const jobId = Number(job[1]);
  if (method === 'GET' && url.pathname === '/api/rules' && !url.search) return { jobId, origin: page.origin };
  if (method === 'GET' && (url.pathname === `/api/extension/jobs/${jobId}` || url.pathname === '/api/extension/poll')) {
    const keys = [...url.searchParams.keys()];
    if (keys.some(k => !['cvat_url','job_id','after','version'].includes(k)) || keys.length !== new Set(keys).size) return null;
    if (httpOrigin(url.searchParams.get('cvat_url')) !== page.origin) return null;
    if (url.pathname.endsWith('/poll') && Number(url.searchParams.get('job_id')) !== jobId) return null;
    return { jobId, origin: page.origin };
  }
  const jobRepair = url.pathname.match(/^\/api\/jobs\/(\d+)\/tracks\/(\d+)\/repair$/);
  if (jobRepair && method === 'GET') {
    if (Number(jobRepair[1]) !== jobId) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some(k => !['frame', 'rule', 'slug'].includes(k)) || keys.length !== new Set(keys).size) return null;
    const frame = url.searchParams.get('frame');
    if (frame !== null && !/^\d+$/.test(frame)) return null;
    const rule = url.searchParams.get('rule');
    if (rule && !/^[a-zA-Z0-9_.-]+$/.test(rule)) return null;
    const slug = url.searchParams.get('slug') || undefined;
    if (slug && !/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    return { jobId, origin: page.origin, trackId: Number(jobRepair[2]), frame: frame !== null ? Number(frame) : undefined, rule: rule || undefined, slug };
  }
  if (method === 'POST' && url.pathname === '/api/extension/events' && !url.search && body && body.job_id === jobId && sameCvatOrigin(body.cvat_url, page.origin)
      && /^[a-zA-Z0-9_-]+$/.test(body.slug) && /^\d{8}-\d{6}(?:-\d+)?-job\d+$/.test(body.run_id)
      && Number.isInteger(body.finding_index) && body.finding_index >= 0 && ['selected','evaluated','saved'].includes(body.kind)
      && [null,'remaining','cleared','insufficient','stale'].includes(body.state) && typeof body.session === 'string' && body.session.length <= 80
      && Number.isInteger(body.sequence) && body.sequence >= 0 && Number.isInteger(body.revision) && body.revision >= 0
      && Object.keys(body).every(k=>['slug','run_id','job_id','cvat_url','finding_index','kind','state','revision','sequence','session'].includes(k)))
    return {slug:body.slug,runId:body.run_id,jobId,origin:page.origin};
  if (url.search) return null;
  const manual = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/scans\/(\d{8}-\d{6}(?:-\d+)?-job\d+)\/findings\/(\d+)\/(guide|evaluate)$/);
  if (manual && Number.isSafeInteger(Number(manual[3]))) {
    if (manual[4] === 'guide' && method === 'GET' && body === undefined ||
        manual[4] === 'evaluate' && method === 'POST' && body && typeof body === 'object' &&
        body.box && Number.isInteger(body.box.frame) && Array.isArray(body.context) && body.context.length <= 10000 &&
        typeof body.context_complete === 'boolean' && Number.isInteger(body.revision) && body.revision >= 0 &&
        (body.complete_frames === undefined || (Array.isArray(body.complete_frames) && body.complete_frames.length <= 10000 &&
          body.complete_frames.every(f => Number.isSafeInteger(f) && f >= 0))) &&
        Object.keys(body).every(k => ['box','context','context_complete','complete_frames','revision'].includes(k))) {
      return {slug:manual[1],runId:manual[2],guideIndex:Number(manual[3]),jobId,origin:page.origin};
    }
    return null;
  }
  const camera = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/scans\/(\d{8}-\d{6}(?:-\d+)?-job\d+)\/findings\/(\d+)\/camera$/);
  if (camera && method === 'GET' && body === undefined && Number.isSafeInteger(Number(camera[3]))) {
    return { slug: camera[1], runId: camera[2], cameraIndex: Number(camera[3]), jobId, origin: page.origin };
  }
  // Đề xuất sửa theo mục của lần quét (kèm bằng chứng mặt đất / hướng của lần quét), giống web; chỉ đọc.
  const findingRepair = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/scans\/(\d{8}-\d{6}(?:-\d+)?-job\d+)\/findings\/(\d+)\/repair$/);
  if (findingRepair && method === 'GET' && body === undefined && Number.isSafeInteger(Number(findingRepair[3]))) {
    return { slug: findingRepair[1], runId: findingRepair[2], repairIndex: Number(findingRepair[3]), jobId, origin: page.origin };
  }
  const match = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/scans(?:\/(\d{8}-\d{6}(?:-\d+)?-job\d+)(?:\/(reviews)(?:\/(\d+))?)?)?$/);
  if (!match) return null;
  const [,slug,runId,reviews,index] = match;
  if (method === 'POST' && !runId && body && Number.isInteger(body.job_id) && body.job_id === jobId && typeof body.flag === 'boolean'
      && Object.keys(body).every(k => ['job_id','flag'].includes(k))) return { slug, jobId, origin: page.origin };
  if (method === 'GET' && runId && index === undefined) return { slug, runId, jobId, origin: page.origin };
  if (method === 'PUT' && reviews && index !== undefined && body && [null,'ok','fp'].includes(body.verdict)
      && Object.keys(body).length === 1) return { slug, runId, jobId, origin: page.origin };
  return null;
}

async function callPointSnap({ method, path, body }, sender) {
  const { pointsnapUrl } = await chrome.storage.sync.get(DEFAULTS);
  try {
    const route = requestRoute(method, path, body, sender);
    if (!route) return { ok: false, error: 'Endpoint hoặc job không được phép' };
    const base = httpOrigin(pointsnapUrl || DEFAULTS.pointsnapUrl);
    if (route.slug) {
      const project = await fetchPointSnap(base, `/api/projects/${route.slug}`);
      if (!project.ok || !sameCvatOrigin(project.data.cvat_url, route.origin)) return { ok: false, error: 'Project không thuộc CVAT đang mở' };
      if (route.runId) {
        const run = await fetchPointSnap(base, `/api/projects/${route.slug}/scans/${route.runId}`);
        if (!run.ok || run.data.job_id !== route.jobId || (run.data.summary?.cvat_url && !sameCvatOrigin(run.data.summary.cvat_url, route.origin))) return { ok: false, error: 'Run không thuộc job đang mở' };
        if (route.guideIndex !== undefined) {
          if (!Array.isArray(run.data.findings) || !run.data.findings[route.guideIndex]) return {ok:false,error:'Không có mục lỗi này'};
          const res = await fetchPointSnap(base,path,method,body);
          return res.ok ? res : {ok:false,status:res.status,error:res.data?.detail || 'Không kiểm tra được box'};
        }
        if (route.cameraIndex !== undefined) {
          if (!Array.isArray(run.data.findings) || route.cameraIndex >= run.data.findings.length) return { ok: false, error: 'Không có mục camera này' };
          return await fetchCamera(base, path);
        }
        if (route.repairIndex !== undefined) {
          if (!Array.isArray(run.data.findings) || route.repairIndex >= run.data.findings.length) return { ok: false, error: 'Không có mục này trong lần quét' };
          const res = await fetchPointSnap(base, path);
          if (!res.ok) {
            const detail = res.data && res.data.detail;
            return { ok: false, status: res.status, error: typeof detail === 'string' ? detail : `PointSnap trả ${res.status}` };
          }
          return { ok: true, status: res.status, data: res.data };
        }
        if (method === 'GET' && !path.endsWith('/reviews')) return run;
      }
    }
    const res = await fetchPointSnap(base, path, method, body);
    const data = res.data;
    if (!res.ok) {
      const detail = data && data.detail;
      return { ok: false, status: res.status, error: typeof detail === 'string' ? detail : `PointSnap trả ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (_) {
    return { ok: false, error: 'URL/yêu cầu không hợp lệ hoặc không kết nối được PointSnap' };
  }
}

const BUILT_IN_CVAT = ['http://localhost:8080', 'http://127.0.0.1:8080'];

/** Chỉ nhận yêu cầu từ trang của chính extension hoặc từ trang CVAT đã cấu hình, không từ trang web khác. */
async function trustedSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.frameId != null && sender.frameId !== 0) return false;
  if ((sender.url || '').startsWith(chrome.runtime.getURL(''))) return true;
  if (!sender.tab) return false;
  let origin;
  try {
    origin = httpOrigin(new URL(sender.url || '').origin);
  } catch (_) {
    return false;
  }
  if (BUILT_IN_CVAT.includes(origin)) return true;
  const { cvatUrls } = await chrome.storage.sync.get(DEFAULTS);
  return (cvatUrls || []).some((url) => {
    try {
      return new URL(url).origin === origin;
    } catch (_) {
      return false;
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Web PointSnap vừa bấm "Mở trong CVAT": đưa tab CVAT đang mở job đó lên trước (không tải lại trang).
  if (message && message.type === 'focusTab' && sender.tab) {
    trustedSender(sender).then((ok) => {
      if (ok) {
        chrome.tabs.update(sender.tab.id, { active: true });
        chrome.windows.update(sender.tab.windowId, { focused: true });
      }
      sendResponse({ ok });
    });
    return true;
  }
  if (!message || message.type !== 'pointsnap') return false;
  trustedSender(sender).then((ok) => (ok ? callPointSnap(message, sender) : { ok: false, error: 'Nguồn yêu cầu không được phép' }))
    .then(sendResponse);
  return true;
});

/** Đăng ký content script cho các địa chỉ CVAT thêm ở trang Tùy chọn (chỉ những địa chỉ đã được cấp quyền). */
async function syncContentScripts() {
  const { cvatUrls } = await chrome.storage.sync.get(DEFAULTS);
  const matches = [];
  for (const url of cvatUrls || []) {
    try {
      if (BUILT_IN_CVAT.includes(httpOrigin(url))) continue;
      const pattern = originPattern(url);
      if (!matches.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    } catch (_) {
      // Bỏ qua địa chỉ không hợp lệ.
    }
  }
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ids = registered.map((s) => s.id).filter((id) => id.startsWith('pointsnap-'));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: 'pointsnap-early', matches, js: EARLY_JS, runAt: 'document_start', persistAcrossSessions: true },
    { id:'pointsnap-main',matches,js:MAIN_JS,world:'MAIN',runAt:'document_idle',persistAcrossSessions:true },
    { id: 'pointsnap-panel', matches, js: PANEL_JS, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

chrome.runtime.onInstalled.addListener(() => { syncContentScripts(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.cvatUrls) syncContentScripts();
});
chrome.permissions.onAdded.addListener(() => { syncContentScripts(); });
chrome.permissions.onRemoved.addListener(() => { syncContentScripts(); });
// Bấm biểu tượng extension mở popup.html (trạng thái PointSnap, mở nhanh web / CVAT / Tùy chọn).
