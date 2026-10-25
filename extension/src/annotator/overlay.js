/*
 * Lớp vẽ SVG chồng lên 4 view của CVAT, chiếu bằng chính camera của CVAT. Chỉ vẽ, không đụng scene hay nhãn.
 * Vẽ: đường mặt đất tại điểm tiếp xúc + số ΔZ, điểm của vật (trong box: xanh, lòi ra ngoài: đỏ), khoảng hở từng mặt
 * nhìn thấy, khung và phần chồng của box đang chồng lấn (đỏ: cần xem, xám: spec cho phép).
 */
(function (root) {
  'use strict';

  const B = root.PointSnapBox;
  const COLORS = {
    ok: '#15803d', float: '#c2410c', sink: '#b91c1c', ground: '#15803d',
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

  /** Đường mặt đất dọc trục `axis` (0: dài, 1: rộng) của box, tại độ cao tiếp xúc. */
  function groundLine(box, contactZ, axis, span) {
    const yaw = box.rotation[2], dir = axis === 0 ? [Math.cos(yaw), Math.sin(yaw)] : [-Math.sin(yaw), Math.cos(yaw)];
    return [-span, span].map((t) => [box.center[0] + dir[0] * t, box.center[1] + dir[1] * t, contactZ]);
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
   * overlaps: [{ box, ratio, allowed }] }. Chỉ vẽ lại khi box, số đo hoặc camera / kích thước view đổi.
   */
  function render(scene) {
    const { ctx, box, contact, okM, insidePoints, outsidePoints, faces, overlaps } = scene;
    const rects = {};
    for (const view of Object.keys(ctx.views)) {
      const el = ctx.views[view].renderer.domElement;
      rects[view] = el.offsetParent && el.offsetWidth > 25 ? el.getBoundingClientRect() : null;
    }
    const key = JSON.stringify([box, contact && [contact.contactZ, contact.gapM], insidePoints.length, outsidePoints.length,
      faces.map((f) => f.gapM), overlaps.map((o) => [o.ratio, o.allowed]),
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
        label([o.box.center[0], o.box.center[1], o.box.center[2] + o.box.dims[2] / 2], `chồng ${Math.round(o.ratio * 100)}%${o.allowed ? ' (được phép)' : ''}`, color);
      }

      if (contact) {
        const color = gapColor(contact.gapM, okM);
        const bottomCenter = [box.center[0], box.center[1], B.bottomZ(box)];
        const contactCenter = [box.center[0], box.center[1], contact.contactZ];
        const text = Math.abs(contact.gapM) <= okM ? '✓ sát đất' : `${contact.gapM > 0 ? '+' : ''}${Math.round(contact.gapM * 100)} cm`;
        if (view === 'side' || view === 'front') {
          const [a, b] = groundLine(box, contact.contactZ, view === 'side' ? 0 : 1, Math.max(box.dims[0], 4) * 2);
          line(a, b, COLORS.ground, '8 4', 2);
        } else if (view === 'perspective' || view === 'top') {
          const ring = B.footprint(box).map(([x, y]) => [x, y, contact.contactZ]);
          ring.forEach((q, i) => line(q, ring[(i + 1) % 4], COLORS.ground, '6 4', 1.6));
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
