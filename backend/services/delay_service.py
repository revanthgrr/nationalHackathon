"""
services/delay_service.py — Stage 3b: database-driven delay prediction service.

Responsibilities:
  1. Query TimescaleDB for the last 60 minutes of delay observations.
  2. Group observations into 12 × 5-minute bins (matching training cadence).
  3. Map each observation to one of the 5 canonical stations.
  4. Construct the 12 × 5 input matrix (no silent zero-filling).
  5. Run the GCN-LSTM model.
  6. Persist results in delay_predictions (one row per station).

Canonical delay field in payload: `delay_minutes` (float).

Station order (fixed, must match training data):
    [SC, MJF, AWL, GHKT, BBN]

Time window: 12 steps × 5 minutes = 60 minutes.

Temporal ordering priority:
    1. observation_time column (set from CSV upload with explicit timestamps)
    2. ingested_at column (fallback for records without observation_time)

This means CSV uploads with back-dated observation_time values are used
for model sequencing, while live records without observation_time use the
ingestion timestamp as before (backwards compatible).

Window anchor:
    When records have observation_time → window is anchored to
    max(observation_time) in the dataset, not to now().  This allows
    historical CSV uploads to build a valid 12×5 window even if the data
    is hours or days old.

    When records lack observation_time → window is anchored to now()
    (original behaviour).

If the window is incomplete (missing bins or stations), the service returns
an `insufficient_history` condition with clear diagnostics.
"""

from __future__ import annotations

import logging
import math
import uuid

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

import delay_model as delay_module
from delay_model import N_STATIONS, SEQ_LEN, STATIONS
from models import DelayPrediction, RawIngestionRecord

log = logging.getLogger("railsetu.delay_service")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# 5-minute bins (training assumption: 12 steps × 5 min = 60-min window)
BIN_MINUTES:    int = 5
WINDOW_MINUTES: int = SEQ_LEN * BIN_MINUTES   # 60 minutes

# Fast station → index lookup
_STATION_INDEX: dict[str, int] = {s: i for i, s in enumerate(STATIONS)}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _effective_time(record: RawIngestionRecord) -> datetime:
    """
    Return the best timestamp for ordering a record in the delay window.

    Priority:
      1. observation_time (explicitly set; timezone-aware)
      2. ingested_at     (database write timestamp)
    """
    t = record.observation_time or record.ingested_at
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    else:
        t = t.astimezone(timezone.utc)
    return t


# ---------------------------------------------------------------------------
# Window builder
# ---------------------------------------------------------------------------

def build_delay_window(db: Session) -> dict:
    """
    Query recent delay observations from TimescaleDB and build the 12 × 5
    input matrix required by the GCN-LSTM model.

    Requirements per qualifying record:
      - station_code in {SC, MJF, AWL, GHKT, BBN}
      - payload["delay_minutes"] exists and is a finite number

    Temporal ordering:
      - Uses observation_time when present; falls back to ingested_at.
      - Window is anchored to max(effective_time) in the dataset, so that
        historical CSV uploads (not real-time) build a valid window.

    Returns
    -------
    {
        "ok": True,
        "sequence": [[float × 5] × 12],   # oldest step first
        "window_start": datetime,
        "window_end":   datetime,
        "obs_count":    int,               # qualifying observations used
    }
    — or —
    {
        "ok": False,
        "reason": "insufficient_history",
        "detail": str,
        "steps_available": int,
        "steps_needed": int,
    }
    """
    # ── Step 1: find anchor time ──────────────────────────────────────────────
    # Prefer the latest observation_time; fall back to latest ingested_at.
    # This allows historical CSV uploads to work correctly.
    latest_obs: datetime | None = (
        db.query(func.max(RawIngestionRecord.observation_time))
        .filter(
            RawIngestionRecord.station_code.in_(STATIONS),
            RawIngestionRecord.observation_time.isnot(None),
        )
        .scalar()
    )

    if latest_obs is not None:
        # Anchor window to latest observation_time in dataset
        if latest_obs.tzinfo is None:
            latest_obs = latest_obs.replace(tzinfo=timezone.utc)
        else:
            latest_obs = latest_obs.astimezone(timezone.utc)
        anchor_time  = latest_obs
        use_obs_time = True
    else:
        # No observation_time set → use now() (original behaviour)
        anchor_time  = datetime.now(timezone.utc)
        use_obs_time = False

    window_start = anchor_time - timedelta(minutes=WINDOW_MINUTES)
    window_end   = anchor_time

    log.info(
        "Delay window: anchor=%s use_obs_time=%s window=[%s → %s]",
        anchor_time.isoformat(), use_obs_time,
        window_start.isoformat(), window_end.isoformat(),
    )

    # ── Step 2: fetch eligible records ────────────────────────────────────────
    if use_obs_time:
        records: list[RawIngestionRecord] = (
            db.query(RawIngestionRecord)
            .filter(
                RawIngestionRecord.observation_time >= window_start,
                RawIngestionRecord.observation_time <= window_end,
                RawIngestionRecord.station_code.in_(STATIONS),
            )
            .order_by(RawIngestionRecord.observation_time.asc())
            .all()
        )
    else:
        records = (
            db.query(RawIngestionRecord)
            .filter(
                RawIngestionRecord.ingested_at >= window_start,
                RawIngestionRecord.ingested_at <= window_end,
                RawIngestionRecord.station_code.in_(STATIONS),
            )
            .order_by(RawIngestionRecord.ingested_at.asc())
            .all()
        )

    # Keep only those with a valid finite delay_minutes in payload
    eligible = [
        r for r in records
        if r.payload
        and "delay_minutes" in r.payload
        and isinstance(r.payload["delay_minutes"], (int, float))
        and math.isfinite(r.payload["delay_minutes"])
    ]

    if not eligible:
        return {
            "ok": False,
            "reason": "insufficient_history",
            "detail": (
                "No records with delay_minutes in payload found "
                f"in the {WINDOW_MINUTES}-minute window ending at {anchor_time.isoformat()}."
            ),
            "steps_available": 0,
            "steps_needed": SEQ_LEN,
        }

    # ── Step 3: bin observations into 5-minute slots ──────────────────────────
    # bins[bin_index][station_code] = latest delay_minutes value in that bin
    bins: dict[int, dict[str, float]] = defaultdict(dict)

    for r in eligible:
        eff_time  = _effective_time(r)
        elapsed_s = (eff_time - window_start).total_seconds()
        bin_idx   = int(elapsed_s // (BIN_MINUTES * 60))
        bin_idx   = min(max(bin_idx, 0), SEQ_LEN - 1)

        station = (r.station_code or "").strip().upper()
        if station not in _STATION_INDEX:
            continue

        try:
            val = float(r.payload["delay_minutes"])
            if not math.isfinite(val):
                continue
        except (TypeError, ValueError):
            continue

        # Last write wins within a bin (newest observation in that bin)
        bins[bin_idx][station] = val

    # ── Step 4: check bin coverage ────────────────────────────────────────────
    bins_with_data = [t for t in range(SEQ_LEN) if bins.get(t)]
    if len(bins_with_data) < SEQ_LEN:
        return {
            "ok": False,
            "reason": "insufficient_history",
            "detail": (
                f"Only {len(bins_with_data)} of {SEQ_LEN} time steps "
                f"({BIN_MINUTES}-min bins) have data. "
                f"Window: {window_start.isoformat()} → {window_end.isoformat()}."
            ),
            "steps_available": len(bins_with_data),
            "steps_needed": SEQ_LEN,
        }

    # ── Step 5: build 12 × 5 sequence (forward-fill within window) ───────────
    # If a station is missing from a bin but appeared earlier → carry forward.
    # If a station has NO data at all in the entire window → failure (no guessing).
    last_known: dict[str, float] = {}
    sequence:   list[list[float]] = []

    for t in range(SEQ_LEN):
        row: list[float] = []
        for station in STATIONS:
            if station in bins[t]:
                last_known[station] = bins[t][station]

            val = last_known.get(station)
            if val is None:
                return {
                    "ok": False,
                    "reason": "insufficient_history",
                    "detail": (
                        f"Station {station} has no delay_minutes observation "
                        f"in the entire {WINDOW_MINUTES}-minute window."
                    ),
                    "steps_available": 0,
                    "steps_needed": SEQ_LEN,
                }
            row.append(val)
        sequence.append(row)

    obs_count = sum(len(b) for b in bins.values())
    log.info(
        "Built delay window: %d qualifying observations → %d×%d matrix",
        obs_count, SEQ_LEN, N_STATIONS,
    )

    return {
        "ok":           True,
        "sequence":     sequence,
        "window_start": window_start,
        "window_end":   window_end,
        "obs_count":    obs_count,
    }


# ---------------------------------------------------------------------------
# DB-driven inference + persistence
# ---------------------------------------------------------------------------

def predict_latest(db: Session) -> dict:
    """
    Build the 12 × 5 input matrix from TimescaleDB, run the GCN-LSTM model,
    persist all five station predictions under a shared run_id, and return
    the full outcome.

    Returns
    -------
    {"ok": True,  "run_id": str, "predicted_at": datetime, ...predictions...}
    {"ok": False, "reason": str, ...diagnostics...}
    """
    if not delay_module.model_available:
        return {
            "ok": False,
            "reason": f"model_unavailable:{delay_module.load_error}",
        }

    # ── Build window ──────────────────────────────────────────────────────────
    window_result = build_delay_window(db)
    if not window_result["ok"]:
        return window_result   # propagate insufficient_history details

    sequence     = window_result["sequence"]
    window_start = window_result["window_start"]
    window_end   = window_result["window_end"]
    obs_count    = window_result["obs_count"]

    # ── Inference ─────────────────────────────────────────────────────────────
    try:
        station_delays = delay_module.predict_delay(sequence)
    except Exception as exc:
        return {"ok": False, "reason": f"inference_error:{exc}"}

    # ── Persist (one row per station, same run_id) ────────────────────────────
    run_id      = str(uuid.uuid4())
    saved_preds: list[DelayPrediction] = []

    for sd in station_delays:
        pred = DelayPrediction(
            run_id                  = run_id,
            input_window_start      = window_start,
            input_window_end        = window_end,
            obs_count               = obs_count,
            station_code            = sd["station"],
            predicted_delay_minutes = sd["predicted_delay_minutes"],
            model_version           = "delay_model.pt",
        )
        db.add(pred)
        saved_preds.append(pred)

    db.commit()
    for p in saved_preds:
        db.refresh(p)

    predicted_at = saved_preds[0].predicted_at if saved_preds else datetime.now(timezone.utc)

    log.info(
        "Delay prediction run saved: run_id=%s stations=%d obs_used=%d",
        run_id, len(saved_preds), obs_count,
    )

    return {
        "ok":                True,
        "run_id":            run_id,
        "predicted_at":      predicted_at,
        "input_window_start": window_start,
        "input_window_end":  window_end,
        "obs_count":         obs_count,
        "predictions": [
            {
                "station":                   p.station_code,
                "predicted_delay_minutes":   p.predicted_delay_minutes,
            }
            for p in saved_preds
        ],
    }
