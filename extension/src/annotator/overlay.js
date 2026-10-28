/*
 * Lớp vẽ SVG chồng lên 4 view của CVAT, chiếu bằng chính camera của CVAT. Chỉ vẽ, không đụng scene hay nhãn.
 * Vẽ: đường mặt đất tại điểm tiếp xúc + số ΔZ, điểm của vật (trong box: xanh, lòi ra ngoài: đỏ), khoảng hở từng mặt
 * nhìn thấy, khung và phần chồng của box đang chồng lấn (đỏ: cần xem, xám: spec cho phép), box sau khi sửa của bản
 * xem trước (nét đứt xanh dương).
 * Màu một nghĩa: xanh lá = ổn / điểm trong box, cam = cần xem, đỏ = lỗi / điểm lòi; mặt đất xanh dương để không lẫn với "ổn".
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox;
  const COLORS = {
    ok: '#15803d', float: '#c2410c', sink: '#b91c1c', ground: '#3b82f6', ghost: '#60a5fa',
    inside: '#22c55e', outside: '#ef4444', overlap: '#dc2626', allowed: '#94a3b8',
  };
  const layers = new Map();
  let lastKey = '';

  function project(point, camera, rect) {
    const m = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
    const apply = (e, v) => [0, 1, 2, 3].map((i) => e[i] * v[0] + e[i + 4] * v[1] + e[i + 8] * v[2] + e[i + 12] * v[3]);
    const v = apply(p, apply(m, [...point, 1]));
    if (!v.every(Number.isFinite) || Math.abs(v[3]) < 1e-10 || (camera.isPerspectiveCamera && v[3] <= 0)) return null;
    const ndc = v.map((x) => x / v[3]);
    if (ndc[2] < -1 || ndc[2] > 1) return null;
    return [(ndc[0] + 1) * rect.width / 2, (1 - ndc[1]) * rect.height / 2];
  }

  /**
   * Khung của view nếu view đang thật sự nhìn thấy, không thì null. Phóng to một view (nút fullscreen của CVAT) chỉ
   * đặt view đó đè lên 3 view kia, 3 view kia vẫn giữ chỗ cũ bên dưới; lớp vẽ nằm trên cùng nên phải tự ẩn view bị che.
   * Thử 5 điểm trong view: điểm nào chạm vào chính view (canvas hoặc nút / nhãn của CVAT trên view) là còn thấy.
   */
  function visibleRect(el) {
    if (!el.offsetParent || el.offsetWidth <= 25) return null;
    const rect = el.getBoundingClientRect(), box = el.closest('.cvat-canvas-grid-item') || el.parentElement;
    const seen = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]].some(([fx, fy]) => {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      return hit && (hit === el || box.contains(hit));
    });
    return seen ? rect : null;
  }

  function layerFor(view) {
    let svg = layers.get(view);
    if (svg?.isConnected) return svg;
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;pointer-events:none;z-index:1001;overflow:hidden;font:600 12px system-ui,sans-serif';
    document.body.appendChild(svg);
    layers.set(view, svg);
    return svg;
  }

  function clear() {
    for (const svg of layers.values()) svg.remove();
    layers.clear();
    lastKey = '';
  }

  const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  function gapColor(gapM, okM) {
    if (Math.abs(gapM) <= okM) return COLORS.ok;
    return gapM > 0 ? COLORS.float : COLORS.sink;
  }

  /**
   * Đường mặt đất dọc trục `axis` (0: dài, 1: rộng) của box, kéo dài `span` mỗi phía, theo độ dốc của mặt đất đo dưới
   * hai đầu box (`ground`: [x, y, z] dưới 4 góc đáy, thứ tự `B.corners`). View Side / Front của CVAT xoay theo cả
   * pitch / roll của box, nên đường vẽ đúng độ cao thật cho thấy box nghiêng lệch mặt đất.
   */
  function groundLine(box, ground, axis, span) {
    const yaw = box.rotation[2], dir = axis === 0 ? [Math.cos(yaw), Math.sin(yaw)] : [-Math.sin(yaw), Math.cos(yaw)];
    const ends = (axis === 0 ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]]).map((pair) => {
      const pts = pair.map((i) => ground[i]);
      return [0, 1, 2].map((k) => pts.reduce((sum, q) => sum + q[k], 0) / pts.length);
    });
    const along = (q) => (q[0] - box.center[0]) * dir[0] + (q[1] - box.center[1]) * dir[1];
    const [a, b] = ends, ta = along(a), tb = along(b), slope = Math.abs(tb - ta) > 1e-6 ? (b[2] - a[2]) / (tb - ta) : 0;
    return [-span, span].map((t) => [box.center[0] + dir[0] * t, box.center[1] + dir[1] * t, a[2] + slope * (t - ta)]);
  }

  /** Tâm mặt `face` ({ axis, sign }) của box, hệ point cloud. */
  function faceCenter(box, face) {
    const local = [0, 0, 0];
    local[face.axis] = face.sign * box.dims[face.axis] / 2;
    return B.toWorld(box, local);
  }

  const gapText = (f) => `${f.name} ${f.gapM >= 0 ? 'dư' : 'lòi'} ${Math.abs(Math.round(f.gapM * 100))} cm`;

  /**
   * `scene`: { ctx, box, contact, okM, insidePoints, outsidePoints: [[x, y, z]], faces: [{ name, axis, sign, gapM }],
   * overlaps: [{ box, ratio, allowed }], ghost: box | null }. Chỉ vẽ lại khi box, số đo hoặc camera / kích thước view đổi.
   */
  function render(scene) {
    const { ctx, box, contact, okM, insidePoints, outsidePoints, faces, overlaps, ghost = null } = scene;
    const rects = {};
    for (const view of Object.keys(ctx.views)) {
      rects[view] = visibleRect(ctx.views[view].renderer.domElement);
    }
    const key = JSON.stringify([box, contact && [contact.groundZ, contact.gapM], insidePoints.length, outsidePoints.length,
      faces.map((f) => f.gapM), overlaps.map((o) => [o.ratio, o.allowed]), ghost,
      ...Object.entries(ctx.views).map(([v, view]) => [rects[v] && [rects[v].left, rects[v].top, rects[v].width, rects[v].height],
        ...view.camera.projectionMatrix.elements, ...view.camera.matrixWorldInverse.elements])]);
    if (key === lastKey) return;
    lastKey = key;

    for (const [view, { camera }] of Object.entries(ctx.views)) {
      const svg = layerFor(view), rect = rects[view];
      if (!rect) { svg.style.display = 'none'; continue; }
      Object.assign(svg.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      const p = (q) => project(q, camera, rect), parts = [];
      const line = (a, b, color, dash = '', width = 1.6) => {
        const x = p(a), y = p(b);
        if (x && y) parts.push(`<path d="M${x.join(',')}L${y.join(',')}" stroke="${color}" stroke-width="${width}" fill="none"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
      };
      const label = (q, text, color) => {
        const s = p(q);
        if (!s) return;
        const x = Math.max(4, Math.min(rect.width - 120, s[0] + 6)), y = Math.max(14, Math.min(rect.height - 6, s[1] - 6));
        parts.push(`<text x="${x}" y="${y}" fill="${color}" stroke="#fff" stroke-width="3" paint-order="stroke">${escapeText(text)}</text>`);
      };

      if (ghost) {
        const cs = B.corners(ghost);
        for (const [a, b] of B.EDGES) line(cs[a], cs[b], COLORS.ghost, '5 3', 1.8);
      }

      for (const o of overlaps) {
        const color = o.allowed ? COLORS.allowed : COLORS.overlap, cs = B.corners(o.box);
        for (const [a, b] of B.EDGES) line(cs[a], cs[b], color, o.allowed ? '4 3' : '', o.allowed ? 1.4 : 2.4);
        if (view === 'top' || view === 'perspective') {
          // Phần chồng nhìn từ trên, tô ở độ cao đáy box đang chọn.
          const z = B.bottomZ(box);
          const area = B.clipConvex(B.footprint(box), B.footprint(o.box)).map(([x, y]) => p([x, y, z]));
          if (area.length > 2 && area.every(Boolean)) {
            parts.push(`<polygon points="${area.map((q) => q.join(',')).join(' ')}" fill="${color}" fill-opacity=".25" stroke="none"/>`);
          }
        }
        label([o.box.center[0], o.box.center[1], o.box.center[2] + o.box.dims[2] / 2], `chồng ${o.ratio < 0.01 ? '<1' : Math.round(o.ratio * 100)}%${o.allowed ? ' (được phép)' : ''}`, color);
      }

      if (contact) {
        const color = gapColor(contact.gapM, okM);
        // Góc không đo được đất thì lấy mặt đất thấp nhất, như bản cũ vẽ cả đường.
        const ground = B.corners(box).slice(0, 4).map(([x, y], i) => [x, y, contact.groundZ[i] ?? contact.contactZ]);
        const bottomCenter = B.toWorld(box, [0, 0, -box.dims[2] / 2]);
        const contactCenter = [bottomCenter[0], bottomCenter[1], ground.reduce((sum, q) => sum + q[2], 0) / 4];
        const text = Math.abs(contact.gapM) <= okM ? '✓ sát đất' : `${contact.gapM > 0 ? '+' : ''}${Math.round(contact.gapM * 100)} cm`;
        if (view === 'side' || view === 'front') {
          const [a, b] = groundLine(box, ground, view === 'side' ? 0 : 1, Math.max(box.dims[0], 4) * 2);
          line(a, b, COLORS.ground, '8 4', 2);
        } else if (view === 'perspective' || view === 'top') {
          ground.forEach((q, i) => line(q, ground[(i + 1) % 4], COLORS.ground, '6 4', 1.6));
        }
        line(bottomCenter, contactCenter, color, '', 2);
        // Nhìn từ trên thì đáy và tâm box trùng nhau: nhãn ΔZ ở đó đè lên nhãn khoảng hở, nên chỉ ghi ở các view còn lại.
        if (view !== 'top') label(bottomCenter, text, color);
      }

      const dots = (points, color, width) => {
        const d = points.map(p).filter(Boolean).map((s) => `M${s[0].toFixed(1)},${s[1].toFixed(1)}h.1`).join('');
        if (d) parts.push(`<path d="${d}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`);
      };
      dots(insidePoints, COLORS.inside, 3);
      dots(outsidePoints, COLORS.outside, 4.5);

      // Khoảng hở từng mặt LiDAR nhìn thấy: ở view nhìn thấy mặt đó (trên: dài / rộng, hông: dài / nóc, trước: rộng / nóc).
      const shownAxes = { top: [0, 1], side: [0, 2], front: [1, 2], perspective: [0, 1, 2] }[view];
      for (const f of faces) {
        if (!shownAxes.includes(f.axis)) continue;
        const color = f.gapM < -0.05 ? COLORS.outside : f.gapM > 0.3 ? COLORS.float : COLORS.ok;
        label(faceCenter(box, f), gapText(f), color);
      }
      svg.innerHTML = parts.join('');
    }
  }

  root.PointSnapAnnotatorOverlay = { render, clear, project };
})(globalThis);
