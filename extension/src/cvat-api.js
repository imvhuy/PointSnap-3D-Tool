/*
 * Đọc dữ liệu job qua REST API chính thức của CVAT (A15), chỉ dùng GET.
 * Yêu cầu đi cùng nguồn với trang CVAT nên dùng phiên đăng nhập sẵn có của trình duyệt;
 * extension không đọc, không lưu token hay cookie.
 */
(function (root) {
  'use strict';

  const core = root.PointSnapCore;

  async function getJson(path) {
    // Không gửi header Accept riêng: CVAT trả 406 với `application/json` không kèm phiên bản API.
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) throw new Error('Đường dẫn CVAT không hợp lệ');
    const res = await fetch(url.href, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`CVAT trả ${res.status} cho ${path.split('?')[0]}`);
    return res.json();
  }

  /** Mọi trang của một danh sách có phân trang (`results` + `next`). */
  async function getAll(path) {
    const out = [];
    let page = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await getJson(`${path}${sep}page_size=500&page=${page}`);
      if (!data || !Array.isArray(data.results)) throw new Error('Danh sách CVAT không hợp lệ');
      out.push(...data.results);
      if (!data.next) return out;
      if (page >= 100) throw new Error('CVAT vượt giới hạn 100 trang; cần thu hẹp dữ liệu');
      page += 1;
    }
  }

  function labelsOfTask(taskId) {
    return getAll(`/api/labels?task_id=${taskId}`);
  }

  function labelsOfJob(jobId) {
    return getAll(`/api/labels?job_id=${jobId}`);
  }

  function job(jobId) {
    return getJson(`/api/jobs/${jobId}`);
  }

  function annotations(jobId) {
    return getJson(`/api/jobs/${jobId}/annotations?_=${Date.now()}`);
  }

  /**
   * Thêm bộ lọc "pointsnap_error không rỗng" của task vào lịch sử bộ lọc của CVAT, để lúc mở job
   * mục này đã có trong "Recently used". Trả về số nhãn có thuộc tính cờ (0 = task chưa có thuộc tính cờ).
   */
  async function seedFilterForTask(taskId, attrName) {
    const labels = await labelsOfTask(taskId);
    const specs = core.flagSpecs(labels, attrName);
    if (!specs.size) return 0;
    const names = [...specs.values()].map((s) => s.name);
    root.PointSnapCvat.seedFilterHistory(core.filterLogic(names, attrName));
    return specs.size;
  }

  root.PointSnapCvatApi = { job, labelsOfJob, labelsOfTask, annotations, seedFilterForTask };
})(globalThis);
