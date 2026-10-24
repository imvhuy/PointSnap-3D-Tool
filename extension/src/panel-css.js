/*
 * Kiểu dáng bảng PointSnap trên trang CVAT. Nằm trong Shadow DOM nên không ảnh hưởng giao diện CVAT
 * và không bị CSS của CVAT ảnh hưởng. Dùng đúng bộ màu và kiểu thẻ của giao diện web PointSnap (A13),
 * tông sáng để hợp với CVAT.
 */
globalThis.PointSnapPanelCss = `
:host { all: initial; }
.ps {
  --surface: #FFFFFF; --surface-2: #F7F9FB; --border: #DDE2E8; --border-strong: #C3CBD5;
  --text: #161B22; --text-2: #4A5563; --text-3: #68717D;
  --topbar: #0F2A47; --topbar-text-2: #B7C6D8; --logo-dot: #4C9AFF;
  --primary: #0B63CE; --on-primary: #FFFFFF; --primary-soft: #E8F1FC; --primary-text: #0A57B5; --selected: #EEF5FD;
  --error: #B42318; --error-soft: #FDEEEE; --warn: #A35200; --warn-soft: #FFF3E3; --warn-bar: #E9B56B;
  --info: #4A5563; --info-soft: #EEF1F5; --success: #157A4A; --success-soft: #EBF8F1;
  --note: #E8F1FC; --note-border: #B8D3F5; --radius: 6px;
  position: fixed; z-index: 2147483000; width: 375px; max-height: calc(100vh - 80px);
  display: flex; flex-direction: column; overflow: hidden;
  font: 13px/1.5 'IBM Plex Sans', 'Segoe UI', system-ui, -apple-system, sans-serif; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 1px 2px rgba(15, 42, 71, .06), 0 8px 24px rgba(15, 42, 71, .14);
  -webkit-font-smoothing: antialiased;
}
.ps * { box-sizing: border-box; }
.ps button { font: inherit; color: inherit; cursor: pointer; }
.ps button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.ps button:disabled { cursor: default; }
.grow { flex: 1 1 auto; min-width: 0; }
.muted { color: var(--text-3); }
.small { font-size: 12px; }
.mono, code { font-family: 'IBM Plex Mono', Consolas, ui-monospace, monospace; }
.kbd {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px;
  font: 500 11px 'IBM Plex Mono', Consolas, monospace; color: var(--text-2);
  background: var(--surface); border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px;
}

/* ---- Thanh tiêu đề (navy như web) ---- */
.head {
  display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 6px 0 12px;
  background: var(--topbar); color: #fff; cursor: grab; user-select: none; flex: none;
}
.head:active { cursor: grabbing; }
.brand { font-weight: 600; font-size: 14px; letter-spacing: -.01em; }
.head-count { font: 500 12px 'IBM Plex Mono', Consolas, monospace; color: var(--topbar-text-2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6B7785; margin-right: 4px; }
.dot.on { background: #3FCF8E; box-shadow: 0 0 0 3px rgba(63, 207, 142, .18); }
.icon-btn {
  display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: inherit;
}
.head .icon-btn:hover { background: rgba(255, 255, 255, .12); }
.icon-btn.small { width: 22px; height: 22px; }
.icon-btn.ghost { color: var(--text-2); }
.icon-btn.ghost:hover, .pager .icon-btn:hover, .note .icon-btn:hover { background: var(--info-soft); color: var(--text); }
.ps.collapsed { width: auto; min-width: 200px; }

/* ---- Tab ---- */
.tabs { display: flex; padding: 0 8px; border-bottom: 1px solid var(--border); flex: none; }
.tab {
  height: 38px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--text-2); font-size: 13px;
}
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); font-weight: 600; border-bottom-color: var(--primary); }
.tab-count {
  display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 9px; background: var(--info-soft);
  font: 500 11px/18px 'IBM Plex Mono', Consolas, monospace; color: var(--text-2);
}

.body { overflow-y: auto; overflow-x: hidden; padding: 12px; display: flex; flex-direction: column; gap: 12px; }

/* ---- Điều hướng frame ---- */
.nav { display: grid; grid-template-columns: 36px 1fr 36px; align-items: center; gap: 8px; }
.nav-btn {
  display: grid; place-items: center; width: 36px; height: 36px; padding: 0;
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text);
}
.nav-btn:hover:not(:disabled) { background: var(--surface-2); }
.nav-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.nav-btn.primary:hover:not(:disabled) { background: var(--primary); opacity: .92; }
.nav-btn:disabled { opacity: .4; }
.nav-mid { display: flex; flex-direction: column; align-items: center; line-height: 1.25; }
.nav-frame { font-size: 15px; font-weight: 600; }
.nav-sub { font-size: 12px; color: var(--text-3); }

/* ---- Thẻ lỗi (giống khung chi tiết của web) ---- */
.card {
  border: 1px solid var(--border); border-left: 3px solid var(--info); border-radius: var(--radius);
  background: var(--surface); padding: 12px;
}
.card.sev-error { border-left-color: var(--error); }
.card.sev-warning { border-left-color: var(--warn-bar); }
.card-top { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.card-top code { font-size: 11px; color: var(--text-3); }
.card-title { margin: 8px 0 2px; font-size: 15px; font-weight: 600; line-height: 1.3; letter-spacing: -.005em; }
.card-meta { font-size: 12px; color: var(--text-3); }
.msg { margin: 8px 0 0; color: var(--text); }
.msg .sev { margin-right: 4px; }
.fix {
  margin-top: 10px; padding: 8px 10px; border-radius: var(--radius);
  background: var(--note); border: 1px solid var(--note-border); font-size: 12px; color: var(--text);
}
.fix-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--primary-text); margin-bottom: 2px; }
.card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.card-actions .btn { flex: 1 1 auto; justify-content: center; padding: 0 8px; }
.card-actions .icon-btn { flex: none; }
.pager { display: inline-flex; align-items: center; gap: 2px; font: 500 12px 'IBM Plex Mono', Consolas, monospace; color: var(--text-2); }
.pager .icon-btn { color: var(--text-2); }

.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface);
  font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--surface-2); }
.btn:disabled { opacity: .5; }
.btn.chosen.ok { background: var(--success-soft); border-color: var(--success); color: var(--success); }
.btn.chosen.fp { background: var(--error-soft); border-color: var(--error); color: var(--error); }

.sev {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.sev.error { background: var(--error-soft); color: var(--error); }
.sev.warning { background: var(--warn-soft); color: var(--warn); }
.sev.info { background: var(--info-soft); color: var(--info); }

/* ---- Dòng trạng thái bộ lọc ---- */
.status-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.status-row .filter { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.state { width: 6px; height: 6px; border-radius: 50%; background: var(--off, #B4BCC6); }
.state.on { background: var(--primary); }
.keys { display: inline-flex; align-items: center; gap: 3px; color: var(--text-3); white-space: nowrap; }
.keys .kbd:last-of-type { margin-right: 3px; }
.link {
  border: 0; background: none; padding: 0; color: var(--primary-text); font-weight: 500; font-size: 12px;
  text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(10, 87, 181, .35);
}
.link:hover { text-decoration-color: currentColor; }

/* ---- Thông báo ---- */
.note {
  display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: var(--radius);
  font-size: 12px; background: var(--note); border: 1px solid var(--note-border);
}
.note.warn { background: var(--warn-soft); border-color: #F2D2A4; }
.note.error { background: var(--error-soft); border-color: #F3C5C2; }
.note-actions { display: flex; gap: 12px; margin-top: 4px; }

/* ---- Danh sách ---- */
.seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius); background: var(--info-soft); align-self: flex-start; }
.seg-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  border: 0; border-radius: 4px; background: transparent; font-size: 12px; color: var(--text-2);
}
.seg-btn span { font: 500 11px 'IBM Plex Mono', Consolas, monospace; color: var(--text-3); }
.seg-btn[aria-pressed="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(15, 42, 71, .12); }
.list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); max-height: 260px; overflow-y: auto; }
.row-item {
  display: grid; grid-template-columns: 30px 1fr auto; align-items: center; gap: 8px; text-align: left;
  min-height: 40px; padding: 4px 10px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface);
}
.row-item:last-child { border-bottom: 0; }
.row-item:hover { background: var(--surface-2); }
.row-item.current { background: var(--selected); box-shadow: inset 2px 0 0 var(--primary); }
.row-item .f { font: 500 12px 'IBM Plex Mono', Consolas, monospace; color: var(--text-3); text-align: right; }
.row-item .t { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.row-item .t b { font-weight: 600; font-size: 12px; }
.row-item .t span { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sev-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--info); }
.sev-dot.error { background: var(--error); }
.sev-dot.warning { background: var(--warn-bar); }
.verdict { font-size: 11px; font-weight: 600; }
.verdict.ok { color: var(--success); }
.verdict.fp { color: var(--error); }

/* ---- PointSnap: quét, gắn cờ ---- */
.camera { margin: 10px 0 0; }
.camera img { width: 100%; max-height: 200px; object-fit: contain; background: #102a43; border-radius: 6px; }
.camera figcaption { color: var(--text-3); font-size: 11px; }
.scan { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; border-top: 1px solid var(--border); }
.scan-title { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); }
.scan-state { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--text-3); }
.scan-state.on { color: var(--success); }
.scan-actions { display: flex; gap: 6px; margin-top: 6px; }
.warn-text { color: var(--warn); }
.progress { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; margin-top: 4px; }
.progress i { display: block; height: 100%; background: var(--primary); transition: width .3s; }
.empty { padding: 16px 8px; text-align: center; color: var(--text-3); font-size: 12px; line-height: 1.6; }
.empty b { color: var(--text); }

/* ---- Feature F13: Thẻ Gợi ý sửa tự động (Assisted Repair Card) ---- */
.repair-box {
  margin-top: 10px; padding: 10px; border-radius: var(--radius);
  background: var(--surface-2); border: 1px solid var(--border);
  border-left: 3px solid var(--primary); display: flex; flex-direction: column; gap: 8px;
}
.repair-head { display: flex; align-items: center; gap: 6px; }
.repair-head .title { font-weight: 600; font-size: 12px; color: var(--primary-text); }
.repair-conf {
  display: inline-flex; align-items: center; padding: 0 6px; border-radius: 8px;
  font: 600 11px/16px 'IBM Plex Mono', Consolas, monospace; background: var(--success-soft); color: var(--success);
}
.repair-conf.medium { background: var(--warn-soft); color: var(--warn); }
.repair-reason { font-size: 12px; color: var(--text-2); line-height: 1.4; margin: 0; }
.delta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.delta-cell {
  background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px;
  display: flex; flex-direction: column; gap: 2px;
}
.delta-cell .lbl { font-size: 10px; font-weight: 500; color: var(--text-3); text-transform: uppercase; }
.delta-cell .val { font: 600 12px 'IBM Plex Mono', Consolas, monospace; color: var(--text); }
.delta-cell .val.highlight { color: var(--primary); }
.repair-actions { display: flex; align-items: center; gap: 6px; }
.btn.repair-apply { background: var(--primary); color: #fff; border-color: var(--primary); font-weight: 600; }
.btn.repair-apply:hover:not(:disabled) { opacity: .92; }
.repair-confirm-box {
  background: var(--warn-soft); border: 1px solid var(--warn-bar); border-radius: var(--radius);
  padding: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 12px;
}
.confirm-message { color: var(--warn); font-weight: 500; }
.confirm-actions { display: flex; gap: 6px; }
.btn.confirm-yes { background: var(--success); color: #fff; border-color: var(--success); font-weight: 600; }
.btn.confirm-no { background: var(--surface); color: var(--text-2); }
.repair-success-box {
  background: var(--success-soft); border: 1px solid #A3E0C0; border-radius: var(--radius);
  padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.badge-pass { font-weight: 600; font-size: 11px; color: var(--success); }
.btn.rollback { background: var(--surface); border-color: var(--border-strong); color: var(--text-2); }
.btn.rollback:hover:not(:disabled) { color: var(--error); border-color: var(--error); }

/* ---- Feature F15: Live Telemetry HUD (Glassmorphic 3D Overlay) ---- */
.ps-telemetry-hud {
  position: absolute;
  z-index: 2147483001;
  pointer-events: none;
  width: 250px;
  background: rgba(15, 23, 42, 0.88);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
  font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #F8FAFC;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  user-select: none;
}
.ps-telemetry-hud.off-target {
  border-color: #f59e0b;
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.35);
}
.ps-telemetry-hud.snapped {
  border-color: #3b82f6;
  box-shadow: 0 0 16px rgba(59, 130, 246, 0.5);
}
.ps-telemetry-hud.green-lock {
  border-color: #10b981;
  box-shadow: 0 0 24px rgba(16, 185, 129, 0.8), inset 0 0 12px rgba(16, 185, 129, 0.2);
  animation: ps-pulse-glow 1.5s infinite alternate ease-in-out;
}
@keyframes ps-pulse-glow {
  0% { box-shadow: 0 0 16px rgba(16, 185, 129, 0.6); }
  100% { box-shadow: 0 0 28px rgba(16, 185, 129, 0.95), inset 0 0 14px rgba(16, 185, 129, 0.3); }
}
.ps-hud-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.ps-hud-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 700;
}
.ps-hud-badge.off-target {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.ps-hud-badge.snapped {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.4);
}
.ps-hud-badge.green-lock {
  background: rgba(16, 185, 129, 0.25);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.6);
}
.ps-hud-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.ps-hud-metric {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
}
.ps-hud-metric-lbl {
  font-size: 9px;
  font-weight: 500;
  color: #94A3B8;
  text-transform: uppercase;
}
.ps-hud-metric-val {
  font-family: 'IBM Plex Mono', Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  color: #F1F5F9;
}
.ps-hud-metric-val.perfect {
  color: #34d399;
}
.ps-hud-metric-val.warn {
  color: #fbbf24;
}
.ps-hud-clearances {
  font-size: 10px;
  color: #94A3B8;
  font-family: 'IBM Plex Mono', Consolas, monospace;
  display: flex;
  justify-content: space-between;
  background: rgba(0, 0, 0, 0.2);
  padding: 3px 6px;
  border-radius: 4px;
}
.ps-hud-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: #64748B;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 5px;
}
.ps-hud-footer kbd {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 4px;
  border-radius: 3px;
  color: #CBD5E1;
  font-family: 'IBM Plex Mono', monospace;
}
`;
