"""
letters.py — Block Sanction Letter Generator for RailSetu.

Generates formal block sanction letters from actual block/task DB state.
Called via GET /department/letters/{block_id} — not pre-generated files.

The letter is returned as an HTML string suitable for browser rendering
and printing.  A future enhancement could add weasyprint PDF export.
"""

from __future__ import annotations

from datetime import datetime, timezone


def generate_letter(
    block_id: int,
    task_department: str,
    task_chainage_km: float,
    estimated_duration_minutes: int,
    block_start: datetime,
    block_end: datetime,
    block_status: str,
    reference_date: datetime | None = None,
) -> str:
    """
    Generate an HTML block-sanction letter from actual block/task state.

    Parameters
    ----------
    block_id : int
    task_department : str
        The department responsible (Civil, Signalling, Electrical).
    task_chainage_km : float
    estimated_duration_minutes : int
    block_start : datetime
    block_end : datetime
    block_status : str
    reference_date : datetime | None
        Date for the reference number.  Defaults to now.

    Returns
    -------
    str — complete HTML document.
    """
    if reference_date is None:
        reference_date = datetime.now(timezone.utc)

    ref_number = f"RS/{block_id:04d}/{reference_date.strftime('%Y%m%d')}"
    date_str = reference_date.strftime("%d %B %Y")

    # Chainage range: ±0.25 km around the task's chainage
    ch_start = max(0.0, task_chainage_km - 0.25)
    ch_end = task_chainage_km + 0.25

    block_date = block_start.strftime("%d %B %Y")
    block_time_start = block_start.strftime("%H:%M")
    block_time_end = block_end.strftime("%H:%M")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Block Sanction Letter — {ref_number}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: 'Inter', 'Segoe UI', sans-serif;
    max-width: 800px;
    margin: 40px auto;
    padding: 40px;
    color: #1a1a1a;
    line-height: 1.6;
  }}
  .letterhead {{
    text-align: center;
    border-bottom: 3px solid #1a237e;
    padding-bottom: 20px;
    margin-bottom: 30px;
  }}
  .letterhead h1 {{
    color: #1a237e;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 2px;
  }}
  .letterhead p {{
    color: #555;
    font-size: 13px;
    margin-top: 4px;
  }}
  .meta {{
    display: flex;
    justify-content: space-between;
    margin-bottom: 30px;
    font-size: 14px;
  }}
  .meta .ref {{ font-weight: 600; }}
  h2 {{
    text-align: center;
    font-size: 18px;
    color: #1a237e;
    margin-bottom: 25px;
    text-decoration: underline;
    text-underline-offset: 4px;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
  }}
  th, td {{
    border: 1px solid #ccc;
    padding: 10px 14px;
    text-align: left;
    font-size: 14px;
  }}
  th {{
    background: #f0f2ff;
    color: #1a237e;
    font-weight: 600;
    width: 40%;
  }}
  .note {{
    background: #fffbeb;
    border-left: 4px solid #f59e0b;
    padding: 12px 16px;
    margin: 20px 0;
    font-size: 13px;
  }}
  .signature {{
    margin-top: 60px;
    text-align: right;
  }}
  .signature .name {{
    font-weight: 700;
    font-size: 15px;
  }}
  .signature .title {{
    color: #555;
    font-size: 13px;
  }}
  .footer {{
    margin-top: 50px;
    border-top: 1px solid #ddd;
    padding-top: 15px;
    font-size: 11px;
    color: #999;
    text-align: center;
  }}
  @media print {{
    body {{ margin: 0; padding: 20px; }}
    .footer {{ page-break-after: avoid; }}
  }}
</style>
</head>
<body>

<div class="letterhead">
  <h1>RAILSETU</h1>
  <p>Automatic Block Planning &amp; Operational Optimization System</p>
  <p>South Central Railway — Secunderabad Division (Placeholder)</p>
</div>

<div class="meta">
  <div>
    <span class="ref">Ref: {ref_number}</span>
  </div>
  <div>
    Date: {date_str}
  </div>
</div>

<h2>BLOCK SANCTION LETTER</h2>

<p style="margin-bottom: 20px;">
  This is to certify that the following maintenance block has been sanctioned
  and {block_status} as per the integrated block planning system (RailSetu):
</p>

<table>
  <tr><th>Block ID</th><td>{block_id}</td></tr>
  <tr><th>Reference Number</th><td>{ref_number}</td></tr>
  <tr><th>Department</th><td>{task_department}</td></tr>
  <tr><th>Work Type</th><td>Scheduled Maintenance</td></tr>
  <tr><th>Chainage Range</th><td>{ch_start:.2f} km — {ch_end:.2f} km</td></tr>
  <tr><th>Date</th><td>{block_date}</td></tr>
  <tr><th>Block Window</th><td>{block_time_start} — {block_time_end}</td></tr>
  <tr><th>Estimated Duration</th><td>{estimated_duration_minutes} minutes</td></tr>
  <tr><th>Status</th><td style="font-weight:600; text-transform:uppercase;">{block_status}</td></tr>
</table>

<div class="note">
  <strong>Note:</strong> This block has been optimised using CP-SAT constraint
  programming to avoid conflicts with scheduled train services and other
  maintenance activities. All safety headways and crew shift limits have been
  verified by the system.
</div>

<p style="margin-top: 20px;">
  All concerned staff and departments are hereby directed to adhere to the
  timings and chainage limits specified above.  Any deviation must be
  reported immediately to the Section Controller.
</p>

<div class="signature">
  <p class="name">Section Controller</p>
  <p class="title">Field Operations — RailSetu System</p>
  <p class="title">South Central Railway (Secunderabad Division)</p>
</div>

<div class="footer">
  Generated by RailSetu — Automatic Block Planning &amp; Operational Optimization System<br>
  This is a system-generated document. For verification, contact the Section Controller's office.
</div>

</body>
</html>"""
    return html
