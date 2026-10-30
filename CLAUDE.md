# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tools for labeling and QC-ing 3D LiDAR cuboids in CVAT. Data never leaves CVAT. Two parts, plain JavaScript, **no npm
dependencies anywhere** (Node ≥ 20 stdlib only; keep it that way):

- `extension/` — Chrome/Edge MV3 extension that adds the PointSnap annotator panel to CVAT 3D job pages, shown in
  its own popup window (`panel-window.html`), not embedded in the CVAT page.
- `qc/` — Node HTTP service (`qc/server.js`, port 8766) that scans whole CVAT jobs, drives the QC ↔ annotator ticket
  loop, and serves a web UI plus an in-CVAT plugin.

Docs, UI strings, code comments and test names are in **Vietnamese**; write new ones in Vietnamese too. `docs/` holds
design notes and measured results (pain points PP-xx, QC scan design, 2-round QC trial).

The old Python backend (`pointsnap/`, port 8765) was removed on 2026-10-28. References to it (`pointsnap scan`,
`127.0.0.1:8765`, `pointsnap/config.yaml`, "QC backend cũ", `src/core.js`/`src/content.js` flag-filter panel) are legacy.

## Commands

```bash
node --test qc/test/*.test.js extension/tests/*.test.js   # all tests
node --test extension/tests/box.test.js                   # one file
node --test --test-name-pattern="<substring>" qc/test/qc.test.js
node qc/server.js                                         # QC service → http://127.0.0.1:8766
```

QC config: copy `qc/.env.example` to `qc/.env.local` (not committed) and set `CVAT_URL`, `CVAT_TOKEN` (read-only CVAT
access token). Other vars (`QC_HOST`, `QC_PORT`, `QC_HOME`, `QC_USERS`, `QC_MAX_WARN_PER_100`) are documented in
`qc/lib/config.js`. Real env vars override the file. Data lives in `qc/.data/` (scans, reviews, specs, objects, tickets).

Extension: load unpacked from `extension/` at `chrome://extensions` / `edge://extensions`; there is no build step.
There is no linter; `extension/tests/syntax.test.js` runs `node --check` on every script listed in `manifest.json`,
so a new content script must be added to the manifest to be covered.

## Architecture

**Shared rule modules.** `extension/src/annotator/{box,guideline,checks,measure,...}.js` are pure UMD-style IIFEs:
in the browser they attach to `globalThis` (`PointSnapBox`, `PointSnapChecks`, …); in Node they `module.exports` and
`require` siblings. The QC service `require`s them directly (`qc/lib/scan.js`, `rules.js`, `tracks.js`,
`trackrules.js`, `icp.js`, `evidence.js`, `server.js`) so the annotator panel and QC judge a box identically.
Changing a threshold or rule in these files changes both tools — run both test suites. Keep them free of DOM/CVAT access.

**Extension load order** (`manifest.json`): annotator modules run in the page's `MAIN` world in dependency order
(pure modules → `cvat-adapter.js` → `overlay`/`cloud-colors`/`panel`/`spec-editor` → `annotator.js` controller).
`cvat-adapter.js` is the **only** file that touches CVAT internals. `settings-bridge.js` runs in the ISOLATED world and
passes per-CVAT-host config (from `hosts.js` / `chrome.storage`) into the page. The panel lives in an extension popup
window: `panel-link.js` (MAIN) posts the view-model to `panel-bridge.js` (ISOLATED), which forwards it over a
`chrome.tabs.connect` port to `panel-window.js`; clicks come back the same way. `background.js` keeps one window per tab.
In the QC plugin (no extension) the same `panel.js` renders into a "Hỗ trợ" tab of CVAT's sidebar instead. Panels use
shadow DOM. Edits go into
CVAT's in-memory annotations like a user drag; the user still presses CVAT's Save. Undo uses
`job.annotations.saveStates` when CVAT has it, otherwise PointSnap pauses CVAT history and offers its own ↶ button
(CVAT 2.75.1 keeps only 32 undo steps). Non-localhost CVAT hosts get content scripts registered at runtime by
`background.js` after the user grants the optional host permission.

**QC service.** `server.js` is a single hand-rolled router (`route()`, exported with `server` for tests). Non-GET
requests require header `X-PointSnap-QC: 1`. Auth (`lib/auth.js`) has three paths: login with CVAT username/password
(verified against CVAT, then logged out; sessions in memory), CVAT session cookie when served under `/pointsnap-qc/`
behind CVAT's nginx (`Auth.fromCvatSession`), and `Bearer psq_…` extension tokens. Roles: users in `QC_USERS` are QC
(empty → CVAT admins), everyone else is annotator with access limited to their own tickets.
- `lib/cvat.js` (REST client) + `zip.js`/`pcd.js` fetch frame chunks and parse point clouds; nothing is persisted.
- `lib/tracks.js` rebuilds per-frame boxes as CVAT shows them (keyframes + interpolation).
- `lib/scan.js` runs the shared per-box rules plus QC-only multi-frame rules in `lib/trackrules.js` (box jump, ID swap,
  broken track via Hungarian matching + point-cloud evidence in `evidence.js`, duplicate object); ego-motion from
  `icp.js` because CVAT stores no pose.
- `lib/rules.js` resolves per-project guideline specs (versioned in `lib/store.js`) over defaults from `guideline.js`.
- `lib/store.js` is plain JSON files under `QC_HOME`.
- Object review fingerprints: an object edited after review falls back to "Chưa xem".

**QC frontend** (`qc/public/`): vanilla JS, no bundler. `app.js` (QC review), `tickets.js`/`annotator.js` (annotator
workspace), `spec.js` (guideline editor), `login.js`, `connect.js` (extension token). `plugin.js` + `plugin.css` are
injected into CVAT's own UI via nginx `sub_filter` and register through `window.cvatUI.registerComponent`; setup in
`docs/qc-plugin-cvat.md`. The plugin also loads the extension's annotator panel from `GET /annotator-panel.js` (the
manifest's MAIN-world scripts concatenated in order) and answers its settings / spec-save `postMessage`s from the QC
spec store instead of `settings-bridge.js`, so the panel runs in CVAT without the extension.

UI follows CVAT's Ant Design look (white, `#d9d9d9` borders, `#1677ff` primary) in `plugin.css`, `panel.js` and
`spec-editor.js`; the logo is `qc/public/logo.svg`, inlined as `LOGO` in `panel.js` and `plugin.js`.
