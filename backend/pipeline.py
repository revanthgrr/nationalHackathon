"""
pipeline.py — RailSetu end-to-end pipeline orchestrator (Stages 2 → 3a → 3b).

This module coordinates the three downstream stages without duplicating
any business logic — each stage's logic stays in its own module:

  chainage.py            — Stage 2 resolution
  services/risk_service  — Stage 3a feature extraction + inference + persist
  services/delay_service — Stage 3b window builder + inference + persist

Typical usage:
  result = run_full_pipeline(db)

The function is idempotent in the sense that:
  - Stage 2 only processes records still flagged chainage_processed=False.
  - Stage 3a runs only on chainage-processed records that have no existing
    prediction yet. Records that already have a saved prediction are skipped
    (counted as skipped_ineligible) to avoid duplicate rows.
  - Stage 3b always uses the current 60-minute observation window.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

import chainage as chainage_module
from models import RawIngestionRecord, RiskPrediction
from services.delay_service import predict_latest as delay_predict_latest
from services.risk_service import extract_risk_features, predict_for_record

log = logging.getLogger("railsetu.pipeline")


def run_full_pipeline(db: Session) -> dict:
    """
    Run Stages 2 → 3a → 3b in sequence.

    Returns
    -------
    {
        "chainage": {"processed": int, "failed": int, "failures": [...]},
        "risk":     {"attempted": int, "succeeded": int,
                     "skipped_ineligible": int, "failed": int,
                     "details": [...]},
        "delay":    {"ok": bool, ...run details or error details...},
    }
    """
    result: dict = {
        "chainage": {"processed": 0, "failed": 0, "failures": []},
        "risk":     {
            "attempted":          0,
            "succeeded":          0,
            "skipped_ineligible": 0,
            "failed":             0,
            "details":            [],
        },
        "delay":    {},
    }

    # ── Stage 2 — Chainage ────────────────────────────────────────────────────
    log.info("[Pipeline] Stage 2 — processing unprocessed records")
    unprocessed: list[RawIngestionRecord] = (
        db.query(RawIngestionRecord)
        .filter(RawIngestionRecord.chainage_processed == False)   # noqa: E712
        .order_by(RawIngestionRecord.ingested_at)
        .all()
    )

    for record in unprocessed:
        chainage_km, error_reason = chainage_module.resolve_chainage(record)

        if error_reason is None and chainage_km is not None:
            record.chainage_km        = chainage_km
            record.chainage_processed = True
            record.chainage_error     = None
            try:
                db.commit()
                result["chainage"]["processed"] += 1
                log.debug(
                    "[Pipeline] Chainage OK: id=%s chainage=%.3f km", record.id, chainage_km
                )
            except Exception as exc:
                db.rollback()
                log.error("[Pipeline] DB commit failed for id=%s: %s", record.id, exc)
                result["chainage"]["failed"] += 1
                result["chainage"]["failures"].append(
                    {"id": record.id, "reason": "db_commit_error"}
                )
        else:
            record.chainage_error = error_reason
            try:
                db.commit()
            except Exception:
                db.rollback()
            result["chainage"]["failed"] += 1
            result["chainage"]["failures"].append(
                {"id": record.id, "reason": error_reason or "unknown"}
            )

    log.info(
        "[Pipeline] Stage 2 done: processed=%d failed=%d",
        result["chainage"]["processed"], result["chainage"]["failed"],
    )

    # ── Stage 3a — Risk prediction for eligible processed records ─────────────
    log.info("[Pipeline] Stage 3a — risk prediction for chainage-processed records")
    processed_records: list[RawIngestionRecord] = (
        db.query(RawIngestionRecord)
        .filter(RawIngestionRecord.chainage_processed == True)    # noqa: E712
        .all()
    )

    # Build a set of record IDs that already have at least one saved prediction
    # so we don't multiply rows on every pipeline run.
    already_predicted: set[int] = {
        row[0]
        for row in db.query(RiskPrediction.record_id).distinct().all()
    }

    for record in processed_records:
        if record.id in already_predicted:
            result["risk"]["skipped_ineligible"] += 1
            log.debug(
                "[Pipeline] Risk skip id=%s: already predicted", record.id
            )
            continue

        extraction = extract_risk_features(record.payload or {})
        if not extraction["ok"]:
            result["risk"]["skipped_ineligible"] += 1
            log.debug(
                "[Pipeline] Risk skip id=%s: %s", record.id, extraction["reason"]
            )
            continue

        result["risk"]["attempted"] += 1
        outcome = predict_for_record(db, record.id)

        if outcome.get("ok"):
            result["risk"]["succeeded"] += 1
            result["risk"]["details"].append({
                "record_id":       record.id,
                "prediction_id":   outcome["prediction_id"],
                "probability":     outcome["probability"],
                "risk_level":      outcome["risk_level"],
            })
        else:
            result["risk"]["failed"] += 1
            result["risk"]["details"].append({
                "record_id": record.id,
                "error":     outcome.get("reason"),
            })

    log.info(
        "[Pipeline] Stage 3a done: attempted=%d succeeded=%d skipped=%d failed=%d",
        result["risk"]["attempted"],
        result["risk"]["succeeded"],
        result["risk"]["skipped_ineligible"],
        result["risk"]["failed"],
    )

    # ── Stage 3b — Delay prediction from latest DB observations ───────────────
    log.info("[Pipeline] Stage 3b — delay prediction from DB window")
    delay_result = delay_predict_latest(db)
    result["delay"] = delay_result

    if delay_result.get("ok"):
        log.info(
            "[Pipeline] Stage 3b done: run_id=%s", delay_result.get("run_id")
        )
    else:
        log.warning(
            "[Pipeline] Stage 3b incomplete: %s", delay_result.get("reason")
        )

    return result
