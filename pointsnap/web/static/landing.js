/*
 * Trang giới thiệu PointSnap 3D (landing): đổi theme, trạng thái máy chủ local, phím Enter vào ứng dụng,
 * và hình minh hoạ point cloud — box lơ lửng / lệch hướng được kéo khớp về vị trí đúng.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Theme dùng chung khóa với ứng dụng ----
  const themeBtn = document.getElementById('landing-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('pointsnap_theme', next); } catch (_) {}
    });
  }

  // ---- Enter (khi không gõ trong ô nhập) thì vào ứng dụng ----
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.closest('a, button, input, textarea, select') || t.isContentEditable)) return;
    window.location.href = '/app';
  });

  // ---- Trạng thái máy chủ và số dự án ----
  const origin = document.getElementById('footer-origin');
  if (origin) origin.textContent = window.location.host || '127.0.0.1:8765';

  fetch('/api/projects', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((projects) => {
      const n = Array.isArray(projects) ? projects.length : 0;
      document.getElementById('server-status').textContent =
        n ? `Máy chủ đang chạy · ${n} dự án sẵn sàng` : 'Máy chủ đang chạy · chưa có dự án';
      const hint = document.getElementById('project-hint');
      if (hint) {
        hint.textContent = n
          ? `Bạn có ${n} dự án. Mở ứng dụng để quét và xem kết quả mới nhất.`
          : 'Chưa có dự án nào — bước 1 ở trên chỉ mất một phút.';
      }
    })
    .catch(() => {
      const pulse = document.querySelector('.pulse');
      if (pulse) pulse.classList.add('off');
      document.getElementById('server-status').textContent = 'Không đọc được trạng thái máy chủ';
    });

  // ---- Hình minh hoạ point cloud ----
  const canvas = document.getElementById('hero-canvas');
  const hudState = document.getElementById('hud-state');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  // Hạt giống cố định để hình giống nhau mỗi lần mở.
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const gauss = () => (rand() + rand() + rand() - 1.5) * 0.66;

  // Mặt đất: các vòng quét LiDAR quanh xe thu (đặt lệch về sau vật).
  const ground = [];
  for (let r = 2.6; r < 13; r *= 1.12) {
    for (let a = 0; a < Math.PI * 2; a += 0.022 + rand() * 0.02) {
      const x = -7 + Math.cos(a) * r, y = -2 + Math.sin(a) * r;
      if (Math.abs(x) > 9 || Math.abs(y) > 7) continue;
      ground.push([x + gauss() * 0.05, y + gauss() * 0.05, gauss() * 0.015]);
    }
  }

  // Vật: một chiếc xe (thân dưới + cabin), chỉ lấy mặt nhìn thấy từ LiDAR (phía -x, -y và nóc).
  const TRUE_BOX = { c: [0, 0, 0.78], d: [4.6, 1.95, 1.56], yaw: 0 };
  const car = [];
  function addFace(n, fn) { for (let i = 0; i < n; i++) car.push(fn(rand(), rand())); }
  const L = 4.4, W = 1.85;
  addFace(260, (u, v) => [-L / 2 + u * L, -W / 2 + gauss() * 0.02, 0.15 + v * 0.8]);               // hông xe
  addFace(110, (u, v) => [-L / 2 + gauss() * 0.02, -W / 2 + u * W, 0.15 + v * 0.8]);               // đuôi xe
  addFace(140, (u, v) => [-L / 2 + u * L, -W / 2 + v * W, 0.95 + gauss() * 0.02]);                 // nắp / capo
  addFace(150, (u, v) => [-1.3 + u * 2.3, -0.8 + v * 1.6, 1.5 + gauss() * 0.02]);                  // nóc cabin
  addFace(120, (u, v) => [-1.3 + u * 2.3, -0.8 + gauss() * 0.02, 0.95 + v * 0.55]);                // kính hông
  addFace(40, (u, v) => [-L / 2 + 0.6 + u * 0.5, -W / 2 - 0.02, 0.1 + v * 0.35]);                  // bánh sau
  addFace(40, (u, v) => [L / 2 - 1.1 + u * 0.5, -W / 2 - 0.02, 0.1 + v * 0.35]);                   // bánh trước

  const WRONG_BOX = { c: [0.35, 0.25, 1.23], d: [4.2, 1.8, 1.5], yaw: 0.26 };

  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  let W_px = 0, H_px = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W_px = canvas.clientWidth; H_px = canvas.clientHeight;
    canvas.width = Math.round(W_px * dpr); canvas.height = Math.round(H_px * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => { resize(); if (reduceMotion) requestAnimationFrame(frame); });
  resize();

  function project(p, cam) {
    const [x, y, z] = p;
    const ca = Math.cos(cam), sa = Math.sin(cam);
    const rx = x * ca - y * sa;
    const ry = x * sa + y * ca;
    const s = Math.min(W_px, H_px) / 7.4;
    return [W_px / 2 + rx * s, H_px * 0.6 + ry * s * 0.42 - z * s * 0.92, ry];
  }

  function corners(b) {
    const [cx, cy, cz] = b.c, [l, w, h] = b.d;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const out = [];
    for (const dz of [-h / 2, h / 2]) {
      for (const [dx, dy] of [[l / 2, w / 2], [l / 2, -w / 2], [-l / 2, -w / 2], [-l / 2, w / 2]]) {
        out.push([cx + dx * c - dy * s, cy + dx * s + dy * c, cz + dz]);
      }
    }
    return out;
  }
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

  function drawBox(b, cam, color, opts) {
    const pts = corners(b).map((p) => project(p, cam));
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = opts.width || 2;
    ctx.globalAlpha = opts.alpha ?? 1;
    if (opts.dash) ctx.setLineDash(opts.dash);
    if (opts.fill) {
      ctx.fillStyle = color; ctx.globalAlpha = (opts.alpha ?? 1) * 0.08;
      ctx.beginPath(); [4, 5, 6, 7].forEach((i, k) => (k ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]))); ctx.fill();
      ctx.globalAlpha = opts.alpha ?? 1;
    }
    ctx.beginPath();
    EDGES.forEach(([a, z]) => { ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[z][0], pts[z][1]); });
    ctx.stroke();
    // Mũi tên hướng đầu box ở mặt đáy.
    ctx.setLineDash([]);
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const base = [b.c[0], b.c[1], b.c[2] - b.d[2] / 2];
    const tip = [base[0] + c * (b.d[0] / 2 + 0.7), base[1] + s * (b.d[0] / 2 + 0.7), base[2]];
    const p0 = project(base, cam), p1 = project(tip, cam);
    ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
    ctx.beginPath(); ctx.arc(p1[0], p1[1], 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const mix = (a, b, t) => a + (b - a) * t;
  const mixBox = (a, b, t) => ({ c: a.c.map((v, i) => mix(v, b.c[i], t)), d: a.d.map((v, i) => mix(v, b.d[i], t)), yaw: mix(a.yaw, b.yaw, t) });

  const CYCLE = 7200;
  let lastPhase = '';
  function setHud(phase) {
    if (!hudState || phase === lastPhase) return;
    lastPhase = phase;
    const text = { bad: 'Lỗi · lơ lửng 45 cm · lệch 15°', fix: 'Đề xuất sửa · Δz −45 cm · Δyaw −15°', good: '✓ Khớp point cloud · cổng ĐẠT' }[phase];
    hudState.textContent = text;
    hudState.className = `hud-pill ${phase}`;
  }

  function frame(now) {
    const t = reduceMotion ? 0.8 : (now % CYCLE) / CYCLE;
    const cam = reduceMotion ? -0.55 : -0.55 + Math.sin(now / 9000) * 0.18;
    ctx.clearRect(0, 0, W_px, H_px);

    const textCol = css('--text-3') || '#7D8B9E';
    const accent = css('--accent') || '#5AA2FF';
    const ok = css('--ok') || '#47CD89';
    const err = css('--err') || '#FF8A75';

    // Mặt đất: điểm nhạt, vẽ trước.
    ctx.fillStyle = textCol;
    ctx.globalAlpha = 0.42;
    for (const p of ground) { const q = project(p, cam); ctx.fillRect(q[0], q[1], 1.3, 1.3); }
    // Điểm của vật: tô theo độ cao (xanh lam → xanh lục).
    ctx.globalAlpha = 0.95;
    for (const p of car) {
      const q = project(p, cam);
      const k = Math.min(1, p[2] / 1.55);
      ctx.fillStyle = k < 0.5 ? accent : ok;
      ctx.globalAlpha = 0.55 + 0.4 * k;
      ctx.fillRect(q[0] - 0.9, q[1] - 0.9, 1.9, 1.9);
    }
    ctx.globalAlpha = 1;

    let phase;
    if (t < 0.28) {
      phase = 'bad';
      drawBox(WRONG_BOX, cam, err, { width: 2, fill: true });
    } else if (t < 0.48) {
      phase = 'fix';
      const a = Math.min(1, (t - 0.28) / 0.08);
      drawBox(TRUE_BOX, cam, ok, { dash: [6, 5], alpha: a, width: 1.6 });
      drawBox(WRONG_BOX, cam, err, { width: 2, fill: true });
    } else if (t < 0.66) {
      phase = 'fix';
      const k = ease((t - 0.48) / 0.18);
      drawBox(TRUE_BOX, cam, ok, { dash: [6, 5], alpha: 1 - k, width: 1.6 });
      drawBox(mixBox(WRONG_BOX, TRUE_BOX, k), cam, k > 0.85 ? ok : accent, { width: 2, fill: true });
    } else {
      phase = 'good';
      const fade = t > 0.95 ? 1 - (t - 0.95) / 0.05 : 1;
      drawBox(TRUE_BOX, cam, ok, { width: 2.2, fill: true, alpha: fade });
    }
    setHud(phase);
    if (!reduceMotion) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
