/*
 * Cầu nối duy nhất tới nội bộ CVAT (MAIN world). Đối chiếu mã nguồn CVAT (cvat-ui annotation-actions.ts,
 * cvat-core annotations-collection.ts / track.ts, cvat-canvas3d canvas3dView.ts):
 * - store lấy qua `cvatUI.registerComponent` (API plugin chính thức);
 * - ghi bằng ObjectState của cvat-core: gán `points` / `keyframe` rồi lưu (`saveGroup`): thao tác một frame là một bước
 *   Undo của CVAT; thao tác nhiều keyframe tạm dừng lịch sử CVAT và PointSnap tự giữ bản ghi để hoàn tác;
 * - vẽ lại bằng action FETCH_ANNOTATIONS_SUCCESS, giống `fetchAnnotationsAsync` của CVAT.
 * Không gọi REST, không tự Save: thay đổi nằm trong bộ nhớ trang cho tới khi người dùng bấm Save của CVAT.
 * Khi CVAT khác cấu trúc mong đợi thì trả null / báo lỗi, không đoán.
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox;
  const VIEWS = ['perspective', 'top', 'side', 'front'];
  let store = null;

  function connect(onReady) {
    const tryRegister = () => {
      if (store || !root.cvatUI?.registerComponent) return false;
      root.cvatUI.registerComponent(({ store: s }) => {
        store = s;
        onReady(s);
        return { name: 'PointSnap Annotator', destructor() {} };
      });
      return true;
    };
    if (tryRegister()) return;
    document.addEventListener('plugins.ready', tryRegister, { once: true });
    const timer = setInterval(() => { if (tryRegister() || store) clearInterval(timer); }, 500);
  }

  const annotation = () => store?.getState?.()?.annotation;

  /** Ngữ cảnh job 3D đang mở; null khi chưa mở job 3D, đang tải frame hoặc canvas không đúng cấu trúc mong đợi. */
  function context() {
    const a = annotation(), canvas = a?.canvas?.instance;
    if (!canvas?.html || !a.job?.instance || a.player?.frame?.fetching) return null;
    const dom = canvas.html(), views = canvas.view?.views;
    const ok = views && VIEWS.every((k) => dom[k]?.getDrawnObjects && views[k]?.renderer?.domElement === dom[k]
      && views[k]?.camera?.projectionMatrix?.elements?.length === 16);
    if (!ok) return null;
    return { job: a.job.instance, frame: a.player.frame.number, canvas, dom, views };
  }

  /** Mảng states gốc của Redux: đổi tham chiếu khi CVAT cập nhật nhãn của frame. */
  const rawStates = () => annotation()?.annotations?.states || null;
  const currentFrame = () => annotation()?.player?.frame?.number ?? null;

  function frameStates() {
    return (rawStates() || []).filter((s) => s.shapeType === 'cuboid');
  }

  const activeClientId = () => annotation()?.annotations?.activatedStateID ?? null;
  const isSaving = () => !!annotation()?.annotations?.saving?.uploading;

  /** Thuộc tính của ObjectState theo tên (CVAT lưu theo id thuộc tính). */
  function attributesOf(state) {
    const specs = state.label?.attributes || [];
    const out = {};
    for (const [id, value] of Object.entries(state.attributes || {})) {
      out[specs.find((a) => String(a.id) === id)?.name || id] = value;
    }
    return out;
  }

  /** Box đang hiển thị của một object, đọc từ mesh để theo kịp lúc đang kéo (trước khi Redux cập nhật). */
  function liveBox(ctx, state) {
    const record = ctx.dom.perspective.getDrawnObjects().find((r) => r.state?.clientID === state.clientID);
    const mesh = record?.cuboid?.perspective;
    if (mesh) {
      const box = { center: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z], dims: [mesh.scale.x, mesh.scale.y, mesh.scale.z] };
      if (B.isValidBox(box)) return box;
    }
    return B.fromCvatPoints(state.points);
  }

  /** Đối tượng point cloud three.js của frame (4 view dùng chung geometry; CVAT thêm vào scene không biến đổi). */
  function cloudObject(ctx) {
    return ctx.views.perspective.scene?.children?.find((o) => o.isPoints && o.geometry?.attributes?.position?.array) || null;
  }

  /** Mảng vị trí điểm của point cloud đang hiển thị, cùng hệ tọa độ với box. */
  function pointCloud(ctx) {
    return cloudObject(ctx)?.geometry.attributes.position.array || null;
  }

  function describe(state, frame) {
    return {
      frame,
      state,
      box: B.fromCvatPoints(state.points),
      outside: !!state.outside,
      occluded: !!state.occluded,
      attrsKey: JSON.stringify(state.attributes || {}),
    };
  }

  /** Mọi keyframe của track chứa `state`, đi theo chuỗi keyframes.first → next của cvat-core. */
  async function trackKeyframes(job, state) {
    if (state.objectType !== 'track' || !state.keyframes) return [];
    const out = [];
    // Task chia nhiều job: track cắt theo đoạn có thể giữ keyframe ngoài đoạn của job, mà annotations.get thì từ chối frame
    // đó. Bắt đầu từ frame đầu của job khi keyframe đầu nằm trước nó; dừng ở cuối job.
    const inJob = (f) => !(f < job.startFrame) && !(f > job.stopFrame);
    let frame = state.keyframes.first < job.startFrame ? job.startFrame : state.keyframes.first;
    while (Number.isInteger(frame) && inJob(frame)) {
      const states = await job.annotations.get(frame, true, []);
      const current = states.find((s) => s.clientID === state.clientID);
      if (!current) break;
      if (current.keyframe) out.push(describe(current, frame));
      const next = current.keyframes?.next;
      if (!Number.isInteger(next) || next <= frame) break;
      frame = next;
    }
    return out.filter((k) => k.box);
  }

  /** Vẽ lại frame hiện tại theo bộ nhớ cvat-core, như `fetchAnnotationsAsync` của CVAT. */
  async function refresh() {
    const ctx = context();
    if (!ctx) return;
    const s = store.getState();
    // shortcut: không nạp lại lớp Ground Truth (chỉ có khi bật "Show ground truth"); bật lớp đó thì đổi frame để CVAT nạp lại.
    const states = await ctx.job.annotations.get(ctx.frame, s.settings?.workspace?.showAllInterpolationTracks, s.annotation.annotations.filters);
    const history = await ctx.job.actions.get();
    store.dispatch({ type: 'FETCH_ANNOTATIONS_SUCCESS', payload: { states, intervals: [], history } });
  }

  const snapshot = (state) => ({ points: state.points.slice(), keyframe: state.keyframe !== false });
  const samePoints = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

  /**
   * Lưu một nhóm ObjectState. Cả nhóm ở một frame và CVAT có `saveStates`: một giao dịch, Ctrl+Z hoàn tác cả nhóm.
   * Còn lại (nhiều keyframe, hoặc CVAT 2.75 chưa có `saveStates`): mỗi `save()` là một bước Undo và lịch sử chỉ giữ 32
   * bước, nên một thao tác 38 keyframe vừa không Undo hết được vừa đẩy mất lịch sử của annotator. Khi đó tạm dừng ghi
   * lịch sử CVAT trong lúc lưu, và PointSnap giữ bản ghi để tự hoàn tác (`undoEdits`).
   */
  async function saveGroup(job, states) {
    // CVAT 2.77 có `saveStates` nhưng một giao dịch lịch sử chỉ được chứa thay đổi của một frame ("All history actions
    // in a transaction must target the same frame"): thao tác nhiều keyframe đi đường tạm dừng lịch sử bên dưới.
    if (typeof job.annotations.saveStates === 'function' && new Set(states.map((s) => s.frame)).size <= 1) {
      await job.annotations.saveStates(states);
      return 'cvat';
    }
    await job.actions.freeze(true);
    try {
      for (const state of states) await state.save();
    } finally {
      await job.actions.freeze(false);
    }
    return 'pointsnap';
  }

  /**
   * Ghi các thay đổi `edits` ({ frame, box } hoặc { frame, keyframe: false }) cho các keyframe trong `byFrame`.
   * Trả về { saved, locked, undo: 'cvat' | 'pointsnap', record } — `record` dùng cho `undoEdits` khi undo = 'pointsnap'.
   */
  async function applyEdits(job, byFrame, edits) {
    const states = [], record = [];
    let locked = 0;
    for (const edit of edits) {
      const state = byFrame.get(edit.frame)?.state;
      if (!state) continue;
      if (state.lock) { locked += 1; continue; }
      const before = snapshot(state);
      if (edit.box) state.points = B.toCvatPoints(edit.box, state.points);
      if (edit.keyframe === false) state.keyframe = false;
      states.push(state);
      record.push({ frame: edit.frame, clientID: state.clientID, before, after: snapshot(state) });
    }
    const undo = await saveGroup(job, states);
    await refresh();
    return { saved: states.length, locked, undo, record };
  }

  /**
   * Hoàn tác một lần `applyEdits`. Frame nào đã bị sửa tiếp sau đó (khác trạng thái PointSnap đã ghi) thì giữ nguyên,
   * không ghi đè công của annotator. Trả về { restored, skipped }.
   */
  async function undoEdits(job, record) {
    const states = [];
    let skipped = 0;
    for (const entry of record) {
      const state = (await job.annotations.get(entry.frame, true, [])).find((s) => s.clientID === entry.clientID);
      const current = state && snapshot(state);
      const untouched = current && current.keyframe === entry.after.keyframe
        && (!current.keyframe || samePoints(current.points, entry.after.points));
      if (!untouched || state.lock) { skipped += 1; continue; }
      if (entry.before.keyframe) state.points = entry.before.points;
      else state.keyframe = false;
      states.push(state);
    }
    await saveGroup(job, states);
    await refresh();
    return { restored: states.length, skipped };
  }

  /**
   * Chọn object như khi người dùng bấm vào box. `focus`: đưa camera tới box bằng `focusObjectByClientId` của canvas3d
   * (CVAT tự chọn khoảng cách / góc vừa box), dùng khi nhảy sang box khác; khi đổi frame thì dùng `shiftCamera`.
   */
  function select(ctx, clientID, focus = false) {
    ctx.dom.perspective.dispatchEvent(new CustomEvent('canvas.selected', { detail: { clientID } }));
    if (!focus) return;
    const view = ctx.canvas.view;
    if (view?.focusObjectByClientId) view.focusObjectByClientId(clientID, true);
    else ctx.canvas.focus?.(clientID);
  }

  /**
   * Dời camera phối cảnh một đoạn `delta` [dx, dy, dz] (hệ point cloud), giữ nguyên góc nhìn và độ zoom người dùng đang
   * dùng. Dùng để box đang khoá đứng yên trên màn hình khi đổi frame. Trả về false khi CVAT không có camera-controls.
   */
  function shiftCamera(ctx, delta) {
    const view = ctx.views.perspective, controls = view.controls;
    if (!controls?.getTarget || !controls.getPosition || !controls.setLookAt || !delta.every(Number.isFinite)) return false;
    const target = controls.getTarget(view.camera.position.clone()), position = controls.getPosition(view.camera.position.clone());
    const [dx, dy, dz] = delta;
    controls.setLookAt(position.x + dx, position.y + dy, position.z + dz, target.x + dx, target.y + dy, target.z + dz, false);
    return true;
  }

  const subscribe = (listener) => store.subscribe(listener);

  /** Tình trạng kết nối cho popup: đã nhận store CVAT chưa, đang mở job 3D chưa, CVAT có Undo gộp (saveStates) không. */
  function health() {
    const ctx = store ? context() : null;
    return {
      store: !!store,
      job3d: !!ctx,
      saveStates: ctx ? typeof ctx.job.annotations.saveStates === 'function' : null,
    };
  }

  root.PointSnapCvatAdapter = {
    connect, context, rawStates, currentFrame, frameStates, activeClientId, isSaving, attributesOf, liveBox, cloudObject, pointCloud,
    trackKeyframes, applyEdits, undoEdits, refresh, select, shiftCamera, subscribe, health,
  };
})(globalThis);
