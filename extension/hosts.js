/*
 * Các địa chỉ CVAT đã bật PointSnap và cấu hình annotator theo từng địa chỉ. Dùng chung cho popup, trang Tùy chọn,
 * service worker và settings-bridge (content script), để cả bốn đọc cùng một cách.
 *
 * Lưu trữ:
 * - storage.sync `cvatUrls`: các origin CVAT ngoài localhost:8080 (service worker đăng ký content script cho chúng);
 * - storage.local `annotatorProfiles`: { [origin]: { enabled, guidelineName, guidelineJson } };
 * - storage.local `annotatorEnabled` / `annotatorGuideline`: cấu hình chung cũ, dùng khi origin chưa có cấu hình riêng.
 */
(function (root) {
  'use strict';

  const BUILT_IN = ['http://localhost:8080', 'http://127.0.0.1:8080'];
  const SYNC_DEFAULTS = { cvatUrls: [] };
  const LOCAL_DEFAULTS = { annotatorProfiles: {}, annotatorEnabled: true, annotatorGuideline: '' };

  /** Origin HTTP(S) không kèm tài khoản, đường dẫn, query, fragment; ném lỗi nếu không phải. */
  function httpOrigin(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL không hợp lệ');
    return url.origin;
  }

  const isBuiltIn = (origin) => BUILT_IN.includes(origin);

  /** Khóa cấu hình của một project CVAT trên `origin`; job không thuộc project nào dùng khóa của origin. */
  const projectKey = (origin, projectId) => (Number.isInteger(projectId) && projectId > 0 ? `${origin}#project-${projectId}` : origin);

  /**
   * Cấu hình annotator của `key` (origin, hoặc origin#project-<id>). Bật / tắt luôn theo origin. Bộ ngưỡng: của project nếu
   * project đã có, không thì của origin, không thì cấu hình chung cũ. `scope` cho biết bộ ngưỡng đang lấy từ đâu.
   */
  function profileFor(local, key) {
    const profiles = local.annotatorProfiles || {}, origin = key.split('#')[0];
    const site = profiles[origin], project = key !== origin ? profiles[key] : null;
    const source = project || site;
    return {
      enabled: site ? site.enabled !== false : local.annotatorEnabled !== false,
      guidelineName: source ? source.guidelineName || '' : (local.annotatorGuideline ? 'Cấu hình chung' : ''),
      guidelineJson: source ? source.guidelineJson || '' : local.annotatorGuideline || '',
      scope: project ? 'project' : site ? 'site' : 'shared',
    };
  }

  async function readAll() {
    const [sync, local] = await Promise.all([chrome.storage.sync.get(SYNC_DEFAULTS), chrome.storage.local.get(LOCAL_DEFAULTS)]);
    return { sync, local };
  }

  /** Ghi đè một phần cấu hình của `key` (origin hoặc project). Cấu hình project chỉ giữ bộ ngưỡng. */
  async function saveProfile(key, patch) {
    const { local } = await readAll();
    const { scope, ...current } = profileFor(local, key);
    const next = key.includes('#')
      ? { guidelineName: current.guidelineName, guidelineJson: current.guidelineJson, ...patch }
      : { ...current, ...patch };
    await chrome.storage.local.set({ annotatorProfiles: { ...local.annotatorProfiles, [key]: next } });
  }

  /** Các origin đã bật: localhost mặc định + origin thêm có quyền truy cập. */
  async function enabledOrigins() {
    const { sync } = await readAll();
    const extra = [];
    for (const origin of sync.cvatUrls || []) {
      if (!isBuiltIn(origin) && await chrome.permissions.contains({ origins: [`${origin}/*`] })) extra.push(origin);
    }
    return [...BUILT_IN, ...extra];
  }

  root.PointSnapHosts = { BUILT_IN, SYNC_DEFAULTS, LOCAL_DEFAULTS, httpOrigin, isBuiltIn, projectKey, profileFor, readAll, saveProfile, enabledOrigins };
})(globalThis);
