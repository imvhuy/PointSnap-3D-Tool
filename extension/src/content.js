/*
 * Bảng PointSnap trên trang job của CVAT (A15).
 * E1 nhận diện trang job · E2 tự bật bộ lọc · E3 thông báo lỗi của box đang chọn · E4 lỗi tiếp / trước
 * E5 danh sách lỗi của job · E6 quét lại, gắn cờ, ghi Đúng / Báo nhầm qua PointSnap.
 * E1–E4 chỉ cần cờ `pointsnap_error` trên CVAT; E5 lấy từ cờ, PointSnap chỉ thêm phần kết luận xem tay; E6 cần PointSnap.
 */
(function (root) {
  'use strict';

  const core = root.PointSnapCore;
  const cvat = root.PointSnapCvat;
  const api = root.PointSnapCvatApi;
  const ATTR = core.FLAG_ATTR;
  const hasChrome = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  const SEV_LABEL = { error: 'Lỗi', warning: 'Cảnh báo', info: 'Thông tin' };
  const RULE_LABEL = core.RULE_LABEL;


  // ---------------------------------------------------------------- trạng thái

  const S = {
    sid: 0,
    job: null,
    flags: [],
    frames: [],
    hasFlagAttr: true,
    loading: false,
    loadError: null,
    frame: null,
    navTarget: null,
    active: null,
    filterOn: false,
    filterBusy: false,
    filterProblem: null,
    ps: { checked: false, online: false, error: null, project: null, run: null, active: null, flagRun: false },
    confirmFlag: false,
    notice: null,
    camera: null,
    listFilter: 'all',
    tab: 'now',
    pick: 0,
    collapsed: false,
    pos: null,
    timing: {},
    repair: {
      loading: false, error: null, data: null, trackId: null, frame: null,
      trackEtag: null, rule: null, confirming: false, applying: false,
      applied: false, rollingBack: false, historyId: null, verdict: null,
    },
  };
  const settings = { autoFilter: false, autoHighlight: true, autoExpand: true, pointsnapUrl: 'http://127.0.0.1:8765' };
  // Sửa / hoàn tác box từ web (history_rev): nhớ theo `track:frame` để thẻ lỗi hiện đúng trạng thái và nút Hoàn tác.
  const remoteHistory = new Map();
  const expanded = new Set();

  // ---------------------------------------------------------------- PointSnap (qua service worker)

  /** Gọi API PointSnap qua service worker của extension (không cần mở CORS trên PointSnap). */
  function pointsnap(method, path, body) {
    if (root.PointSnapTransport) return root.PointSnapTransport(method, path, body);
    return new Promise((resolve) => {
      if (!hasChrome) {
        resolve({ ok: false, error: 'Không chạy trong extension' });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'pointsnap', method, path, body }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Không có phản hồi' });
          } else {
            resolve(res);
          }
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function loadSettings() {
    if (!hasChrome || !chrome.storage) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.storage.sync.get({ autoFilter: false, autoHighlight: true, autoExpand: true, pointsnapUrl: settings.pointsnapUrl }, (data) => {
        Object.assign(settings, data || {});
        chrome.storage.local.get({ panelPos: null, panelCollapsed: false }, (local) => {
          S.pos = (local && local.panelPos) || null;
          S.collapsed = !!(local && local.panelCollapsed);
          resolve();
        });
      });
    });
  }

  function saveLocal(values) {
    if (hasChrome && chrome.storage) chrome.storage.local.set(values);
  }

  // ---------------------------------------------------------------- vòng đời theo trang

  let lastHref = '';
  let tickTimer = null;

  function onRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const job = core.parseJobUrl(location.href);
    const task = location.pathname.match(/\/tasks\/(\d+)/);
    if (task && !job) api.seedFilterForTask(Number(task[1]), ATTR).catch(() => {});
    if (job && (!S.job || S.job.jobId !== job.jobId)) startJob(job);
    else if (!job && S.job) stopJob();
  }

  async function startJob(job) {
    stopJob();
    const sid = ++S.sid;
    expanded.clear();
    Object.assign(S, {
      job, flags: [], frames: [], hasFlagAttr: true, loading: true, loadError: null, frame: null, active: null,
      filterOn: false, filterBusy: false, filterProblem: null, confirmFlag: false, notice: null, camera: null,
      ps: { checked: false, online: false, error: null, project: null, run: null, active: null, flagRun: false },
      timing: { start: performance.now() },
      missing: [],
      linkSeq: -1,
      reviewsRev: null,
      historyRev: null,
      repair: {
        loading: false, error: null, data: null, trackId: null, frame: null,
        trackEtag: null, rule: null, confirming: false, applying: false,
        applied: false, rollingBack: false, historyId: null, verdict: null,
      },
    });
    mountPanel();
    render();
    api.seedFilterForTask(job.taskId, ATTR).catch(() => {});
    loadPointSnap(sid);
    linkLoop(sid);
    await loadFlags(sid);
    S.timing.flags = performance.now();
    const ready = await cvat.waitFor(cvat.workspaceReady, 120000, 250);
    if (sid !== S.sid || !ready) return;
    S.timing.ready = performance.now();
    S.missing = cvat.missingParts();
    S.frame = cvat.currentFrame();
    tickTimer = setInterval(tick, 300);
    if (settings.autoFilter && S.flags.length) await turnFilterOn(true);
    S.timing.filter = performance.now();
    render();
  }

  function stopJob() {
    root.PointSnapManualController?.clear();
    S.sid += 1;
    S.job = null;
    clearInterval(tickTimer);
    tickTimer = null;
    pendingStep = 0;
    pendingCommand = null;
    navigating = false;
    S.navTarget = null;
    highlightTurn.clear();
    remoteHistory.clear();
    unmountPanel();
  }

  async function loadFlags(sid) {
    S.loading = true;
    render();
    try {
      const [labels, annotations] = await Promise.all([api.labelsOfJob(S.job.jobId), api.annotations(S.job.jobId)]);
      if (sid !== S.sid) return;
      const specs = core.flagSpecs(labels, ATTR);
      S.hasFlagAttr = specs.size > 0;
      const cvatFlags = core.collectFlags(annotations, specs);
      const cleanCvatFlags = cvatFlags.map((f) => {
        const nonTrack = (f.items || []).filter((it) => !it.rule || !it.rule.startsWith('track.'));
        return nonTrack.length > 0 ? { ...f, items: nonTrack, severity: core.worstSeverity(nonTrack) } : null;
      }).filter(Boolean);
      if (Array.isArray(S.ps.run?.findings)) {
        S.flags = core.flagsFromFindings(S.ps.run.findings);
      } else {
        S.flags = cleanCvatFlags;
      }
      S.frames = core.flaggedFrames(S.flags);
      S.loadError = null;
    } catch (err) {
      if (sid !== S.sid) return;
      if (S.ps.run && S.ps.run.findings && S.ps.run.findings.length > 0) {
        S.flags = core.flagsFromFindings(S.ps.run.findings);
        S.frames = core.flaggedFrames(S.flags);
        S.loadError = null;
      } else {
        S.loadError = `Không đọc được nhãn của job từ CVAT (${err.message}).`;
      }
    }
    S.loading = false;
    render();
  }

  /** Theo dõi frame hiện tại, box đang chọn và trạng thái bộ lọc; chỉ vẽ lại khi có thay đổi. */
  function tick() {
    // Bộ lọc đang bật thì danh sách bên phải chỉ còn box có cờ: mở DETAILS để thấy và đọc được nội dung cờ.
    if (settings.autoExpand && S.filterOn && !isTyping(document.activeElement)) cvat.expandDetails(expanded);
    const frame = cvat.currentFrame();
    const active = cvat.activeObject(ATTR);
    const filterOn = cvat.filtersActive();
    const activeKey = (a) => (a ? `${a.clientId}|${a.label}|${a.flag}` : '');
    if (frame !== S.frame || activeKey(active) !== activeKey(S.active) || filterOn !== S.filterOn) {
      if (frame !== S.frame) S.pick = 0;
      S.frame = frame;
      S.active = active;
      S.filterOn = filterOn;
      render();
    }
  }

  // ---------------------------------------------------------------- hành động trên CVAT

  async function turnFilterOn(auto) {
    if (S.filterBusy) return;
    S.filterBusy = true;
    S.filterProblem = null;
    render();
    const res = await cvat.applyRecentFilter(ATTR);
    S.timing.filterSteps = res.steps;
    S.filterBusy = false;
    S.filterOn = cvat.filtersActive();
    if (!res.ok) S.filterProblem = { reason: res.reason, needsReload: !!res.needsReload, auto: !!auto };
    render();
  }

  async function turnFilterOff() {
    S.filterBusy = true;
    render();
    const res = await cvat.clearFilters();
    S.filterBusy = false;
    S.filterOn = cvat.filtersActive();
    if (!res.ok) setNotice('error', `${res.reason}. Mở Filters của CVAT và bấm "Clear filters".`);
    render();
  }

  let navigating = false;

  /** Chỉ số cờ ở `frame` khớp lệnh từ web (cùng nhãn, nội dung cờ chứa câu thông báo của mục); không khớp thì 0. */
  function pickFor(frame, match) {
    if (!match) return 0;
    const here = flagsAt(frame);
    const matches = here.filter((f) => (!match.label || f.label === match.label)
      && (!match.message || f.value.includes(match.message))
      && (match.objectId == null || (f.kind === match.kind && f.objectId === match.objectId))
      && (match.track_id == null || (f.kind === 'track' && f.objectId === match.track_id))
      && (match.track_id != null || match.source_id == null || (f.kind === 'shape' && f.objectId === match.source_id)));
    return matches.length === 1 ? here.indexOf(matches[0]) : -1;
  }

  async function goTo(frame, match) {
    const sid = S.sid;
    // Một lần chuyển frame tại một thời điểm: bấm dồn khi CVAT đang tải frame sẽ bị CVAT bỏ qua.
    if (navigating) return { ok: false, busy: true };
    navigating = true;
    S.navTarget = frame;
    render();
    let res;
    try {
      res = await cvat.goToFrame(frame);
    } finally {
      if (sid === S.sid) { navigating = false; S.navTarget = null; }
    }
    if (sid !== S.sid) return { ok: false, stale: true };
    if (pendingStep) {
      const dir = Math.sign(pendingStep);
      pendingStep -= dir;
      if (!res.ok) pendingStep = 0;
      else {
        S.frame = frame;
        step(dir);
        return res;
      }
    }
    if (!res.ok) {
      setNotice('error', `${res.reason}. Gõ ${frame} vào ô số frame của CVAT rồi nhấn Enter.`);
    } else {
      S.frame = frame;
      S.pick = pickFor(frame, match);
      if (S.pick < 0) {
        S.active = null;
        setNotice('warn', 'Không xác định được duy nhất box của kết quả này. Mở link ID từ báo cáo hoặc chọn box trong CVAT.');
        return { ok: false, ambiguous: true };
      }
      if (match) S.active = null;
      S.notice = null;
      render();
      if (settings.autoHighlight || match) highlight(flagsAt(frame)[S.pick], 0);
    }
    if (pendingCommand) {
      const command = pendingCommand;
      pendingCommand = null;
      runCommand(command);
    }
    return res;
  }

  let pendingStep = 0;

  async function step(dir) {
    if (!S.frames.length) return;
    if (navigating) {
      // Bấm trong lúc CVAT đang tải frame: cộng dồn số lần bấm, chạy tiếp ngay khi frame tải xong.
      pendingStep += dir;
      return;
    }
    const current = cvat.currentFrame();
    const target = core.stepFrame(S.frames, current === null ? -1 : current, dir);
    if (target === null) {
      pendingStep = 0;
      setNotice('info', dir > 0 ? 'Đã tới frame có lỗi cuối cùng của job.' : 'Đây là frame có lỗi đầu tiên của job.');
      return;
    }
    await goTo(target);
  }

  const highlightTurn = new Map();

  /**
   * Làm sáng box của một cờ: rê chuột hộ vào mục cùng nhãn trong danh sách đối tượng của CVAT.
   * Bấm lại lần nữa thì chuyển sang mục cùng nhãn kế tiếp (khi frame có nhiều box cùng nhãn).
   */
  async function highlight(flag, turn) {
    if (!flag) return;
    const sid = S.sid;
    // Chỉ lấy danh sách khi CVAT đã ở đúng frame của cờ và danh sách đã đứng yên qua hai lần đọc liên tiếp,
    // để không rê nhầm vào box của frame cũ còn sót lại trong lúc CVAT vẽ lại.
    let previous = '';
    const items = await cvat.waitFor(() => {
      if (cvat.currentFrame() !== flag.frame) return null;
      const list = cvat.sidebarItems().filter((it) => it.label === flag.label && it.flag === flag.value);
      const ids = list.map((it) => it.clientId).join(',');
      const stable = ids === previous;
      previous = ids;
      return stable && list.length ? list : null;
    }, 2500, 120);
    if (sid !== S.sid || cvat.currentFrame() !== flag.frame) return;
    if (!items) {
      if (turn !== 0) setNotice('info', `Không thấy box ${flag.label} trong danh sách đối tượng của CVAT ở frame này.`);
      return;
    }
    if (items.length !== 1) {
      setNotice('warn', 'Có nhiều box cùng nhãn và cờ. Không thể xác định server ID từ danh sách CVAT; dùng link ID trong báo cáo.');
      return;
    }
    cvat.hoverItem(items[0].el);
    if (S.notice && S.notice.text.startsWith('Không thấy box ')) {
      S.notice = null;
      render();
    }
  }

  function flagsAt(frame) {
    return S.flags.filter((f) => f.frame === frame);
  }

  // ---------------------------------------------------------------- liên kết với giao diện web PointSnap

  let pendingCommand = null;

  /**
   * Hỏi PointSnap mỗi giây: web có gửi lệnh "mở mục này" cho job đang mở không, và kết luận xem tay có đổi không.
   * Mỗi lần hỏi cũng báo cho web biết tab CVAT này đang mở job (để web không mở thêm tab tải lại job).
   */
  async function linkLoop(sid) {
    while (sid === S.sid) {
      const res = await pointsnap('GET', `/api/extension/poll?job_id=${S.job.jobId}&after=${S.linkSeq}&cvat_url=${encodeURIComponent(location.origin)}&version=0.3.0`);
      if (sid !== S.sid) return;
      if (res.ok) {
        if (!S.ps.online) await loadPointSnap(sid);
        S.linkSeq = res.data.seq;
        if (res.data.command) runCommand(res.data.command);
        if (S.reviewsRev !== null && res.data.reviews_rev !== S.reviewsRev) refreshReviews();
        S.reviewsRev = res.data.reviews_rev;
        const ev = res.data.history_event;
        if (S.historyRev !== null && res.data.history_rev !== S.historyRev && ev && ev.rev > S.historyRev) {
          applyHistoryEvent(ev);
        }
        if (res.data.history_rev !== undefined) S.historyRev = res.data.history_rev;

        // Cập nhật trạng thái quét nếu bên Web UI đang quét:
        if (res.data.active) {
          if (!S.ps.active || S.ps.active.run_id !== res.data.active.run_id || S.ps.active.progress !== res.data.active.progress) {
            S.ps.active = res.data.active;
            render();
          }
        } else if (S.ps.active && !S.ps.flagRun) {
          S.ps.active = null;
          render();
        }

        // TỰ ĐỘNG ĐỒNG BỘ KHI CÓ LẦN QUÉT MỚI HOÀN TẤT:
        const latestRunId = res.data.latest_run_id;
        const currentRunId = S.ps.run ? S.ps.run.run_id : null;
        if (latestRunId && latestRunId !== currentRunId) {
          await loadPointSnap(sid);
          await loadFlags(sid);
        }
      } else if (S.ps.online) {
        S.ps.online = false;
        render();
      }
      await new Promise((resolve) => setTimeout(resolve, res.ok ? 1000 : 5000));
    }
  }

  /** Lệnh từ web: chuyển tới frame của mục, làm sáng đúng box; `bring` thì đưa tab CVAT này lên trước. */
  async function runCommand(command) {
    if (command.action === 'annotations_changed') {
      setNotice('info', 'Nhãn đã được cập nhật và xác nhận trên CVAT. Tải lại trang để nạp box mới; lưu các sửa đổi đang làm trước khi tải lại.', [
        { action: 'reload', text: 'Tải lại nhãn CVAT' },
      ]);
      render();
      return;
    }
    if (navigating) {
      pendingCommand = command;
      return;
    }
    S.tab = 'now';
    if (command.bring && hasChrome) chrome.runtime.sendMessage({ type: 'focusTab' }, () => void chrome.runtime.lastError);
    await goTo(command.frame, command);
    if (Number.isInteger(command.index)) root.PointSnapManualController?.select(command.index);
  }

  /**
   * Box vừa được sửa / hoàn tác ở phía web: cập nhật thẻ đề xuất sửa (đã ghi / hoàn tác được) ngay, không cần F5.
   * Thao tác của chính extension trả về cùng history_id nên áp dụng lại cũng không đổi gì.
   */
  function applyHistoryEvent(ev) {
    if (!S.job || Number(ev.job_id) !== S.job.jobId) return;
    const key = `${Number(ev.track_id)}:${Number(ev.frame)}`;
    if (ev.action === 'apply') remoteHistory.set(key, ev.history_id);
    else if (ev.action === 'rollback') remoteHistory.delete(key);
    else return;
    const current = S.repair.trackId === Number(ev.track_id) && S.repair.frame === Number(ev.frame);
    if (!current) return;
    if (ev.action === 'apply') {
      S.repair.applied = true;
      S.repair.confirming = false;
      S.repair.historyId = ev.history_id;
    } else if (S.repair.historyId === ev.history_id || !S.repair.historyId) {
      S.repair.applied = false;
      S.repair.historyId = null;
    }
    render();
  }

  /** Kết luận xem tay vừa đổi ở phía web: đọc lại để nút Đúng / Báo nhầm khớp nhau. */
  async function refreshReviews() {
    const run = S.ps.run;
    if (!run || !S.ps.project) return;
    const res = await pointsnap('GET', `/api/projects/${S.ps.project.slug}/scans/${run.run_id}/reviews`);
    if (res.ok && S.ps.run === run) {
      run.reviews = res.data.reviews;
      render();
    }
  }

  // ---------------------------------------------------------------- PointSnap: quét, gắn cờ, kết luận

  async function loadPointSnap(sid) {
    const [res, rulesRes] = await Promise.all([
      pointsnap('GET', `/api/extension/jobs/${S.job.jobId}?cvat_url=${encodeURIComponent(location.origin)}`),
      pointsnap('GET', '/api/rules'),
    ]);
    if (sid !== S.sid) return;
    if (rulesRes && rulesRes.ok && rulesRes.data) {
      core.setRulesCatalog(rulesRes.data);
    }
    S.ps.checked = true;
    S.ps.online = !!res.ok;
    S.ps.error = res.ok ? null : res.error;
    if (res.ok) {
      S.ps.project = res.data.project;
      S.ps.run = res.data.run;
      if (res.data.active && !S.ps.active) {
        S.ps.active = res.data.active;
        pollRun(sid);
      }
      // Nếu CVAT chưa mang cờ hoặc cờ từ lần quét cũ, nạp findings từ lần quét PointSnap:
      if (Array.isArray(S.ps.run?.findings)) {
        S.flags = core.flagsFromFindings(S.ps.run.findings);
        S.frames = core.flaggedFrames(S.flags);
      }
    }
    render();
  }

  async function startScan(flag) {
    if (S.ps.active || S.ps.starting) return;
    const sid = S.sid;
    S.confirmFlag = false;
    const project = S.ps.project;
    if (!project) {
      setNotice('warn', `PointSnap chưa có dự án nối với ${location.origin}. Tạo dự án ở giao diện PointSnap, tab Kết nối CVAT.`);
      return;
    }
    S.ps.starting = true;
    render();
    const res = await pointsnap('POST', `/api/projects/${project.slug}/scans`, { job_id: S.job.jobId, flag });
    if (sid !== S.sid) return;
    S.ps.starting = false;
    if (!res.ok) {
      setNotice('error', `Không bắt đầu quét được: ${res.error}`);
      return;
    }
    S.ps.active = { run_id: res.data.run_id, status: 'queued', progress: 0, message: 'Đang chờ…' };
    S.ps.flagRun = flag;
    render();
    pollRun(S.sid);
  }

  async function pollRun(sid) {
    while (sid === S.sid && S.ps.active) {
      const res = await pointsnap('GET', `/api/projects/${S.ps.project.slug}/scans/${S.ps.active.run_id}`);
      if (sid !== S.sid) return;
      if (!res.ok) {
        setNotice('error', `Mất kết nối với PointSnap: ${res.error}`);
        S.ps.active = null;
        break;
      }
      const run = res.data;
      if (run.status === 'done' || run.status === 'failed') {
        const flagged = S.ps.flagRun && run.status === 'done';
        S.ps.active = null;
        S.ps.flagRun = false;
        if (run.status === 'failed') setNotice('error', `Quét thất bại: ${run.error || run.message}`);
        else if (flagged) {
          setNotice('warn', 'Đã gắn cờ mới lên CVAT. Danh sách lỗi đã cập nhật theo lần quét mới.', [
            { action: 'reload', text: 'Tải lại trang CVAT' },
          ]);
        } else {
          setNotice('info', 'Đã quét xong. Danh sách lỗi đã cập nhật theo lần quét mới.');
        }
        await loadPointSnap(sid);
        await loadFlags(sid);
        break;
      }
      S.ps.active = { ...S.ps.active, ...run };
      render();
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    render();
  }

  function reviewState(flag) {
    if (!flag || flag.ambiguous) return null;
    const run = S.ps.run;
    if (!run || !run.findings) return null;
    const indices = core.matchFindings(run.findings, flag);
    if (!indices.length) return null;
    const verdicts = indices.map((i) => (run.reviews || {})[String(i)] || null);
    const same = verdicts.every((v) => v === verdicts[0]);
    return { indices, verdict: same ? verdicts[0] : null };
  }

  async function review(flag, verdict) {
    const state = reviewState(flag);
    if (!state) return;
    const sid = S.sid, run = S.ps.run;
    const value = state.verdict === verdict ? null : verdict;
    const { slug } = S.ps.project;
    for (const index of state.indices) {
      const res = await pointsnap('PUT', `/api/projects/${slug}/scans/${run.run_id}/reviews/${index}`, { verdict: value });
      if (sid !== S.sid || S.ps.run !== run) return;
      if (!res.ok) {
        setNotice('error', `Không lưu được kết luận: ${res.error}`);
        break;
      }
      run.reviews = res.data.reviews;
    }
    render();
  }

  async function showCamera(flag) {
    const matched = reviewState(flag);
    if (!matched || !S.ps.project) return;
    const sid = S.sid, run = S.ps.run, slug = S.ps.project.slug;
    const request = { flag, run, pending: true, data: null, error: null };
    S.camera = request;
    render();
    const res = await pointsnap('GET', `/api/projects/${slug}/scans/${run.run_id}/findings/${matched.indices[0]}/camera`);
    if (sid !== S.sid || S.ps.run !== run || currentFlag().flag !== flag || S.camera !== request) {
      if (S.camera === request) S.camera = null;
      return;
    }
    request.pending = false;
    if (res.ok && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(res.data?.image_url || '')) request.data = res.data;
    else request.error = res.error || 'Không tải được ảnh camera';
    render();
  }

  // ---------------------------------------------------------------- giao diện

  let host = null;
  let shadow = null;

  function mountPanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'pointsnap-cvat-panel';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = root.PointSnapPanelCss || '';
    const panel = document.createElement('div');
    panel.className = 'ps';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'PointSnap');
    shadow.append(style, panel);
    document.documentElement.appendChild(host);
    placePanel(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('mousedown', onDragStart);
  }

  function unmountPanel() {
    if (host) host.remove();
    host = null;
    shadow = null;
  }

  function placePanel(panel) {
    const pos = S.pos || { left: 64, top: 104 };
    const left = Math.max(0, Math.min(pos.left, window.innerWidth - 120));
    const top = Math.max(0, Math.min(pos.top, window.innerHeight - 40));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function onDragStart(event) {
    const head = event.target.closest('.head');
    if (!head || event.target.closest('button') || event.button !== 0) return;
    const panel = event.currentTarget;
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    const move = (e) => {
      S.pos = { left: e.clientX - dx, top: e.clientY - dy };
      placePanel(panel);
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      saveLocal({ panelPos: S.pos });
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    event.preventDefault();
  }

  function setNotice(kind, text, actions) {
    S.notice = { kind, text, actions: actions || [] };
    render();
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  const svg = (d, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">`
    + `<path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const LOGO = '<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true">'
    + '<path d="M24 6 L38 14 L24 22 L10 14 Z M10 14 V30 L24 38 L38 30 V14 M24 22 V38" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>'
    + '<circle cx="24" cy="38" r="5" fill="#4C9AFF"/></svg>';
  const ICON = {
    prev: svg('M10 3.5 5.5 8 10 12.5'),
    next: svg('M6 3.5 10.5 8 6 12.5'),
    min: svg('M3.5 8h9', 14),
    max: svg('M4 6l4 4 4-4', 14),
    close: svg('M4.5 4.5l7 7M11.5 4.5l-7 7', 12),
    check: svg('M3.5 8.5l3 3 6-7', 14),
    cross: svg('M4.5 4.5l7 7M11.5 4.5l-7 7', 14),
    target: svg('M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z', 14),
    refresh: svg('M12.5 6A4.75 4.75 0 1 0 13 9M12.5 2.5V6H9', 14),
    web: svg('M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5', 14),
  };

  function sevBadge(sev) {
    return `<span class="sev ${esc(sev)}">${esc(SEV_LABEL[sev] || sev)}</span>`;
  }

  /** Cờ đang hiện trên thẻ: của box đang chọn nếu đọc được, nếu không thì cờ thứ `S.pick` ở frame hiện tại. */
  function currentFlag() {
    const here = flagsAt(S.frame);
    const a = S.active;
    if (a && a.flag) {
      const hits = here.filter((f) => f.value === a.flag && f.label === a.label);
      const hit = hits.length === 1 ? hits[0] : null;
      if (hit) return { flag: hit, index: here.indexOf(hit), here, clientId: a.clientId };
      const rawItems = core.parseFlag(a.flag);
      const items = rawItems.filter((it) => !it.rule || !it.rule.startsWith('track.'));
      if (items.length > 0) {
        return {
          flag: { frame: S.frame, label: a.label, value: a.flag, items, severity: core.worstSeverity(items), ambiguous: true },
          index: -1,
          here,
          clientId: a.clientId,
        };
      }
    }
    if (!here.length || S.pick < 0) return { flag: null, index: -1, here };
    const i = ((S.pick % here.length) + here.length) % here.length;
    const flag = here[i];
    const sameLabel = a && a.label === flag.label && here.filter((f) => f.label === a.label).length === 1;
    return { flag, index: i, here, clientId: sameLabel ? a.clientId : null };
  }

  function render() {
    if (!shadow) return;
    const panel = shadow.querySelector('.ps');
    const body = panel.querySelector('.body');
    const scroll = body ? body.scrollTop : 0;
    panel.classList.toggle('collapsed', S.collapsed);
    panel.innerHTML = renderHead() + (S.collapsed ? '' : renderTabs() + `<div class="body">${root.PointSnapManualController?.controls() || ''}${renderBody()}</div>`);
    const newBody = panel.querySelector('.body');
    if (newBody) newBody.scrollTop = scroll;
  }

  function renderHead() {
    const ps = S.ps;
    const dotTitle = ps.online ? 'PointSnap đang chạy' : 'PointSnap chưa bật — bộ lọc, chuyển lỗi, thông báo lỗi vẫn dùng được';
    const dot = ps.checked ? `<span class="dot ${ps.online ? 'on' : ''}" title="${dotTitle}"></span>` : '';
    const pos = S.frames.indexOf(S.frame);
    const count = S.collapsed && S.frames.length
      ? `<span class="head-count">${pos >= 0 ? `${pos + 1} / ${S.frames.length}` : `${S.frames.length} frame lỗi`}</span>` : '';
    const label = S.collapsed ? 'Mở rộng' : 'Thu gọn';
    const web = ps.online
      ? `<button class="icon-btn" data-action="open-web" aria-label="Mở kết quả trên web PointSnap" title="Mở kết quả job này trên web PointSnap">${ICON.web}</button>` : '';
    return `<div class="head">${LOGO}<span class="brand">PointSnap</span>${count}<span class="grow"></span>${dot}${web}`
      + `<button class="icon-btn" data-action="collapse" aria-label="${label}" title="${label}">${S.collapsed ? ICON.max : ICON.min}</button></div>`;
  }

  function renderTabs() {
    if (!S.flags.length) return '';
    const tab = (key, text) => `<button class="tab" role="tab" aria-selected="${S.tab === key}" data-action="tab" data-k="${key}">${text}</button>`;
    return `<div class="tabs" role="tablist">${tab('now', 'Lỗi hiện tại')}${tab('list', `Danh sách <span class="tab-count">${S.flags.length}</span>`)}</div>`;
  }

  function renderBody() {
    if (S.loading && !S.flags.length) return '<div class="empty">Đang đọc cờ lỗi của job từ CVAT…</div>';
    if (S.loadError) return note('error', esc(S.loadError), [{ action: 'refresh', text: 'Thử lại' }]);
    if (!S.hasFlagAttr && !S.flags.length) {
      return note('warn', 'Job này chưa được gắn cờ. Quét bằng PointSnap, bấm <b>Quét + gắn cờ</b>, rồi tải lại trang.') + renderScan();
    }
    let html = '';
    if (S.notice) html += note(S.notice.kind, esc(S.notice.text), S.notice.actions, true);
    if (S.missing && S.missing.length) {
      html += note('warn', `Không tìm thấy ${esc(S.missing.join(', '))} của CVAT (extension viết cho CVAT 2.77); phần liên quan có thể không chạy.`);
    }
    if (!S.flags.length) {
      return `${html}<div class="empty"><b>Job không còn box mang cờ.</b><br>Vừa sửa xong? Quét lại và gắn cờ bằng PointSnap để kiểm.</div>${renderScan()}`;
    }
    return html + (S.tab === 'list' ? renderList() : renderNow());
  }

  function note(kind, html, actions, closable) {
    const buttons = (actions || []).map((a) => `<button class="link" data-action="${esc(a.action)}">${esc(a.text)}</button>`).join('');
    const close = closable ? `<button class="icon-btn small" data-action="dismiss" aria-label="Đóng">${ICON.close}</button>` : '';
    return `<div class="note ${esc(kind)}" role="status"><div class="grow">${html}`
      + `${buttons ? `<div class="note-actions">${buttons}</div>` : ''}</div>${close}</div>`;
  }

  function renderNow() {
    return renderNav() + renderCard() + renderStatus();
  }

  function renderNav() {
    const frame = S.frame;
    const loading = S.navTarget !== null && S.navTarget !== undefined;
    const prev = loading || frame === null ? null : core.stepFrame(S.frames, frame, -1);
    const next = loading ? null : core.stepFrame(S.frames, frame === null ? -1 : frame, 1);
    const pos = S.frames.indexOf(frame);
    const sub = loading ? 'Đang tải frame…' : pos >= 0 ? `Frame lỗi ${pos + 1} / ${S.frames.length}` : `${S.frames.length} frame có lỗi`;
    return '<div class="nav">'
      + `<button class="nav-btn" data-action="prev" ${prev === null ? 'disabled' : ''} aria-label="Frame có lỗi trước" title="Frame có lỗi trước (phím ,)">${ICON.prev}</button>`
      + `<div class="nav-mid"><span class="nav-frame">Frame ${loading ? S.navTarget : frame ?? '—'}</span><span class="nav-sub">${sub}</span></div>`
      + `<button class="nav-btn primary" data-action="next" ${next === null ? 'disabled' : ''} aria-label="Frame có lỗi tiếp theo" title="Frame có lỗi tiếp theo (phím .)">${ICON.next}</button>`
      + '</div>';
  }

  function clearGhostTarget() { root.PointSnapManualController?.clear(); }

  function renderManualSection(flag) {
    const matched = reviewState(flag);
    if (!S.ps.online || !matched || !S.ps.project || !S.job) {
      root.PointSnapManualController?.clear();
      return '<div class="repair-box small muted">Kéo sửa bằng CVAT · thước/tọa độ dùng trực tiếp trên canvas.</div>';
    }
    const target=S.ps.run.findings[matched.indices[0]];
    const indices=S.ps.run.findings.flatMap((f,i)=>['error','warning'].includes(f.severity) && !f.rule?.startsWith('track.') && f.frame===target.frame &&
      (target.track_id!=null ? f.track_id===target.track_id : target.source_id!=null && f.track_id==null && f.source_id===target.source_id) ? [i]:[]);
    root.PointSnapManualController?.activate({jobId:S.job.jobId,frame:flag.frame,slug:S.ps.project.slug,
      run:S.ps.run,indices:indices.length?indices:matched.indices,request:pointsnap});
    return root.PointSnapManualController?.card() || '';
  }

  function renderCard() {
    const { flag, index, here, clientId } = currentFlag();
    if (!flag) {
      return '<div class="empty">Frame này không có box mang cờ.<br>Bấm <b>›</b> hoặc phím <span class="kbd">.</span> để tới lỗi tiếp theo.</div>';
    }
    const repairHtml = renderManualSection(flag);
    const first = flag.items[0];
    const displayedRule=root.PointSnapManualController?.getRule() || first.rule;
    const title = RULE_LABEL[displayedRule] || 'Lỗi nhãn';
    const pager = here.length > 1
      ? `<span class="pager"><button class="icon-btn small" data-action="pick" data-d="-1" aria-label="Lỗi trước trong frame">${ICON.prev}</button>`
        + `<span>${index >= 0 ? index + 1 : '–'} / ${here.length}</span>`
        + `<button class="icon-btn small" data-action="pick" data-d="1" aria-label="Lỗi sau trong frame">${ICON.next}</button></span>` : '';
    const meta = [esc(flag.label), clientId != null ? `#${clientId}` : null, `frame ${flag.frame}`].filter(Boolean).join(' · ');
    const messages = flag.items
      .map((it) => `<p class="msg">${flag.items.length > 1 ? `${sevBadge(it.severity)} ` : ''}${esc(it.text)}</p>`).join('');
    const tips = [...new Set(flag.items.map((it) => it.tip))].map((t) => `<div>${esc(t)}</div>`).join('');
    const i = S.flags.indexOf(flag);
    const rs = i >= 0 ? reviewState(flag) : null;
    let actions = '';
    if (rs) {
      actions += `<button class="btn ${rs.verdict === 'ok' ? 'chosen ok' : ''}" data-action="review-ok" data-i="${i}" aria-pressed="${rs.verdict === 'ok'}">${ICON.check}Đúng là lỗi</button>`;
      actions += `<button class="btn ${rs.verdict === 'fp' ? 'chosen fp' : ''}" data-action="review-fp" data-i="${i}" aria-pressed="${rs.verdict === 'fp'}">${ICON.cross}Báo nhầm</button>`;
      actions += `<button class="btn" data-action="camera" data-i="${i}">Ảnh camera</button>`;
    }
    if (i >= 0) {
      actions += `<span class="grow"></span><button class="icon-btn ghost" data-action="highlight" data-i="${i}" title="Làm sáng box này trên khung 3D" aria-label="Làm sáng box">${ICON.target}</button>`;
    }
    const trackId = (flag.kind === 'track' && flag.objectId != null) ? flag.objectId
      : (flag.track_id != null ? flag.track_id : null);
    const camera = S.camera && S.camera.flag === flag && S.camera.run === S.ps.run ? S.camera : null;
    const photo = !camera ? '' : camera.pending ? '<p class="muted">Đang tải ảnh camera…</p>'
      : camera.error ? `<p class="muted">${esc(camera.error)}</p>`
      : `<figure class="camera"><img src="${esc(camera.data.image_url)}" alt="Ảnh camera quanh ${esc(flag.label)}"><figcaption>${esc(camera.data.channel)}</figcaption></figure>`;
    return `<article class="card sev-${esc(flag.severity)}">`
      + `<div class="card-top">${sevBadge(flag.severity)}${displayedRule ? `<code>${esc(displayedRule)}</code>` : ''}<span class="grow"></span>${pager}</div>`
      + `<h3 class="card-title">${esc(title)}</h3><div class="card-meta">${meta}</div>`
      + repairHtml
      + `<details class="small" style="margin-top:10px"><summary>Chi tiết cảnh báo</summary>${messages}<div class="fix"><div class="fix-label">Cách sửa</div>${tips}</div></details>`
      + (actions ? `<div class="card-actions">${actions}</div>` : '')
      + photo
      + '</article>';
  }

  function renderStatus() {
    let filter;
    if (S.filterBusy) filter = '<span class="muted">Đang bật bộ lọc…</span>';
    else if (S.filterOn) filter = '<span class="state on"></span>Bộ lọc CVAT đang bật<button class="link" data-action="filter-on">Chỉ box lỗi</button><button class="link" data-action="filter-off">Hiện tất cả</button>';
    else filter = '<span class="state"></span>Đang hiện mọi box<button class="link" data-action="filter-on">Chỉ box lỗi</button>';
    let html = `<div class="status-row"><span class="grow filter">${filter}</span><span class="keys"><span class="kbd">,</span><span class="kbd">.</span>chuyển lỗi</span></div>`;
    const p = S.filterProblem;
    if (p && !S.filterOn) {
      html += p.needsReload
        ? note('warn', 'Lần đầu mở task này: CVAT cần tải lại trang một lần để có bộ lọc PointSnap.', [{ action: 'reload', text: 'Tải lại trang' }])
        : note('warn', `${esc(p.reason)}. Làm tay: Filters → Add rule → Attributes → nhãn → <b>${ATTR}</b> → is not empty.`);
    }
    return html;
  }

  function renderList() {
    const counts = { all: S.flags.length, error: 0, warning: 0 };
    S.flags.forEach((f) => { if (counts[f.severity] !== undefined) counts[f.severity] += 1; });
    const seg = (key, text) => `<button class="seg-btn" aria-pressed="${S.listFilter === key}" data-action="list-filter" data-k="${key}">${text}<span>${counts[key]}</span></button>`;
    const shown = S.flags.filter((f) => S.listFilter === 'all' || f.severity === S.listFilter);
    let html = `<div class="seg">${seg('all', 'Tất cả')}${seg('error', 'Lỗi')}${seg('warning', 'Cảnh báo')}</div>`;
    if (!shown.length) {
      html += '<div class="empty">Không có mục nào.</div>';
    } else {
      html += '<div class="list">';
      shown.forEach((flag) => {
        const rs = reviewState(flag);
        const first = flag.items[0];
        const tag = rs && rs.verdict
          ? `<span class="verdict ${rs.verdict}">${rs.verdict === 'ok' ? 'Đúng' : 'Nhầm'}</span>`
          : `<span class="sev-dot ${esc(flag.severity)}" title="${esc(SEV_LABEL[flag.severity])}"></span>`;
        html += `<button class="row-item ${flag.frame === S.frame ? 'current' : ''}" data-action="goto" data-i="${S.flags.indexOf(flag)}" data-f="${flag.frame}" title="${esc(flag.value)}">`
          + `<span class="f">${flag.frame}</span><span class="t"><b>${esc(flag.label)}</b><span>${esc(RULE_LABEL[first.rule] || first.text)}</span></span>${tag}</button>`;
      });
      html += '</div>';
    }
    return html + renderScan();
  }

  function renderScan() {
    const ps = S.ps;
    let html = '<section class="scan"><div class="scan-title">PointSnap';
    html += ps.checked ? `<span class="scan-state ${ps.online ? 'on' : ''}">${ps.online ? 'đang chạy' : 'chưa bật'}</span>` : '';
    html += '<span class="grow"></span>'
      + `<button class="icon-btn small ghost" data-action="refresh" title="Đọc lại cờ trên CVAT và kết quả PointSnap" aria-label="Làm mới">${ICON.refresh}</button></div>`;
    if (!ps.checked) return `${html}<div class="muted small">Đang tìm PointSnap…</div></section>`;
    if (!ps.online) {
      return `${html}<div class="muted small">Chạy <code>pointsnap ui</code> để quét lại, gắn cờ và ghi Đúng / Báo nhầm ngay tại đây.</div></section>`;
    }
    if (ps.starting) return `${html}<div class="muted small">Đang bắt đầu quét…</div></section>`;
    if (ps.active) {
      const pct = Math.max(3, Math.min(100, Number(ps.active.progress) || 0));
      return `${html}<div class="small">${esc(ps.active.message || 'Đang quét…')}</div><div class="progress"><i style="width:${pct}%"></i></div></section>`;
    }
    const run = ps.run;
    if (run && run.summary) {
      const s = run.summary;
      // started_at là giờ UTC (ISO): đổi sang giờ máy, dạng 09/10 08:43.
      const t = new Date(run.started_at);
      const pad = (n) => String(n).padStart(2, '0');
      const when = Number.isNaN(t.getTime()) ? '' : `${pad(t.getDate())}/${pad(t.getMonth() + 1)} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      const reviewed = Object.keys(run.reviews || {}).length;
      html += `<div class="small">Lần quét gần nhất <span class="mono">${esc(when)}</span></div>`
        + `<div class="small muted">${s.num_errors ?? 0} Lỗi · ${s.num_warnings ?? 0} Cảnh báo${reviewed ? ` · đã xem ${reviewed}` : ''}</div>`;
      const stale = S.flags.filter((f) => !reviewState(f)).length;
      if (stale && !S.flags.some((f) => f.fromScan)) html += `<div class="small warn-text">${stale} cờ trên CVAT không có trong lần quét này. Quét + gắn cờ để đồng bộ.</div>`;
    } else if (ps.project) {
      html += `<div class="small muted">Job này chưa được quét trong dự án ${esc(ps.project.name)}.</div>`;
    } else {
      html += `<div class="small muted">Chưa có dự án PointSnap nối với ${esc(location.origin)}.</div>`;
    }
    if (S.confirmFlag) {
      html += note('warn', 'Gắn cờ sẽ ghi lên nhãn của job. <b>Save</b> trên CVAT trước; gắn cờ xong thì tải lại trang.',
        [{ action: 'scan-flag-go', text: 'Gắn cờ' }, { action: 'scan-flag-cancel', text: 'Thôi' }]);
    } else {
      html += `<div class="scan-actions"><button class="btn" data-action="scan" ${ps.project ? '' : 'disabled'}>Quét lại</button>`
        + `<button class="btn" data-action="scan-flag" ${ps.project ? '' : 'disabled'}>Quét + gắn cờ</button></div>`;
    }
    return `${html}</section>`;
  }

  // ---------------------------------------------------------------- sự kiện

  function onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const flag = button.dataset.i !== undefined ? S.flags[Number(button.dataset.i)] : null;
    switch (action) {
      case 'collapse':
        S.collapsed = !S.collapsed;
        saveLocal({ panelCollapsed: S.collapsed });
        render();
        break;
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'goto':
        S.tab = 'now';
        goTo(Number(button.dataset.f), flag);
        break;
      case 'filter-on': turnFilterOn(false); break;
      case 'filter-off': turnFilterOff(); break;
      case 'highlight': highlight(flag, 1); break;
      case 'camera': showCamera(flag); break;
      case 'review-ok': review(flag, 'ok'); break;
      case 'review-fp': review(flag, 'fp'); break;
      case 'tab':
        S.tab = button.dataset.k;
        render();
        break;
      case 'pick': {
        const here = flagsAt(S.frame);
        if (!here.length) break;
        const { index } = currentFlag();
        S.pick = ((((index < 0 ? S.pick : index) + Number(button.dataset.d)) % here.length) + here.length) % here.length;
        // Thẻ đi theo lựa chọn mới (bỏ box đang chọn), rồi làm sáng box đó trên CVAT.
        S.active = null;
        render();
        highlight(here[S.pick], 0);
        break;
      }
      case 'list-filter':
        S.listFilter = button.dataset.k;
        render();
        break;
      case 'scan': startScan(false); break;
      case 'scan-flag':
        S.confirmFlag = true;
        render();
        break;
      case 'scan-flag-go': startScan(true); break;
      case 'scan-flag-cancel':
        S.confirmFlag = false;
        render();
        break;
      case 'refresh':
        S.notice = null;
        loadFlags(S.sid);
        loadPointSnap(S.sid);
        break;
      case 'reload': location.reload(); break;
      case 'open-web': openWeb(); break;
      case 'dismiss':
        S.notice = null;
        render();
        break;
      case 'manual-rule': root.PointSnapManualController?.select(Number(button.dataset.n)); break;
      case 'manual-toggle': root.PointSnapManualController?.toggle(button.dataset.k); break;
      case 'manual-action': root.PointSnapManualController?.action(button.dataset.act, button.dataset.param); break;
      default:
        break;
    }
  }

  /** Mở web PointSnap (trang Kết quả) trong một tab cố định; web tự nhận ra tab CVAT này đang mở job. */
  function openWeb() {
    let base = 'http://127.0.0.1:8765';
    try {
      const url = new URL(settings.pointsnapUrl || base);
      if (['http:', 'https:'].includes(url.protocol)) base = url.origin;
    } catch (_) {
      // Địa chỉ trong Tùy chọn hỏng: dùng mặc định.
    }
    window.open(`${base}/app#results`, 'pointsnap-web', 'noopener');
  }

  function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  // Phím , . (như tua từng khung trên YouTube) và [ ]: CVAT không dùng các phím này (J là Join, K là Switch keyframe nên tránh).
  // Nhận theo cả mã phím lẫn ký tự; , . không bị bộ gõ tiếng Việt kiểu Telex đổi thành chữ như [ ] (ư, ơ).
  const NAV_KEYS = { Period: 1, BracketRight: 1, '.': 1, ']': 1, Comma: -1, BracketLeft: -1, ',': -1, '[': -1 };
  window.addEventListener('keydown', (event) => {
    if (!S.job || !S.frames.length || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')) return;
    const dir = NAV_KEYS[event.code] || NAV_KEYS[event.key] || 0;
    if (!dir) return;
    event.preventDefault();
    event.stopPropagation();
    step(dir);
  }, true);

  // Lắng nghe dữ liệu đo đạc thời gian thực từ 3D Hook
  if (typeof window !== 'undefined') {
    window.addEventListener('POINTSNAP_3D_TELEMETRY', (e) => {
      if (e.detail) {
        S.telemetry = e.detail;
      }
    });

    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'POINTSNAP_3D_TELEMETRY' && e.data.detail) {
        S.telemetry = e.data.detail;
      }
    });
  }

  root.PointSnapPanel = {
    state: S,
    onRoute,
    step,
    goTo,
    turnFilterOn,
    render,
    clearGhostTarget,
  };

  loadSettings().then(() => {
    onRoute();
    setInterval(onRoute, 500);
  });
})(globalThis);
