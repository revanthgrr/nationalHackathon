"""
risk_model.py — Stage 3a: XGBoost Track-Risk Prediction.

Loads backend/models/risk_model_2.json once at module import time and
exposes predict_risk() for FastAPI endpoint use.  Returns HTTP 503
semantics (via model_available flag) when the model file is absent or
unloadable rather than crashing the application.

Input features (exact order, as trained):
    tqi              — Track Quality Index (float)
    gmt              — Geometry Mean Track (float)
    age_since_maint  — Days since last maintenance (float)
    temperature      — Ambient temperature in °C (float)

Output:
    probability  — 14-day failure probability (float 0–1)
    risk_level   — "low" | "medium" | "high"
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import numpy as np
import xgboost as xgb

log = logging.getLogger("railsetu.risk_model")

# ---------------------------------------------------------------------------
# Model file location
# ---------------------------------------------------------------------------

_MODEL_DIR = Path(__file__).parent / "models"
# The trained file on disk is risk_model_2.json
_MODEL_PATH = _MODEL_DIR / "risk_model_2.json"

# ---------------------------------------------------------------------------
# Risk-level thresholds (architecture spec)
# ---------------------------------------------------------------------------

_THRESHOLD_LOW    = 0.3
_THRESHOLD_HIGH   = 0.7

# ---------------------------------------------------------------------------
# Feature ordering (must match training column order exactly)
# ---------------------------------------------------------------------------

FEATURE_ORDER: list[str] = ["tqi", "gmt", "age_since_maint", "temperature"]

# ---------------------------------------------------------------------------
# Singleton model state
# ---------------------------------------------------------------------------

_booster:         xgb.Booster | None = None
model_available:  bool = False
load_error:       str | None = None


def _load_model() -> None:
    """Load the XGBoost Booster from disk.  Called once at startup."""
    global _booster, model_available, load_error

    if not _MODEL_PATH.exists():
        load_error = f"Model file not found: {_MODEL_PATH}"
        log.error(load_error)
        return

    try:
        booster = xgb.Booster()
        booster.load_model(str(_MODEL_PATH))
        _booster = booster
        model_available = True
        log.info("XGBoost risk model loaded from %s", _MODEL_PATH)
    except Exception as exc:
        load_error = f"Failed to load XGBoost model: {exc}"
        log.error(load_error)


# Load eagerly when the module is imported (FastAPI imports this at startup)
_load_model()


# ---------------------------------------------------------------------------
# Risk level helper
# ---------------------------------------------------------------------------

def _risk_level(probability: float) -> str:
    if probability < _THRESHOLD_LOW:
        return "low"
    if probability <= _THRESHOLD_HIGH:
        return "medium"
    return "high"


# ---------------------------------------------------------------------------
# Public inference API
# ---------------------------------------------------------------------------

def predict_risk(
    tqi: float,
    gmt: float,
    age_since_maint: float,
    temperature: float,
) -> dict:
    """
    Run inference with the loaded XGBoost model.

    Returns
    -------
    dict with keys:
        probability  : float   — 14-day failure probability
        risk_level   : str     — "low" | "medium" | "high"
        model_available : bool — always True here (caller checks before calling)
    """
    if not model_available or _booster is None:
        raise RuntimeError(load_error or "Model not available")

    # Build DMatrix in the exact feature order used during training
    features = np.array([[tqi, gmt, age_since_maint, temperature]], dtype=np.float32)
    dmatrix  = xgb.DMatrix(features, feature_names=FEATURE_ORDER)

    raw = _booster.predict(dmatrix)
    probability = float(raw[0])

    return {
        "probability":      round(probability, 6),
        "risk_level":       _risk_level(probability),
        "model_available":  True,
    }


# ---------------------------------------------------------------------------
# SHAP explainability
# ---------------------------------------------------------------------------

_explainer: "shap.TreeExplainer | None" = None


def _get_explainer():
    """Lazily create the SHAP TreeExplainer (first call only)."""
    global _explainer
    if _explainer is None and _booster is not None:
        try:
            import shap
            _explainer = shap.TreeExplainer(_booster)
            log.info("SHAP TreeExplainer initialised for XGBoost risk model")
        except Exception as exc:
            log.error("Failed to create SHAP explainer: %s", exc)
    return _explainer


def compute_shap_values(
    tqi: float,
    gmt: float,
    age_since_maint: float,
    temperature: float,
) -> dict | None:
    """
    Compute SHAP values for a single prediction.

    Returns
    -------
    dict with keys:
        base_value     : float  — expected model output
        shap_values    : dict   — {feature_name: shap_value}
        feature_values : dict   — {feature_name: input_value}
    or None if the explainer is unavailable.
    """
    explainer = _get_explainer()
    if explainer is None:
        return None

    import shap

    features = np.array([[tqi, gmt, age_since_maint, temperature]], dtype=np.float32)
    dmatrix = xgb.DMatrix(features, feature_names=FEATURE_ORDER)

    try:
        explanation = explainer(dmatrix)
        sv = explanation.values[0]       # shape (4,)
        bv = float(explanation.base_values[0])
    except Exception as exc:
        log.error("SHAP computation failed: %s", exc)
        return None

    return {
        "base_value": round(bv, 6),
        "shap_values": {
            FEATURE_ORDER[i]: round(float(sv[i]), 6)
            for i in range(len(FEATURE_ORDER))
        },
        "feature_values": {
            "tqi": tqi,
            "gmt": gmt,
            "age_since_maint": age_since_maint,
            "temperature": temperature,
        },
    }

