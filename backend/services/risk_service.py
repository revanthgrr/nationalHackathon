"""
services/risk_service.py — Stage 3a: database-driven risk prediction service.

Responsibilities:
  1. Extract the four XGBoost features from a record's JSONB payload.
  2. Run the already-loaded XGBoost model.
  3. Persist the result in the risk_predictions table.
  4. Return a structured outcome dict (never raises for expected errors).

Feature extraction rules:
  - Required payload keys: tqi, gmt, age_since_maint, temperature
  - All four must be present — no defaults, no zero-fills.
  - Values must be numeric-coercible floats.
  - Any missing or invalid field → extraction fails with a clear reason.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

import risk_model as risk_module
from models import RawIngestionRecord, RiskPrediction

log = logging.getLogger("railsetu.risk_service")

# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

REQUIRED_FEATURES: frozenset[str] = frozenset({"tqi", "gmt", "age_since_maint", "temperature"})


def extract_risk_features(payload: dict[str, Any]) -> dict:
    """
    Extract and validate XGBoost input features from a raw JSONB payload.

    Returns
    -------
    {"ok": True,  "features": {"tqi": float, ...}}
    {"ok": False, "reason": str}
    """
    if not payload:
        return {"ok": False, "reason": "empty_payload"}

    missing = sorted(REQUIRED_FEATURES - set(payload.keys()))
    if missing:
        return {"ok": False, "reason": f"missing_fields:{','.join(missing)}"}

    features: dict[str, float] = {}
    for key in ("tqi", "gmt", "age_since_maint", "temperature"):
        raw = payload[key]
        try:
            features[key] = float(raw)
        except (TypeError, ValueError):
            return {
                "ok": False,
                "reason": f"invalid_value:{key}={raw!r} (expected numeric)",
            }

    return {"ok": True, "features": features}


# ---------------------------------------------------------------------------
# DB-driven inference + persistence
# ---------------------------------------------------------------------------

def predict_for_record(db: Session, record_id: int) -> dict:
    """
    Fetch record `record_id` from TimescaleDB, extract features, run XGBoost,
    persist the result in risk_predictions, and return the outcome.

    Returns
    -------
    {"ok": True,  "prediction_id": int, "record_id": int, ...all fields...}
    {"ok": False, "reason": str, "record_id": int | None}
    """
    if not risk_module.model_available:
        return {
            "ok": False,
            "reason": f"model_unavailable:{risk_module.load_error}",
            "record_id": record_id,
        }

    # ── Fetch record ──────────────────────────────────────────────────────────
    record: RawIngestionRecord | None = (
        db.query(RawIngestionRecord)
        .filter(RawIngestionRecord.id == record_id)
        .first()
    )
    if record is None:
        return {"ok": False, "reason": "record_not_found", "record_id": record_id}

    # ── Extract features ──────────────────────────────────────────────────────
    extraction = extract_risk_features(record.payload or {})
    if not extraction["ok"]:
        return {
            "ok": False,
            "reason": extraction["reason"],
            "record_id": record_id,
        }

    features = extraction["features"]

    # ── Inference ─────────────────────────────────────────────────────────────
    try:
        result = risk_module.predict_risk(
            tqi             = features["tqi"],
            gmt             = features["gmt"],
            age_since_maint = features["age_since_maint"],
            temperature     = features["temperature"],
        )
    except Exception as exc:
        return {
            "ok": False,
            "reason": f"inference_error:{exc}",
            "record_id": record_id,
        }

    # ── Persist ───────────────────────────────────────────────────────────────
    prediction = RiskPrediction(
        record_id       = record_id,
        tqi             = features["tqi"],
        gmt             = features["gmt"],
        age_since_maint = features["age_since_maint"],
        temperature     = features["temperature"],
        probability     = result["probability"],
        risk_level      = result["risk_level"],
        model_version   = "risk_model_2.json",
    )
    db.add(prediction)
    db.commit()
    db.refresh(prediction)

    log.info(
        "Risk prediction saved: id=%s record_id=%s probability=%.4f risk_level=%s",
        prediction.id, record_id, result["probability"], result["risk_level"],
    )

    return {
        "ok":             True,
        "prediction_id":  prediction.id,
        "record_id":      record_id,
        "tqi":            features["tqi"],
        "gmt":            features["gmt"],
        "age_since_maint": features["age_since_maint"],
        "temperature":    features["temperature"],
        "probability":    result["probability"],
        "risk_level":     result["risk_level"],
        "predicted_at":   prediction.predicted_at,
        "model_version":  "risk_model_2.json",
    }
