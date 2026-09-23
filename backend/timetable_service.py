"""
timetable_service.py — Stage 4: Timetable Analysis and Maintenance Window Computation.

Algorithm:
1. Load all TrainRun rows from the DB.
2. Build a pairwise distance matrix using the cosine-cube similarity:
       similarity(i, j) = cos³(π × min(|Tᵢ−Tⱼ|, 1440−|Tᵢ−Tⱼ|) / (2 × τ))
       distance(i, j)   = 1 − similarity(i, j)
   Times are in minutes-since-midnight; the min() handles midnight wrap-around.
3. Run sklearn AgglomerativeClustering (metric='precomputed', linkage='average',
   n_clusters=None, distance_threshold=0.293) on the distance matrix.
   The threshold 0.293 ≈ 1 - cos³(π/4) corresponds to τ/2 separation.
4. Collapse each cluster to its mean time → virtual daily slot.
5. Sort slots; compute gaps (including midnight wrap-around).
6. Filter gaps > min_window_minutes → maintenance windows.
7. Persist each window in maintenance_windows table; source_run_id = closest
   run to the cluster mean.
8. Return structured summary.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sqlalchemy.orm import Session

from models import MaintenanceWindow, TrainRun

log = logging.getLogger("railsetu.timetable_service")

# Full corridor chainage bounds
CORRIDOR_START_KM: float = 0.0
CORRIDOR_END_KM: float = 19.90


def _time_to_minutes(t) -> int:
    """Convert a datetime.time object to integer minutes since midnight."""
    return t.hour * 60 + t.minute


def _cosine_cube_distance(delta_minutes: float, tau: float) -> float:
    """
    Compute the cosine-cube distance between two times separated by delta_minutes.
    distance = 1 - cos³(π × delta / (2 × τ)), clamped to 1.0 when delta ≥ τ.
    """
    if delta_minutes >= tau:
        return 1.0
    return 1.0 - math.cos(math.pi * delta_minutes / (2.0 * tau)) ** 3


def _build_distance_matrix(times_min: list[int], tau: float) -> np.ndarray:
    """
    Build an (n × n) pairwise distance matrix using cosine-cube distance.
    Handles midnight wrap-around by taking min(|Tᵢ−Tⱼ|, 1440−|Tᵢ−Tⱼ|).
    """
    n = len(times_min)
    dist = np.zeros((n, n), dtype=float)
    for i in range(n):
        for j in range(i + 1, n):
            raw_diff = abs(times_min[i] - times_min[j])
            delta = min(raw_diff, 1440 - raw_diff)
            d = _cosine_cube_distance(float(delta), tau)
            dist[i, j] = d
            dist[j, i] = d
    return dist


def analyze_timetable(
    db: Session,
    tau_minutes: int = 15,
    min_window_minutes: int = 30,
) -> dict:
    """
    Cluster train runs into virtual daily timetable slots and compute
    free maintenance windows from the resulting gaps.

    Returns
    -------
    {"ok": True, "clusters_found": int, "virtual_slots": [str], "windows_saved": int, "windows": [...]}
    {"ok": False, "reason": "no_train_runs"}
    """
    runs: list[TrainRun] = db.query(TrainRun).all()
    if not runs:
        return {"ok": False, "reason": "no_train_runs"}

    times_min: list[int] = [_time_to_minutes(r.scheduled_time) for r in runs]
    tau = float(tau_minutes)

    # ── Single-run fast path ──────────────────────────────────────────────────
    if len(runs) == 1:
        clusters = [0]
        n_clusters = 1
    else:
        dist_matrix = _build_distance_matrix(times_min, tau)
        # distance_threshold ≈ 1 - cos³(π/4) ≈ 0.293  (τ/2 separation boundary)
        distance_threshold = 1.0 - math.cos(math.pi / 4.0) ** 3
        clustering = AgglomerativeClustering(
            metric="precomputed",
            linkage="average",
            n_clusters=None,
            distance_threshold=distance_threshold,
        )
        clusters = clustering.fit_predict(dist_matrix).tolist()
        n_clusters = clustering.n_clusters_

    # ── Compute cluster mean times ────────────────────────────────────────────
    cluster_ids = sorted(set(clusters))
    cluster_means: dict[int, float] = {}   # cluster_id → mean minutes
    cluster_runs: dict[int, list[int]] = {c: [] for c in cluster_ids}

    for idx, c in enumerate(clusters):
        cluster_runs[c].append(times_min[idx])

    for c, mins in cluster_runs.items():
        cluster_means[c] = sum(mins) / len(mins)

    # Sort virtual slots by mean time
    sorted_slots: list[float] = sorted(cluster_means[c] for c in cluster_ids)

    # Format as HH:MM strings for the response
    virtual_slot_strings: list[str] = [
        f"{int(m) // 60:02d}:{int(m) % 60:02d}" for m in sorted_slots
    ]

    # ── Compute maintenance windows ───────────────────────────────────────────
    # Gaps between consecutive virtual slots (plus midnight wrap-around)
    gaps: list[tuple[float, float]] = []
    n = len(sorted_slots)
    for i in range(n):
        start_gap = sorted_slots[i]
        end_gap = sorted_slots[(i + 1) % n] if i < n - 1 else sorted_slots[0] + 1440
        gap_duration = end_gap - start_gap
        if gap_duration > 0:
            gaps.append((start_gap, end_gap, gap_duration))

    # Anchor windows to today UTC date
    today_utc = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    windows_saved = 0
    saved_windows: list[MaintenanceWindow] = []

    for gap_start, gap_end, gap_duration in gaps:
        if gap_duration <= min_window_minutes:
            continue

        # Convert minutes-since-midnight to real timestamps
        window_start_dt = today_utc + timedelta(minutes=gap_start)
        # Handle wrap-around: gap_end > 1440 → next day
        if gap_end > 1440:
            window_end_dt = today_utc + timedelta(days=1, minutes=gap_end - 1440)
        else:
            window_end_dt = today_utc + timedelta(minutes=gap_end)

        # Find nearest run to the gap centre (as source_run_id)
        gap_centre = (gap_start + gap_end) / 2.0 % 1440
        nearest_run = min(runs, key=lambda r: min(
            abs(_time_to_minutes(r.scheduled_time) - gap_centre),
            1440 - abs(_time_to_minutes(r.scheduled_time) - gap_centre),
        ))

        window = MaintenanceWindow(
            window_start=window_start_dt,
            window_end=window_end_dt,
            chainage_range_start=CORRIDOR_START_KM,
            chainage_range_end=CORRIDOR_END_KM,
            source_run_id=nearest_run.id,
        )
        db.add(window)
        saved_windows.append(window)
        windows_saved += 1

    db.commit()
    for w in saved_windows:
        db.refresh(w)

    log.info(
        "Timetable analysis: %d runs → %d clusters → %d windows (tau=%d, min=%d)",
        len(runs), n_clusters, windows_saved, tau_minutes, min_window_minutes,
    )

    return {
        "ok": True,
        "clusters_found": n_clusters,
        "virtual_slots": virtual_slot_strings,
        "windows_saved": windows_saved,
        "windows": [
            {
                "id": w.id,
                "window_start": w.window_start,
                "window_end": w.window_end,
                "chainage_range_start": w.chainage_range_start,
                "chainage_range_end": w.chainage_range_end,
                "source_run_id": w.source_run_id,
                "created_at": w.created_at,
            }
            for w in saved_windows
        ],
    }
