"""Xuất báo cáo HTML đẹp mắt, hỗ trợ xem lỗi theo track và link mở thẳng frame CVAT (A5)."""

from __future__ import annotations

import html
from pathlib import Path
from typing import Iterable

from pointsnap.adapters.cvat.reader import JobData, frame_url
from pointsnap.core.model import Finding, Severity


def generate_html_report(
    job: JobData,
    findings: Iterable[Finding],
    output_path: str | Path,
    source_name: str | None = None,
    *,
    coverage_gaps: Iterable[str] = (),
    gate_passed: bool | None = None,
    gate_reasons: Iterable[str] = (),
) -> Path:
    """Ghi báo cáo HTML. source_name (ví dụ tên cảnh nuScenes) thay cho Task / Job khi quét không qua CVAT."""
    findings_list = sorted(findings, key=lambda f: f.sort_key())
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    num_errors = sum(1 for f in findings_list if f.severity == Severity.ERROR)
    num_warnings = sum(1 for f in findings_list if f.severity == Severity.WARNING)
    num_infos = sum(1 for f in findings_list if f.severity == Severity.INFO)
    total_findings = len(findings_list)

    # Gom theo track_id
    tracks_map: dict[str, list[Finding]] = {}
    for f in findings_list:
        trk_name = f"Track #{f.track_id}" if f.track_id is not None else "Box lẻ (Không có track)"
        if trk_name not in tracks_map:
            tracks_map[trk_name] = []
        tracks_map[trk_name].append(f)

    rows_html = []
    for trk_name, items in tracks_map.items():
        rows_html.append(f"""
        <div class="track-group">
            <div class="track-header">
                <h3>{html.escape(trk_name)}</h3>
                <span class="badge-count">{len(items)} phát hiện</span>
            </div>
            <div class="table-responsive">
                <table class="findings-table">
                    <thead>
                        <tr>
                            <th>Mức</th>
                            <th>Loại lỗi</th>
                            <th>Frame</th>
                            <th>Đối tượng</th>
                            <th>Chi tiết & Số đo</th>
                            <th>Mở CVAT</th>
                        </tr>
                    </thead>
                    <tbody>
        """)
        for item in items:
            url = (
                frame_url(
                    job.url,
                    job.task_id,
                    job.job_id,
                    item.frame,
                    track_id=item.track_id,
                    shape_id=item.source_id if item.track_id is None else None,
                )
                if job.url
                else ""
            )
            link = (f'<a class="btn-link" href="{html.escape(url)}" target="_blank" rel="noopener">Mở frame {item.frame} &rarr;</a>'
                    if url else "&mdash;")
            sev_class = f"sev-{item.severity.value}"
            sev_label = item.severity.label_vi
            rows_html.append(f"""
                        <tr class="{sev_class}-row">
                            <td><span class="badge {sev_class}">{html.escape(sev_label)}</span></td>
                            <td><code>{html.escape(item.rule)}</code></td>
                            <td>Frame {item.frame}</td>
                            <td><span class="class-tag">{html.escape(item.label)}</span></td>
                            <td><strong>{html.escape(item.message)}</strong></td>
                            <td>{link}</td>
                        </tr>
            """)
        rows_html.append("""
                    </tbody>
                </table>
            </div>
        </div>
        """)

    content_html = "\n".join(rows_html) if findings_list else """
        <div class="empty-state">
            <div class="empty-icon">&check;</div>
            <h2>Không phát hiện lỗi nhãn nào!</h2>
            <p>Không có finding trong các luật và dữ liệu đã kiểm; xem phạm vi kiểm tra và gate bên dưới.</p>
        </div>
    """

    source_tags = (f'<span class="meta-tag">{html.escape(source_name)}</span>' if source_name else
                   f'<span class="meta-tag">Task #{job.task_id}</span> <span class="meta-tag">Job #{job.job_id}</span>')
    notes = list(dict.fromkeys([*coverage_gaps, *gate_reasons]))
    scope_html = "".join(f"<p>{html.escape(note)}</p>" for note in notes)
    if gate_passed is not None:
        scope_html = f"<p>Gate: {'ĐẠT ngưỡng các luật đang bật' if gate_passed else 'KHÔNG ĐẠT'}</p>" + scope_html

    html_content = f"""<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PointSnap 3D — Báo cáo quét {html.escape(source_name) if source_name else f'Job #{job.job_id}'}</title>
    <style>
        :root {{
            --bg: #0f172a;
            --surface: #1e293b;
            --surface-hover: #334155;
            --border: #334155;
            --text: #f8fafc;
            --text-muted: #94a3b8;
            --error: #ef4444;
            --error-bg: rgba(239, 68, 68, 0.15);
            --warning: #f59e0b;
            --warning-bg: rgba(245, 158, 11, 0.15);
            --info: #3b82f6;
            --info-bg: rgba(59, 130, 246, 0.15);
            --success: #10b981;
            --primary: #6366f1;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            line-height: 1.6;
            padding: 2rem 1rem;
        }}
        .container {{
            max-width: 1200px;
            margin: 0 auto;
        }}
        header {{
            margin-bottom: 2rem;
            border-bottom: 1px solid var(--border);
            padding-bottom: 1.5rem;
        }}
        .header-top {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        }}
        h1 {{
            font-size: 1.8rem;
            font-weight: 700;
            color: #fff;
        }}
        .subtitle {{
            color: var(--text-muted);
            margin-top: 0.25rem;
            font-size: 0.95rem;
        }}
        .meta-badges {{
            display: flex;
            gap: 0.75rem;
            margin-top: 0.75rem;
        }}
        .meta-tag {{
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.85rem;
            color: var(--text-muted);
        }}
        .stats-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }}
        .stat-card {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.25rem;
        }}
        .stat-title {{
            font-size: 0.85rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }}
        .stat-value {{
            font-size: 2rem;
            font-weight: 700;
            margin-top: 0.25rem;
        }}
        .val-total {{ color: var(--text); }}
        .val-error {{ color: var(--error); }}
        .val-warning {{ color: var(--warning); }}
        .val-info {{ color: var(--info); }}

        .track-group {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            margin-bottom: 1.5rem;
            overflow: hidden;
        }}
        .track-header {{
            padding: 1rem 1.25rem;
            background: rgba(255, 255, 255, 0.02);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}
        .track-header h3 {{
            font-size: 1.1rem;
            font-weight: 600;
        }}
        .badge-count {{
            font-size: 0.8rem;
            background: var(--border);
            padding: 0.2rem 0.6rem;
            border-radius: 9999px;
            color: var(--text-muted);
        }}
        .table-responsive {{
            overflow-x: auto;
        }}
        .findings-table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 0.95rem;
        }}
        .findings-table th {{
            text-align: left;
            padding: 0.75rem 1.25rem;
            background: rgba(0, 0, 0, 0.15);
            color: var(--text-muted);
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid var(--border);
        }}
        .findings-table td {{
            padding: 0.9rem 1.25rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            vertical-align: middle;
        }}
        .findings-table tr:last-child td {{
            border-bottom: none;
        }}
        .findings-table tr:hover {{
            background: var(--surface-hover);
        }}
        .badge {{
            display: inline-block;
            padding: 0.25rem 0.6rem;
            border-radius: 6px;
            font-size: 0.8rem;
            font-weight: 600;
        }}
        .badge.sev-error {{
            background: var(--error-bg);
            color: var(--error);
            border: 1px solid rgba(239, 68, 68, 0.3);
        }}
        .badge.sev-warning {{
            background: var(--warning-bg);
            color: var(--warning);
            border: 1px solid rgba(245, 158, 11, 0.3);
        }}
        .badge.sev-info {{
            background: var(--info-bg);
            color: var(--info);
            border: 1px solid rgba(59, 130, 246, 0.3);
        }}
        .class-tag {{
            background: rgba(255, 255, 255, 0.05);
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            font-size: 0.85rem;
        }}
        code {{
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.85rem;
            color: #cbd5e1;
            background: rgba(0,0,0,0.25);
            padding: 0.15rem 0.4rem;
            border-radius: 4px;
        }}
        .btn-link {{
            color: #818cf8;
            text-decoration: none;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
        }}
        .btn-link:hover {{
            color: #a5b4fc;
            text-decoration: underline;
        }}
        .empty-state {{
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 4rem 2rem;
            text-align: center;
        }}
        .empty-icon {{
            width: 60px;
            height: 60px;
            line-height: 60px;
            margin: 0 auto 1.5rem;
            background: rgba(16, 185, 129, 0.2);
            color: var(--success);
            border-radius: 50%;
            font-size: 2rem;
            font-weight: bold;
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="header-top">
                <div>
                    <h1>PointSnap 3D &mdash; Báo cáo quét</h1>
                    <div class="subtitle">Kết quả kiểm tra tự động nhãn 3D bounding box trên CVAT</div>
                </div>
            </div>
            <div class="meta-badges">
                {source_tags}
                <span class="meta-tag">Frame {job.start_frame}&ndash;{job.stop_frame}</span>
                <span class="meta-tag">Tổng {sum(not c.outside for c in job.cuboids)} box</span>
            </div>
        </header>

        <section class="stats-grid">
            <div class="stat-card">
                <div class="stat-title">Tổng phát hiện</div>
                <div class="stat-value val-total">{total_findings}</div>
            </div>
            <div class="stat-card">
                <div class="stat-title">Lỗi (Cần sửa)</div>
                <div class="stat-value val-error">{num_errors}</div>
            </div>
            <div class="stat-card">
                <div class="stat-title">Cảnh báo</div>
                <div class="stat-value val-warning">{num_warnings}</div>
            </div>
            <div class="stat-card">
                <div class="stat-title">Thông tin</div>
                <div class="stat-value val-info">{num_infos}</div>
            </div>
        </section>

        <main>
            <section class="scan-scope">{scope_html}</section>
            {content_html}
        </main>
    </div>
</body>
</html>
"""
    path.write_text(html_content, encoding="utf-8")
    return path
