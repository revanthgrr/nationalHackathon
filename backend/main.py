"""
main.py — RailSetu Data Ingestion, Chainage Mapping & ML Prediction (Stages 1-3).

Endpoints
---------
POST /ingest/tms    — Track Measurement System
POST /ingest/smms   — Signal & Maintenance Monitoring System
POST /ingest/tdms   — Train Dynamics Monitoring System
POST /ingest/coa    — Change-of-Asset system

GET  /ingest/unprocessed    — All records where chainage_processed = False
                              (consumed by Stage 2)

POST /chainage/process      — Convert location signals to chainage_km for
                              all unprocessed records (Stage 2)
GET  /chainage/lookup       — Ad-hoc single-location chainage lookup
                               (lat/lon, station_code, or mast_id)

POST /predict/risk          — XGBoost 14-day failure probability (Stage 3a)
POST /predict/delay         — GCN-LSTM station delay prediction (Stage 3b)

GET  /health                — Simple health check

Startup
-------
1. Creates all SQLAlchemy-managed tables (idempotent via checkfirst=True).
2. Enables the TimescaleDB extension (IF NOT EXISTS — idempotent).
3. Converts raw_ingestion_records into a hypertable partitioned by
   ingested_at (if_not_exists=TRUE — idempotent).
4. Adds chainage_error column if it does not already exist (safe ALTER).
5. Logs ML model load status (XGBoost + GCN-LSTM).
"""

import csv
from datetime import datetime, timezone
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

import chainage as chainage_module  # Stage 2 conversion logic
import models  # noqa: F401 — registers ORM models against Base.metadata
import risk_model as risk_module    # Stage 3a — XGBoost
import delay_model as delay_module  # Stage 3b — GCN-LSTM
import timetable_service            # Stage 4 — Timetable Analysis
import scheduler as scheduler_module  # Stage 5 — CP-SAT
import bundler as bundler_module     # Stage 6 — VNS Bundler
from notifications import execute_schedule, send_notification  # Stage 8
import letters as letters_module  # Block sanction letters
from database import Base, SessionLocal, engine, get_db
from models import (
    DelayPrediction,
    DisruptionEvent,
    MaintenanceTask,
    MaintenanceWindow,
    Notification,
    RawIngestionRecord,
    RiskPrediction,
    ScheduledBlock,
    TrainRun,
    User,
)
from pipeline import run_full_pipeline
from services.delay_service import predict_latest as delay_predict_latest
from services.risk_service import extract_risk_features, predict_for_record
from services.task_service import auto_generate_tasks_from_risk
from schemas import (
    BlockDecisionRequest,
    BundleRequest,
    BundleResponse,
    ChainageFailure,
    ChainageLookupResponse,
    ChainageProcessResponse,
    DelayPredictionRequest,
    DelayPredictionResponse,
    DelayPredictionRunResponse,
    DisruptionEventResponse,
    DisruptionRequest,
    DisruptionResponse,
    EnrichedBlockResponse,
    HealthResponse,
    IneligibleRecordResponse,
    IngestRequest,
    IngestResponse,
    InsufficientHistoryResponse,
    MaintenanceTaskRequest,
    MaintenanceTaskResponse,
    MaintenanceWindowResponse,
    PipelineChainageResult,
    PipelineRiskResult,
    PipelineRunResponse,
    PipelineStatusResponse,
    RiskPredictionByRecordResponse,
    RiskPredictionRecord,
    RiskPredictionRequest,
    RiskPredictionResponse,
    ScheduledBlockResponse,
    ScheduleOptimizeRequest,
    ScheduleOptimizeResponse,
    StationDelay,
    TimetableAnalyzeRequest,
    TimetableAnalyzeResponse,
    TrainRunRequest,
    TrainRunResponse,
    UnprocessedRecord,
    NotificationResponse,
    ShapExplanation,
    EnrichedBlockWithShap,
    PreviewBlockResponse,
    SchedulePreviewResponse,
    LetterResponse,
)
from auth import (
    LoginRequest,
    LoginResponse,
    UserResponse,
    create_access_token,
    get_current_user,
    get_current_user_required,
    require_role,
    verify_password,
)
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")
log = logging.getLogger("railsetu.ingestion")

# ---------------------------------------------------------------------------
# Valid source system identifiers
# ---------------------------------------------------------------------------
SOURCE_TMS = "TMS"
SOURCE_SMMS = "SMMS"
SOURCE_TDMS = "TDMS"
SOURCE_COA = "COA"


# ---------------------------------------------------------------------------
# Startup / shutdown lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan handler — runs once on startup, once on shutdown.
    All DDL steps are idempotent and safe to re-run on every restart.
    ML models are loaded eagerly when their modules are imported above;
    we only log their status here.
    """
    log.info("=== RailSetu Pipeline — startup ===")

    # 1. Create tables (SQLAlchemy checkfirst=True → no-op if already present)
    log.info("Creating tables (if they do not exist)…")
    Base.metadata.create_all(bind=engine, checkfirst=True)
    log.info("Tables: OK")

    with engine.begin() as conn:
        # 2. Enable TimescaleDB extension
        log.info("Enabling TimescaleDB extension…")
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"))
        log.info("TimescaleDB extension: OK")

        # 3. Convert raw_ingestion_records to a hypertable
        #    if_not_exists=TRUE makes this a no-op on subsequent restarts.
        log.info("Converting raw_ingestion_records to hypertable…")
        conn.execute(
            text(
                """
                SELECT create_hypertable(
                    'raw_ingestion_records',
                    'ingested_at',
                    if_not_exists => TRUE
                );
                """
            )
        )
        log.info("Hypertable: OK")

        # 4. Add chainage_error column if it does not already exist.
        #    This is a migration-safe ALTER — IF NOT EXISTS prevents errors
        #    on fresh databases where create_all already added the column.
        log.info("Ensuring chainage_error column exists…")
        conn.execute(
            text(
                """
                ALTER TABLE raw_ingestion_records
                    ADD COLUMN IF NOT EXISTS chainage_error VARCHAR(100);
                """
            )
        )
        log.info("chainage_error column: OK")

        # 5. Add observation_time column (idempotent)
        log.info("Ensuring observation_time column exists…")
        conn.execute(
            text(
                """
                ALTER TABLE raw_ingestion_records
                    ADD COLUMN IF NOT EXISTS observation_time TIMESTAMPTZ;
                """
            )
        )
        log.info("observation_time column: OK")

        # 6. Add obs_count to delay_predictions (idempotent)
        log.info("Ensuring delay_predictions.obs_count column exists…")
        conn.execute(
            text(
                """
                ALTER TABLE delay_predictions
                    ADD COLUMN IF NOT EXISTS obs_count INTEGER;
                """
            )
        )
        log.info("obs_count column: OK")

    # 7. Log ML model load status
    log.info(
        "XGBoost risk model: %s",
        "OK" if risk_module.model_available else f"UNAVAILABLE — {risk_module.load_error}",
    )
    log.info(
        "GCN-LSTM delay model: %s",
        "OK" if delay_module.model_available else f"UNAVAILABLE — {delay_module.load_error}",
    )

    log.info("=== Startup complete — Stages 1-9 ready ===")
    yield
    log.info("=== RailSetu Pipeline — shutdown ===")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="RailSetu — Railway Maintenance Pipeline",
    description=(
        "Stages 1–9 of the RailSetu railway maintenance pipeline (SC→BBN corridor). "
        "Stage 1 ingests raw telemetry; Stage 2 resolves chainage; "
        "Stage 3a/3b run XGBoost risk and GCN-LSTM delay prediction; "
        "Stage 4 clusters timetables into maintenance windows; "
        "Stage 5 runs CP-SAT scheduling optimisation; "
        "Stage 6 applies VNS joint-block bundling; "
        "Stage 7 handles field-controller accept/reject decisions; "
        "Stage 8 sends email notifications via SMTP; "
        "Stage 9 monitors disruptions and triggers rolling-horizon re-optimisation."
    ),
    version="0.9.0",
    lifespan=lifespan,
)

# Allow the Vite dev server (and any origin in dev) to call the API.
# In production, restrict origins to the deployed frontend URL.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DbDep = Annotated[Session, Depends(get_db)]


# ---------------------------------------------------------------------------
# Custom exception handler — convert location-constraint violations to 400
# ---------------------------------------------------------------------------

_LOCATION_KEYWORDS = ("location field", "latitude and longitude")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """
    FastAPI by default returns 422 for Pydantic validation errors.
    We intercept errors that originate from the location-constraint
    validator and return a 400 Bad Request with a human-readable message
    instead, as the spec requires.
    """
    errors = exc.errors()
    location_errors = [
        e for e in errors
        if any(kw in str(e.get("msg", "")).lower() for kw in _LOCATION_KEYWORDS)
    ]
    if location_errors:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error": "missing_location",
                "detail": location_errors[0]["msg"],
            },
        )
    # All other validation errors stay as 422 Unprocessable Entity.
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": errors},
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_unprocessed_records(db: Session) -> list[RawIngestionRecord]:
    """Return all records where chainage_processed is False, ordered by ingested_at."""
    return (
        db.query(RawIngestionRecord)
        .filter(RawIngestionRecord.chainage_processed == False)  # noqa: E712
        .order_by(RawIngestionRecord.ingested_at)
        .all()
    )

def _ingest(db: Session, source_system: str, body: IngestRequest) -> RawIngestionRecord:
    """
    Persist one validated ingestion record and return the ORM instance.

    The Pydantic model_validator already guarantees that at least one
    location field is present, so no extra check is needed here.
    """
    record = RawIngestionRecord(
        source_system=source_system,
        latitude=body.latitude,
        longitude=body.longitude,
        station_code=body.station_code,
        mast_id=body.mast_id,
        payload=body.payload,
        # chainage_km stays NULL — filled by the next pipeline stage
        # chainage_processed defaults to False via server_default
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    log.info("Ingested record id=%s source=%s", record.id, record.source_system)
    return record


# ---------------------------------------------------------------------------
# Ingestion endpoints
# ---------------------------------------------------------------------------

@app.post(
    "/ingest/tms",
    response_model=IngestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Track Measurement System record",
    tags=["Ingestion"],
)
def ingest_tms(body: IngestRequest, db: DbDep):
    """
    Accepts a TMS record.

    Typical payload fields: `tqi` (Track Quality Index), `gmt_index`,
    `cross_level`, `alignment_deviation`.
    """
    return _ingest(db, SOURCE_TMS, body)


@app.post(
    "/ingest/smms",
    response_model=IngestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Signal & Maintenance Monitoring System record",
    tags=["Ingestion"],
)
def ingest_smms(body: IngestRequest, db: DbDep):
    """
    Accepts an SMMS record.

    Typical payload fields: `relay_voltage`, `track_circuit_status`,
    `signal_aspect`, `battery_voltage`.
    """
    return _ingest(db, SOURCE_SMMS, body)


@app.post(
    "/ingest/tdms",
    response_model=IngestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Train Dynamics Monitoring System record",
    tags=["Ingestion"],
)
def ingest_tdms(body: IngestRequest, db: DbDep):
    """
    Accepts a TDMS record.

    Typical payload fields: `speed_kmh`, `vertical_acceleration_g`,
    `lateral_acceleration_g`, `brake_cylinder_pressure_bar`.
    """
    return _ingest(db, SOURCE_TDMS, body)


@app.post(
    "/ingest/coa",
    response_model=IngestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Change-of-Asset record",
    tags=["Ingestion"],
)
def ingest_coa(body: IngestRequest, db: DbDep):
    """
    Accepts a COA record.

    Typical payload fields: `asset_type`, `old_asset_id`, `new_asset_id`,
    `replacement_date`, `replaced_by`.
    """
    return _ingest(db, SOURCE_COA, body)


# ---------------------------------------------------------------------------
# Pipeline consumer endpoints
# ---------------------------------------------------------------------------

@app.get(
    "/ingest/records",
    response_model=list[UnprocessedRecord],
    summary="Fetch ALL ingestion records (processed and unprocessed)",
    tags=["Pipeline"],
)
def get_all_records(db: DbDep):
    """
    Returns every record in raw_ingestion_records, ordered by ingested_at DESC.
    Unlike /ingest/unprocessed, this includes already-processed records — used
    by the frontend to display full chainage state.
    """
    records = (
        db.query(RawIngestionRecord)
        .order_by(RawIngestionRecord.ingested_at.desc())
        .all()
    )
    return records


@app.get(
    "/ingest/unprocessed",
    response_model=list[UnprocessedRecord],
    summary="Fetch all records pending chainage mapping",
    tags=["Pipeline"],
)
def get_unprocessed(db: DbDep):
    """
    Returns every record where `chainage_processed = False`.

    This is the feed for Stage 2 (chainage mapping), which will read from
    here, compute chainage_km, then flip chainage_processed to True.
    """
    records = _get_unprocessed_records(db)
    log.info("Unprocessed records returned: %d", len(records))
    return records


# ---------------------------------------------------------------------------
# Stage 2 — Chainage processing endpoints
# ---------------------------------------------------------------------------

@app.post(
    "/chainage/process",
    response_model=ChainageProcessResponse,
    summary="Process all unprocessed records: resolve chainage_km for each",
    tags=["Chainage"],
)
def process_chainage(db: DbDep):
    """
    For every record where `chainage_processed = False`:

    - Calls `resolve_chainage()` from the chainage module.
    - On **success**: sets `chainage_km` and flips `chainage_processed` to
      `True`, then commits that record immediately.
    - On **failure**: sets `chainage_error` with the reason string and leaves
      `chainage_processed = False` so the record stays in the unprocessed
      feed.  Commits the error annotation so the reason is visible.
    - One bad record never aborts the rest of the batch.

    Returns a JSON summary with counts and per-record failure details.
    """
    records = _get_unprocessed_records(db)
    log.info("Processing %d unprocessed records", len(records))

    processed_count = 0
    failures: list[ChainageFailure] = []

    for record in records:
        chainage_km, error_reason = chainage_module.resolve_chainage(record)

        if error_reason is None and chainage_km is not None:
            # Success path
            record.chainage_km = chainage_km
            record.chainage_processed = True
            record.chainage_error = None
            try:
                db.commit()
                processed_count += 1
                log.info(
                    "Committed chainage for record id=%s: %.3f km",
                    record.id, chainage_km,
                )
            except Exception as exc:
                db.rollback()
                log.error(
                    "Failed to commit record id=%s: %s", record.id, exc
                )
                failures.append(ChainageFailure(id=record.id, reason="db_commit_error"))
        else:
            # Failure path — record the reason but leave chainage_processed False
            record.chainage_error = error_reason
            try:
                db.commit()
            except Exception as exc:
                db.rollback()
                log.error(
                    "Failed to commit error annotation for record id=%s: %s",
                    record.id, exc,
                )
            failures.append(
                ChainageFailure(id=record.id, reason=error_reason or "unknown")
            )
            log.warning(
                "Record id=%s failed chainage resolution: %s", record.id, error_reason
            )

    log.info(
        "Chainage batch complete: processed=%d, failed=%d",
        processed_count, len(failures),
    )
    return ChainageProcessResponse(
        processed=processed_count,
        failed=len(failures),
        failures=failures,
    )


@app.get(
    "/chainage/lookup",
    response_model=ChainageLookupResponse,
    summary="Ad-hoc chainage lookup without touching the database",
    tags=["Chainage"],
)
def lookup_chainage(
    lat: Optional[float] = Query(default=None, description="WGS-84 latitude", ge=-90.0, le=90.0),
    lon: Optional[float] = Query(default=None, description="WGS-84 longitude", ge=-180.0, le=180.0),
    station_code: Optional[str] = Query(default=None, description="Indian Railways station code"),
    mast_id: Optional[str] = Query(default=None, description="OHE traction mast identifier"),
):
    """
    Resolve chainage_km for a single ad-hoc location without touching the
    database.  Useful for testing the conversion logic from /docs.

    Provide exactly one of:
    - `lat` **and** `lon` (both required together)
    - `station_code`
    - `mast_id`
    """
    # --- GPS ---
    if lat is not None and lon is not None:
        chainage_km = chainage_module.project_gps_to_chainage(lat, lon)
        return ChainageLookupResponse(chainage_km=chainage_km, source="gps", error=None)

    if lat is not None or lon is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="lat and lon must both be provided together.",
        )

    # --- Station code ---
    if station_code is not None:
        code = station_code.strip().upper()
        if code in chainage_module.STATION_CHAINAGE_MAP:
            return ChainageLookupResponse(
                chainage_km=chainage_module.STATION_CHAINAGE_MAP[code],
                source="station_code",
                error=None,
            )
        return ChainageLookupResponse(
            chainage_km=None, source="station_code", error="unknown_station_code"
        )

    # --- Mast ID ---
    if mast_id is not None:
        mast = mast_id.strip().upper()
        if mast in chainage_module.MAST_CHAINAGE_MAP:
            return ChainageLookupResponse(
                chainage_km=chainage_module.MAST_CHAINAGE_MAP[mast],
                source="mast_id",
                error=None,
            )
        return ChainageLookupResponse(
            chainage_km=None, source="mast_id", error="unknown_mast_id"
        )

    # No parameter provided
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Provide one of: (lat + lon), station_code, or mast_id.",
    )


# ---------------------------------------------------------------------------
# Stage 3a — XGBoost Risk Prediction
# ---------------------------------------------------------------------------

@app.post(
    "/predict/risk",
    response_model=RiskPredictionResponse,
    summary="Predict 14-day track failure probability (XGBoost)",
    tags=["Prediction"],
)
def predict_risk(body: RiskPredictionRequest):
    """
    Runs the pre-trained XGBoost binary-logistic model.

    Input features (validated, 0–100 range for TQI/GMT):
    - **tqi** — Track Quality Index
    - **gmt** — Geometry Mean Track index
    - **age_since_maint** — Days since last maintenance (≥ 0)
    - **temperature** — Ambient temperature °C

    Returns the 14-day failure **probability** and a **risk_level**
    (low / medium / high) based on the configured thresholds.

    Returns **HTTP 503** if the model file could not be loaded at startup.
    """
    if not risk_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Risk model unavailable: {risk_module.load_error}",
        )
    try:
        result = risk_module.predict_risk(
            tqi             = body.tqi,
            gmt             = body.gmt,
            age_since_maint = body.age_since_maint,
            temperature     = body.temperature,
        )
    except Exception as exc:
        log.error("Risk prediction failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Prediction error: {exc}",
        )
    return RiskPredictionResponse(**result)


# ---------------------------------------------------------------------------
# Stage 3b — GCN-LSTM Delay Prediction
# ---------------------------------------------------------------------------

@app.post(
    "/predict/delay",
    response_model=DelayPredictionResponse,
    summary="Predict station delays (GCN-LSTM)",
    tags=["Prediction"],
)
def predict_delay(body: DelayPredictionRequest):
    """
    Runs the pre-trained GCN-LSTM model.

    **Input**: `sequence` — a 12 × 5 list (12 time steps, 5 stations).
    Station order: SC → MJF → AWL → GHKT → BBN (chainage order).
    Each value is the observed delay in minutes at that station/time step.

    **Output**: Predicted delay in minutes for each of the 5 stations.

    Returns **HTTP 503** if the model file could not be loaded at startup.
    """
    if not delay_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Delay model unavailable: {delay_module.load_error}",
        )
    try:
        station_delays = delay_module.predict_delay(body.sequence)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        )
    except Exception as exc:
        log.error("Delay prediction failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Prediction error: {exc}",
        )
    return DelayPredictionResponse(
        predictions    = [StationDelay(**d) for d in station_delays],
        model_available = True,
    )


# ---------------------------------------------------------------------------
# Stage 3a — DB-backed: predict risk for a specific stored record
# ---------------------------------------------------------------------------

@app.post(
    "/predict/risk/{record_id}",
    summary="Run XGBoost risk prediction for a stored DB record",
    tags=["Prediction"],
)
def predict_risk_for_record(record_id: int, db: DbDep):
    """
    Fetches record `record_id` from TimescaleDB, extracts the four XGBoost
    features (`tqi`, `gmt`, `age_since_maint`, `temperature`) from its
    `payload` JSONB, runs the pre-trained model, and persists the result
    in `risk_predictions`.

    Returns **HTTP 422** if required features are missing from the payload.
    Returns **HTTP 404** if the record does not exist.
    Returns **HTTP 503** if the model could not be loaded at startup.
    """
    if not risk_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Risk model unavailable: {risk_module.load_error}",
        )

    outcome = predict_for_record(db, record_id)

    if not outcome.get("ok"):
        reason = outcome.get("reason", "unknown_error")
        if reason == "record_not_found":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail=f"Record {record_id} not found.")
        if reason.startswith("missing_fields") or reason.startswith("invalid_value"):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail={
                                    "error": "insufficient_risk_features",
                                    "record_id": record_id,
                                    "reason": reason,
                                })
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=reason)

    return RiskPredictionByRecordResponse(
        prediction_id   = outcome["prediction_id"],
        record_id       = outcome["record_id"],
        tqi             = outcome["tqi"],
        gmt             = outcome["gmt"],
        age_since_maint = outcome["age_since_maint"],
        temperature     = outcome["temperature"],
        probability     = outcome["probability"],
        risk_level      = outcome["risk_level"],
        predicted_at    = outcome["predicted_at"],
        model_version   = outcome["model_version"],
    )


# ---------------------------------------------------------------------------
# Stage 3a — Retrieve saved risk predictions
# ---------------------------------------------------------------------------

@app.get(
    "/predictions/risk",
    response_model=list[RiskPredictionRecord],
    summary="List saved risk predictions",
    tags=["Prediction"],
)
def get_risk_predictions(
    db: DbDep,
    limit: int = Query(default=100, ge=1, le=500),
    skip:  int = Query(default=0,   ge=0),
):
    """
    Returns saved risk predictions, newest first.
    Supports pagination via `limit` and `skip`.
    """
    rows = (
        db.query(RiskPrediction)
        .order_by(RiskPrediction.predicted_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return rows


@app.get(
    "/predictions/risk/by-record/{record_id}",
    response_model=list[RiskPredictionRecord],
    summary="Get all saved risk predictions for a specific ingestion record",
    tags=["Prediction"],
)
def get_risk_predictions_for_record(record_id: int, db: DbDep):
    """
    Returns every risk prediction that was generated for `record_id`,
    ordered newest first.  A record may have multiple predictions if the
    pipeline was run multiple times.
    """
    rows = (
        db.query(RiskPrediction)
        .filter(RiskPrediction.record_id == record_id)
        .order_by(RiskPrediction.predicted_at.desc())
        .all()
    )
    return rows


# ---------------------------------------------------------------------------
# Stage 3b — DB-backed: predict delay from latest historical observations
# ---------------------------------------------------------------------------

@app.post(
    "/predict/delay/latest",
    summary="Run GCN-LSTM delay prediction from DB history",
    tags=["Prediction"],
)
def predict_delay_from_db(db: DbDep):
    """
    Queries the last 60 minutes of `delay_minutes` observations from
    `raw_ingestion_records`, constructs the 12 × 5 input matrix, runs the
    GCN-LSTM model, and persists results in `delay_predictions`.

    Returns **HTTP 409** with a structured body if there is insufficient
    history to fill the 12-step window.
    Returns **HTTP 503** if the model could not be loaded.
    """
    if not delay_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Delay model unavailable: {delay_module.load_error}",
        )

    result = delay_predict_latest(db)

    if not result.get("ok"):
        if result.get("reason") == "insufficient_history":
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "reason":          result.get("reason"),
                    "detail":          result.get("detail"),
                    "steps_available": result.get("steps_available", 0),
                    "steps_needed":    result.get("steps_needed", 12),
                },
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result.get("reason", "prediction_failed"),
        )

    return DelayPredictionRunResponse(
        run_id             = result["run_id"],
        predicted_at       = result["predicted_at"],
        input_window_start = result["input_window_start"],
        input_window_end   = result["input_window_end"],
        obs_count          = result["obs_count"],
        predictions        = [StationDelay(**p) for p in result["predictions"]],
    )


# ---------------------------------------------------------------------------
# Stage 3b — Retrieve saved delay predictions
# ---------------------------------------------------------------------------

@app.get(
    "/predictions/delay/latest",
    summary="Get the most-recent saved delay prediction run",
    tags=["Prediction"],
)
def get_delay_latest(db: DbDep):
    """
    Returns the most recent delay prediction run (all 5 station rows
    grouped by run_id).
    Returns HTTP 404 if no runs have been saved yet.
    """
    latest_row = (
        db.query(DelayPrediction)
        .order_by(DelayPrediction.predicted_at.desc())
        .first()
    )
    if latest_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No delay predictions saved yet.",
        )

    run_rows = (
        db.query(DelayPrediction)
        .filter(DelayPrediction.run_id == latest_row.run_id)
        .all()
    )

    return DelayPredictionRunResponse(
        run_id             = latest_row.run_id,
        predicted_at       = latest_row.predicted_at,
        input_window_start = latest_row.input_window_start,
        input_window_end   = latest_row.input_window_end,
        obs_count          = latest_row.obs_count,
        predictions        = [
            StationDelay(
                station                  = r.station_code,
                predicted_delay_minutes  = r.predicted_delay_minutes,
            )
            for r in run_rows
        ],
    )


@app.get(
    "/predictions/delay",
    summary="List saved delay prediction runs (one entry per run)",
    tags=["Prediction"],
)
def get_delay_predictions(
    db: DbDep,
    limit: int = Query(default=20, ge=1, le=200),
):
    """
    Returns a list of the most-recent delay prediction runs.
    Each entry represents one inference call (5 station predictions).
    """
    # Get distinct run_ids ordered by predicted_at DESC
    subq = (
        db.query(
            DelayPrediction.run_id,
            func.max(DelayPrediction.predicted_at).label("latest_at"),
        )
        .group_by(DelayPrediction.run_id)
        .order_by(func.max(DelayPrediction.predicted_at).desc())
        .limit(limit)
        .subquery()
    )

    run_ids_rows = db.query(subq.c.run_id).all()
    run_ids = [r[0] for r in run_ids_rows]

    runs = []
    for rid in run_ids:
        rows = db.query(DelayPrediction).filter(DelayPrediction.run_id == rid).all()
        if not rows:
            continue
        runs.append(DelayPredictionRunResponse(
            run_id             = rid,
            predicted_at       = rows[0].predicted_at,
            input_window_start = rows[0].input_window_start,
            input_window_end   = rows[0].input_window_end,
            obs_count          = rows[0].obs_count,
            predictions        = [
                StationDelay(
                    station                 = r.station_code,
                    predicted_delay_minutes = r.predicted_delay_minutes,
                )
                for r in rows
            ],
        ))
    return runs


# ---------------------------------------------------------------------------
# Stage 4 — Timetable Analysis
# ---------------------------------------------------------------------------

@app.post(
    "/timetable/trains",
    response_model=TrainRunResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Store a train run schedule entry",
    tags=["Timetable"],
)
def create_train_run(body: TrainRunRequest, db: DbDep):
    """
    Stores a train run (route + scheduled time + day-of-week pattern) for
    use in Stage 4 timetable clustering.
    """
    run = TrainRun(
        route=body.route,
        scheduled_time=body.scheduled_time,
        day_of_week=body.day_of_week,
        is_daily=body.is_daily,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    log.info("TrainRun id=%s route=%r stored", run.id, run.route)
    return run


@app.get(
    "/timetable/trains",
    response_model=list[TrainRunResponse],
    summary="List all stored train runs",
    tags=["Timetable"],
)
def list_train_runs(db: DbDep):
    """Returns all train runs ordered by day_of_week then scheduled_time."""
    return (
        db.query(TrainRun)
        .order_by(TrainRun.day_of_week, TrainRun.scheduled_time)
        .all()
    )


@app.post(
    "/timetable/analyze",
    response_model=TimetableAnalyzeResponse,
    summary="Cluster train runs and compute maintenance windows (Stage 4)",
    tags=["Timetable"],
)
def analyze_timetable(body: TimetableAnalyzeRequest, db: DbDep):
    """
    Runs HAC clustering on stored train runs using the cosine-cube similarity
    function, collapses clusters into virtual daily slots, and identifies
    free maintenance windows from the resulting gaps.

    Returns **HTTP 409** if no train runs are stored yet.
    """
    result = timetable_service.analyze_timetable(
        db,
        tau_minutes=body.tau_minutes,
        min_window_minutes=body.min_window_minutes,
    )
    if not result["ok"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No train runs found. Add train runs before analyzing.",
        )
    return TimetableAnalyzeResponse(
        clusters_found=result["clusters_found"],
        virtual_slots=result["virtual_slots"],
        windows_saved=result["windows_saved"],
        windows=[MaintenanceWindowResponse(**w) for w in result["windows"]],
    )


@app.get(
    "/timetable/windows",
    response_model=list[MaintenanceWindowResponse],
    summary="List all computed maintenance windows",
    tags=["Timetable"],
)
def list_maintenance_windows(db: DbDep):
    """Returns all maintenance windows ordered by window_start ascending."""
    return (
        db.query(MaintenanceWindow)
        .order_by(MaintenanceWindow.window_start)
        .all()
    )


# ---------------------------------------------------------------------------
# Stage 5 — Maintenance Task Management
# ---------------------------------------------------------------------------

@app.post(
    "/tasks",
    response_model=MaintenanceTaskResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a maintenance task",
    tags=["Tasks"],
)
def create_task(body: MaintenanceTaskRequest, db: DbDep):
    """
    Persists a maintenance task with status 'pending'.
    Pydantic validates department (Civil|Signalling|Electrical) and duration > 0.
    """
    task = MaintenanceTask(
        chainage_km=body.chainage_km,
        department=body.department,
        estimated_duration_minutes=body.estimated_duration_minutes,
        priority_weight=body.priority_weight,
        status="pending",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    log.info("MaintenanceTask id=%s dept=%s created", task.id, task.department)
    return task


@app.get(
    "/tasks",
    response_model=list[MaintenanceTaskResponse],
    summary="List maintenance tasks",
    tags=["Tasks"],
)
def list_tasks(
    db: DbDep,
    status_filter: Optional[str] = Query(default=None, alias="status"),
):
    """Returns all maintenance tasks, newest first. Filter by status with ?status=pending etc."""
    q = db.query(MaintenanceTask).order_by(MaintenanceTask.created_at.desc())
    if status_filter:
        q = q.filter(MaintenanceTask.status == status_filter)
    return q.all()


@app.post(
    "/tasks/auto-generate",
    response_model=list[MaintenanceTaskResponse],
    summary="Auto-generate maintenance tasks from high-risk telemetry predictions",
    tags=["Tasks"],
)
def auto_generate_tasks_endpoint(
    db: DbDep,
    min_probability: float = Query(default=0.65, ge=0.0, le=1.0),
):
    """
    Scans risk_predictions for high/critical probability sections that do not yet
    have a pending or active MaintenanceTask, and auto-queues MaintenanceTask rows.
    """
    tasks = auto_generate_tasks_from_risk(db, min_prob=min_probability)
    return tasks


# ---------------------------------------------------------------------------
# Stage 5 — CP-SAT Scheduling
# ---------------------------------------------------------------------------

@app.post(
    "/schedule/optimize",
    response_model=ScheduleOptimizeResponse,
    summary="Optimise maintenance schedule with CP-SAT (Stage 5)",
    tags=["Scheduling"],
)
def optimize_schedule(body: ScheduleOptimizeRequest, db: DbDep):
    """
    Runs OR-Tools CP-SAT to assign pending maintenance tasks to available
    maintenance windows. If no pending tasks exist, automatically queues from high-risk telemetry.
    Returns HTTP 409 if no feasible schedule exists.
    """
    # Auto-feed: if no pending tasks exist, automatically queue from high-risk predictions
    pending_count = db.query(MaintenanceTask).filter(MaintenanceTask.status == "pending").count()
    if pending_count == 0:
        auto_generate_tasks_from_risk(db)

    result = scheduler_module.optimize_schedule(
        db,
        safety_headway_minutes=body.safety_headway_minutes,
        max_crew_shift_hours=body.max_crew_shift_hours,
    )
    if not result["ok"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=result.get("reason", "no_feasible_schedule"),
        )
    return ScheduleOptimizeResponse(
        tasks_scheduled=result["tasks_scheduled"],
        tasks_unscheduled=result["tasks_unscheduled"],
        blocks_created=result["blocks_created"],
        blocks=[ScheduledBlockResponse(**b) for b in result["blocks"]],
    )


@app.get(
    "/schedule/blocks",
    response_model=list[ScheduledBlockResponse],
    summary="List all scheduled blocks",
    tags=["Scheduling"],
)
def list_scheduled_blocks(db: DbDep):
    """Returns all scheduled blocks ordered by start_time ascending."""
    return (
        db.query(ScheduledBlock)
        .order_by(ScheduledBlock.start_time)
        .all()
    )


# ---------------------------------------------------------------------------
# Stage 6 — VNS Joint-Block Bundling
# ---------------------------------------------------------------------------

@app.post(
    "/schedule/bundle",
    response_model=BundleResponse,
    summary="Bundle proximate scheduled blocks using VNS (Stage 6)",
    tags=["Scheduling"],
)
def bundle_blocks(body: BundleRequest, db: DbDep):
    """
    Applies Variable Neighbourhood Search to merge nearby scheduled blocks
    into joint blocks. Only 'scheduled' status blocks are considered;
    'executed' blocks are never touched.
    """
    result = bundler_module.bundle_blocks(
        db,
        proximity_threshold_m=body.proximity_threshold_m,
        safety_headway_minutes=body.safety_headway_minutes,
    )
    return BundleResponse(
        bundles_created=result["bundles_created"],
        blocks_bundled=result["blocks_bundled"],
        blocks_unchanged=result["blocks_unchanged"],
        bundle_groups=result["bundle_groups"],
    )


# ---------------------------------------------------------------------------
# Stage 7 — Field Controller Review
# ---------------------------------------------------------------------------

# Corridor station chainages for nearest-station lookup
_CORRIDOR_STATIONS: dict[str, float] = {
    "SC": 0.00,
    "MJF": 3.40,
    "AWL": 9.80,
    "GHKT": 16.35,
    "BBN": 19.90,
}


def _nearest_station(chainage_km: float) -> str:
    """Return the station code nearest to the given chainage."""
    return min(_CORRIDOR_STATIONS, key=lambda s: abs(_CORRIDOR_STATIONS[s] - chainage_km))


@app.get(
    "/schedule/pending",
    response_model=list[EnrichedBlockResponse],
    summary="List pending/bundled blocks enriched with risk and delay context",
    tags=["Scheduling"],
)
def get_pending_blocks(db: DbDep):
    """
    Returns all scheduled or bundled blocks enriched with:
    - Full maintenance task details
    - Count of high-risk predictions within 500 m chainage
    - Latest predicted delay for the nearest corridor station
    """
    blocks = (
        db.query(ScheduledBlock)
        .filter(ScheduledBlock.status.in_(["scheduled", "bundled"]))
        .order_by(ScheduledBlock.start_time)
        .all()
    )

    enriched: list[EnrichedBlockResponse] = []
    for block in blocks:
        task = db.query(MaintenanceTask).filter(MaintenanceTask.id == block.task_id).first()
        if task is None:
            continue

        # Count high-risk predictions within 500 m
        high_risk_nearby = 0
        high_risk_record_ids = [
            r[0] for r in
            db.query(RiskPrediction.record_id).filter(RiskPrediction.risk_level == "high").all()
        ]
        if high_risk_record_ids:
            nearby = (
                db.query(RawIngestionRecord.chainage_km)
                .filter(
                    RawIngestionRecord.id.in_(high_risk_record_ids),
                    RawIngestionRecord.chainage_km.isnot(None),
                )
                .all()
            )
            for (ch,) in nearby:
                if abs(ch - block.chainage_km) <= 0.5:
                    high_risk_nearby += 1

        # Latest delay for nearest station
        nearest_station = _nearest_station(block.chainage_km)
        latest_delay_row = (
            db.query(DelayPrediction.predicted_delay_minutes)
            .filter(DelayPrediction.station_code == nearest_station)
            .order_by(DelayPrediction.predicted_at.desc())
            .first()
        )
        latest_delay_minutes: float | None = latest_delay_row[0] if latest_delay_row else None

        enriched.append(EnrichedBlockResponse(
            id=block.id,
            task_id=block.task_id,
            chainage_km=block.chainage_km,
            start_time=block.start_time,
            end_time=block.end_time,
            status=block.status,
            parent_block_id=block.parent_block_id,
            rejection_reason=block.rejection_reason,
            created_at=block.created_at,
            task=MaintenanceTaskResponse.model_validate(task),
            high_risk_nearby=high_risk_nearby,
            latest_delay_minutes=latest_delay_minutes,
        ))

    return enriched


@app.post(
    "/schedule/{block_id}/decision",
    response_model=ScheduledBlockResponse,
    summary="Accept or reject a scheduled block (Field Controller decision)",
    tags=["Scheduling"],
)
def block_decision(block_id: int, body: BlockDecisionRequest, db: DbDep):
    """
    **Accept**: sets block status to 'executed', calls BDMS stub, sends notification.

    **Reject**: stores rejection reason, resets block to 'pending', re-inserts
    the associated task into raw_ingestion_records (Stage 1 feed) so it will
    be re-scheduled on the next pipeline run, and sends a notification.
    """
    block = db.query(ScheduledBlock).filter(ScheduledBlock.id == block_id).first()
    if block is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Block {block_id} not found.",
        )

    # Pydantic ensures decision is 'accept' or 'reject'; extra guard for clarity.
    if body.decision not in ("accept", "reject"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be 'accept' or 'reject'.",
        )

    if body.decision == "reject":
        if not body.reason or not body.reason.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Rejection reason is required.",
            )

    task = db.query(MaintenanceTask).filter(MaintenanceTask.id == block.task_id).first()

    if body.decision == "accept":
        block.status = "executed"
        # STUB: Replace with actual BDMS permit API call in production.
        execute_schedule(block_id)  # BDMS permit stub
        db.commit()
        db.refresh(block)
        send_notification("block_accepted", {
            "block_id": block_id,
            "task_id": block.task_id,
            "chainage_km": block.chainage_km,
            "department": task.department if task else "unknown",
        }, db=db)
        log.info("Block %s accepted (executed)", block_id)
    else:  # reject
        block.rejection_reason = body.reason
        block.status = "pending"

        # Re-insert into Stage 1 feed for re-processing
        nearest_station = _nearest_station(block.chainage_km)
        reingest = RawIngestionRecord(
            source_system="COA",
            station_code=nearest_station,
            chainage_processed=False,
            payload={
                "task_id": block.task_id,
                "chainage_km": block.chainage_km,
                "department": task.department if task else "unknown",
                "rejection_reason": body.reason,
            },
        )
        db.add(reingest)
        db.commit()
        db.refresh(block)
        send_notification("block_rejected", {
            "block_id": block_id,
            "task_id": block.task_id,
            "chainage_km": block.chainage_km,
            "department": task.department if task else "unknown",
            "reason": body.reason,
        }, db=db)
        log.info("Block %s rejected; re-ingested at station %s", block_id, nearest_station)

    return block


# ---------------------------------------------------------------------------
# Stage 9 — Disruption Monitoring and Rolling-Horizon Re-optimisation
# ---------------------------------------------------------------------------

@app.post(
    "/monitor/disruption",
    response_model=DisruptionResponse,
    summary="Report a disruption event; triggers re-optimisation if above threshold",
    tags=["Monitor"],
)
def report_disruption(body: DisruptionRequest, db: DbDep):
    """
    Persists the disruption event.  If delay_minutes exceeds the configured
    REOPT_THRESHOLD_MINUTES (default 15), re-runs CP-SAT restricted to
    'scheduled'/'bundled' blocks only — 'executed' blocks are never touched.
    """
    # Read threshold at call time so it can be changed without restart.
    threshold = float(os.environ.get("REOPT_THRESHOLD_MINUTES", "15"))

    event = DisruptionEvent(
        delay_minutes=body.delay_minutes,
        affected_chainage_km=body.affected_chainage_km,
        triggered_reoptimization=False,
    )
    db.add(event)
    db.flush()  # get event.id before conditional branch

    if body.delay_minutes > threshold:
        # Rolling-horizon: only reschedule tasks linked to non-executed blocks
        candidate_task_ids = [
            r[0] for r in
            db.query(ScheduledBlock.task_id)
            .filter(ScheduledBlock.status.in_(["scheduled", "bundled"]))
            .all()
        ]
        # Reset those tasks to 'pending' so the scheduler picks them up
        if candidate_task_ids:
            db.query(MaintenanceTask)\
                .filter(MaintenanceTask.id.in_(candidate_task_ids))\
                .update({"status": "pending"}, synchronize_session=False)

        reopt_result = scheduler_module.optimize_schedule(
            db,
            task_ids_scope=candidate_task_ids if candidate_task_ids else None,
        )

        event.triggered_reoptimization = True
        db.commit()
        db.refresh(event)

        send_notification("disruption_detected", {
            "event_id": event.id,
            "delay_minutes": body.delay_minutes,
            "affected_chainage_km": body.affected_chainage_km,
            "department": "all",
            "tasks_rescheduled": reopt_result.get("tasks_scheduled", 0),
        }, db=db)
        log.info(
            "Disruption id=%s: %.1f min delay → re-optimisation triggered",
            event.id, body.delay_minutes,
        )

        reopt_response = None
        if reopt_result["ok"]:
            reopt_response = ScheduleOptimizeResponse(
                tasks_scheduled=reopt_result["tasks_scheduled"],
                tasks_unscheduled=reopt_result["tasks_unscheduled"],
                blocks_created=reopt_result["blocks_created"],
                blocks=[ScheduledBlockResponse(**b) for b in reopt_result["blocks"]],
            )

        return DisruptionResponse(
            id=event.id,
            delay_minutes=event.delay_minutes,
            affected_chainage_km=event.affected_chainage_km,
            received_at=event.received_at,
            triggered_reoptimization=True,
            reoptimized=True,
            reoptimization_result=reopt_response,
        )
    else:
        db.commit()
        db.refresh(event)
        log.info(
            "Disruption id=%s: %.1f min delay — below threshold (%.0f min), no re-opt",
            event.id, body.delay_minutes, threshold,
        )
        return DisruptionResponse(
            id=event.id,
            delay_minutes=event.delay_minutes,
            affected_chainage_km=event.affected_chainage_km,
            received_at=event.received_at,
            triggered_reoptimization=False,
            reoptimized=False,
            reason="below_threshold",
        )


@app.get(
    "/monitor/disruptions",
    response_model=list[DisruptionEventResponse],
    summary="List all disruption events",
    tags=["Monitor"],
)
def list_disruptions(db: DbDep):
    """Returns all disruption events ordered by received_at descending."""
    return (
        db.query(DisruptionEvent)
        .order_by(DisruptionEvent.received_at.desc())
        .all()
    )


# ---------------------------------------------------------------------------
# Pipeline orchestration
# ---------------------------------------------------------------------------

@app.post(
    "/pipeline/run",
    summary="Run the full pipeline: Stage 2 → 3a → 3b",
    tags=["Pipeline"],
)
def run_pipeline(db: DbDep):
    """
    Orchestrates the complete downstream pipeline in one call:

    1. **Stage 2** — Resolve chainage for all unprocessed records.
    2. **Stage 3a** — Run XGBoost risk prediction for every chainage-processed
       record that contains all four required payload features.
    3. **Stage 3b** — Build the 12 × 5 delay window from the last 60 minutes
       of observations and run the GCN-LSTM delay model.

    All stages are idempotent except Stage 3a/3b which always add new
    prediction rows.
    """
    result = run_full_pipeline(db)

    return PipelineRunResponse(
        chainage = PipelineChainageResult(**result["chainage"]),
        risk     = PipelineRiskResult(**result["risk"]),
        delay    = result["delay"],
    )


@app.get(
    "/pipeline/status",
    response_model=PipelineStatusResponse,
    summary="Live pipeline statistics",
    tags=["Pipeline"],
)
def get_pipeline_status(db: DbDep):
    """
    Returns live counts from all pipeline tables so the frontend dashboard
    can show an up-to-date overview without querying individual endpoints.
    Includes Stage 4–9 counts: train_runs, maintenance_windows, pending_tasks,
    scheduled_blocks, executed_blocks, disruption_events.
    """
    total       = db.query(func.count(RawIngestionRecord.id)).scalar() or 0
    processed   = db.query(func.count(RawIngestionRecord.id)).filter(
        RawIngestionRecord.chainage_processed == True           # noqa: E712
    ).scalar() or 0
    ch_failed   = db.query(func.count(RawIngestionRecord.id)).filter(
        RawIngestionRecord.chainage_error.isnot(None)
    ).scalar() or 0
    risk_total  = db.query(func.count(RiskPrediction.id)).scalar() or 0
    delay_runs  = db.query(func.count(func.distinct(DelayPrediction.run_id))).scalar() or 0
    high_risk   = db.query(func.count(RiskPrediction.id)).filter(
        RiskPrediction.risk_level == "high"
    ).scalar() or 0
    medium_risk = db.query(func.count(RiskPrediction.id)).filter(
        RiskPrediction.risk_level == "medium"
    ).scalar() or 0
    low_risk    = db.query(func.count(RiskPrediction.id)).filter(
        RiskPrediction.risk_level == "low"
    ).scalar() or 0

    # Stage 4–9 counts
    train_runs_count     = db.query(func.count(TrainRun.id)).scalar() or 0
    maint_windows_count  = db.query(func.count(MaintenanceWindow.id)).scalar() or 0
    pending_tasks_count  = db.query(func.count(MaintenanceTask.id)).filter(
        MaintenanceTask.status == "pending"
    ).scalar() or 0
    scheduled_blocks_count = db.query(func.count(ScheduledBlock.id)).filter(
        ScheduledBlock.status.in_(["scheduled", "bundled"])
    ).scalar() or 0
    executed_blocks_count  = db.query(func.count(ScheduledBlock.id)).filter(
        ScheduledBlock.status == "executed"
    ).scalar() or 0
    disruption_count       = db.query(func.count(DisruptionEvent.id)).scalar() or 0

    return PipelineStatusResponse(
        total_records       = total,
        chainage_processed  = processed,
        chainage_failed     = ch_failed,
        risk_predictions    = risk_total,
        delay_runs          = delay_runs,
        high_risk           = high_risk,
        medium_risk         = medium_risk,
        low_risk            = low_risk,
        train_runs          = train_runs_count,
        maintenance_windows = maint_windows_count,
        pending_tasks       = pending_tasks_count,
        scheduled_blocks    = scheduled_blocks_count,
        executed_blocks     = executed_blocks_count,
        disruption_events   = disruption_count,
    )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get(
    "/health",
    response_model=HealthResponse,
    summary="Health check",
    tags=["Ops"],
)
def health(db: DbDep):
    """
    Checks application and database connectivity.
    Returns HTTP 200 when both are healthy, 503 otherwise.
    """
    try:
        db.execute(text("SELECT 1"))
        db_status = "ok"
    except OperationalError as exc:
        log.error("Database health check failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database unavailable: {exc}",
        )
    return HealthResponse(status="ok", database=db_status)


# ---------------------------------------------------------------------------
# Delete / Reset endpoints
# ---------------------------------------------------------------------------

@app.delete(
    "/ingest/records/{record_id}",
    summary="Delete a single ingestion record and its associated predictions",
    tags=["Ingestion"],
)
def delete_record(record_id: int, db: DbDep):
    """
    Permanently deletes the ingestion record with the given ID, along with
    any risk predictions linked to it.  Delay predictions are NOT deleted
    because they are grouped by run_id (not by record_id).

    Returns HTTP 404 if the record does not exist.
    """
    record = db.query(RawIngestionRecord).filter(RawIngestionRecord.id == record_id).first()
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Record {record_id} not found.",
        )

    # Delete associated risk predictions first
    db.query(RiskPrediction).filter(RiskPrediction.record_id == record_id).delete()
    db.delete(record)
    db.commit()

    log.info("Deleted record id=%s and its risk predictions", record_id)
    return {"deleted": True, "record_id": record_id}


@app.delete(
    "/schedule/reset",
    summary="Delete all scheduled blocks, tasks, disruptions, and notifications",
    tags=["Scheduling"],
)
def reset_schedule_data(db: DbDep):
    """
    **Destructive** — permanently deletes every row from:
    - scheduled_blocks
    - maintenance_tasks
    - disruption_events
    - notifications

    Intended for schedule clearing and re-optimization.
    """
    block_count = db.query(ScheduledBlock).count()
    task_count  = db.query(MaintenanceTask).count()
    disr_count  = db.query(DisruptionEvent).count()
    notif_count = db.query(Notification).count()

    # Clear self-referencing parent foreign keys before deleting
    db.query(ScheduledBlock).update({ScheduledBlock.parent_block_id: None})
    db.commit()
    db.query(ScheduledBlock).delete()
    db.commit()
    db.query(MaintenanceTask).delete()
    db.commit()
    db.query(DisruptionEvent).delete()
    db.commit()
    db.query(Notification).delete()
    db.commit()

    log.warning(
        "RESET_SCHEDULE: deleted %s scheduled blocks, %s maintenance tasks, %s disruptions, %s notifications",
        block_count, task_count, disr_count, notif_count,
    )
    return {
        "deleted": {
            "scheduled_blocks":  block_count,
            "maintenance_tasks": task_count,
            "disruption_events": disr_count,
            "notifications":     notif_count,
        }
    }


@app.delete(
    "/admin/reset",
    summary="Delete ALL data from every pipeline table",
    tags=["Admin"],
)
def reset_all_data(db: DbDep):
    """
    **Destructive** — permanently deletes every row from:
    - scheduled_blocks
    - maintenance_tasks
    - disruption_events
    - notifications
    - delay_predictions
    - risk_predictions
    - raw_ingestion_records

    Intended for development / demo resets only.
    Returns the row counts that were deleted.
    """
    delay_count  = db.query(DelayPrediction).count()
    risk_count   = db.query(RiskPrediction).count()
    record_count = db.query(RawIngestionRecord).count()
    block_count  = db.query(ScheduledBlock).count()
    task_count   = db.query(MaintenanceTask).count()
    disr_count   = db.query(DisruptionEvent).count()
    notif_count  = db.query(Notification).count()

    # Clear scheduling & dependent tables first
    db.query(ScheduledBlock).update({ScheduledBlock.parent_block_id: None})
    db.commit()
    db.query(ScheduledBlock).delete()
    db.commit()
    db.query(MaintenanceTask).delete()
    db.commit()
    db.query(DisruptionEvent).delete()
    db.commit()
    db.query(Notification).delete()
    db.commit()

    # Clear predictions and telemetry records
    db.query(DelayPrediction).delete()
    db.query(RiskPrediction).delete()
    db.query(RawIngestionRecord).delete()
    db.commit()

    log.warning(
        "RESET: deleted %s records, %s risk, %s delay, %s blocks, %s tasks, %s disruptions, %s notifications",
        record_count, risk_count, delay_count, block_count, task_count, disr_count, notif_count,
    )
    return {
        "deleted": {
            "raw_ingestion_records": record_count,
            "risk_predictions":      risk_count,
            "delay_predictions":     delay_count,
            "scheduled_blocks":      block_count,
            "maintenance_tasks":     task_count,
            "disruption_events":     disr_count,
            "notifications":         notif_count,
        }
    }


# ---------------------------------------------------------------------------
# CSV bulk upload
# ---------------------------------------------------------------------------

# Columns that are treated as record metadata, NOT payload fields.
# Everything else (tqi, gmt, age_since_maint, temperature, delay_minutes,
# any custom column) lands in the JSONB payload dict.
_CSV_META_COLS: frozenset[str] = frozenset({
    "observation_time",
    "source_system",
    "station_code",
    "mast_id",
    "latitude",
    "longitude",
})

_VALID_SOURCES:   frozenset[str] = frozenset({"TMS", "SMMS", "TDMS", "COA"})
_DELAY_STATIONS:  frozenset[str] = frozenset({"SC", "MJF", "AWL", "GHKT", "BBN"})

# ML fields that must parse as a finite float if non-empty (never silently zeroed)
_ML_NUMERIC_FIELDS: frozenset[str] = frozenset({
    "tqi", "gmt", "age_since_maint", "temperature", "delay_minutes"
})

import math as _math   # noqa: E402  (local to avoid polluting top-level)


def _parse_observation_time(raw: str, row_num: int) -> tuple[datetime | None, str | None]:
    """
    Parse an ISO-8601 observation_time string.

    Returns (datetime_with_tz, None) on success.
    Returns (None, error_reason) on failure.
    The returned datetime is always UTC-aware.
    """
    from datetime import timezone as _tz
    s = raw.strip()
    if not s:
        return None, "observation_time is empty."
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None, (
            f"Invalid observation_time={s!r}. "
            "Expected ISO-8601 format, e.g. 2026-09-21T09:00:00 or 2026-09-21T09:00:00+05:30"
        )
    # Make timezone-aware (assume UTC if naive)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt, None


def _parse_ml_float(col: str, raw: str, row_num: int) -> tuple[float | None, str | None]:
    """
    Parse a known ML field value into a finite float.
    Returns (float, None) on success; (None, reason) on failure.
    """
    s = raw.strip()
    if not s:
        return None, None   # empty → omit from payload, not an error
    try:
        v = float(s)
    except ValueError:
        return None, f"Field {col!r}: non-numeric value {s!r} — must be a number."
    if not _math.isfinite(v):
        return None, f"Field {col!r}: non-finite value {v} (nan/inf not allowed)."
    return v, None


@app.post(
    "/ingest/csv",
    summary="Bulk-ingest records from an uploaded CSV file",
    tags=["Ingestion"],
)
async def ingest_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """
    Accepts a UTF-8 CSV file and inserts every valid row as a new ingestion
    record with automatic inline chainage resolution (Stage 2).

    **Required columns**:
    - ``observation_time``  — ISO-8601 timestamp of when the measurement occurred
    - ``source_system``     — TMS | SMMS | TDMS | COA

    **Location columns** (at least one required per row):
    - ``station_code``
    - ``mast_id``
    - ``latitude`` **and** ``longitude`` (both required together)

    **ML payload columns** (all go into the JSON payload dict):
    - ``tqi``, ``gmt``, ``age_since_maint``, ``temperature`` — XGBoost risk features
    - ``delay_minutes``   — GCN-LSTM delay feature

    **Delay records** (rows with ``delay_minutes``):
    - ``station_code`` is required AND must be one of: SC, MJF, AWL, GHKT, BBN

    **ML numeric fields** (``tqi``, ``gmt``, ``age_since_maint``, ``temperature``,
    ``delay_minutes``) must be finite numbers if non-empty. Rows with NaN or Inf
    are rejected.

    Every other non-empty column is added to the payload dict as a string.

    Returns ``{inserted, failed, total_rows, filename, errors[{row, reason}]}``.
    """
    # ── Read & decode ─────────────────────────────────────────────────────────
    raw_bytes = await file.read()
    try:
        text_content = raw_bytes.decode("utf-8-sig")   # strips BOM
    except UnicodeDecodeError:
        text_content = raw_bytes.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_content))

    if reader.fieldnames is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="CSV file is empty or missing a header row.",
        )

    fieldnames_lower = [f.strip().lower() for f in reader.fieldnames]
    if "observation_time" not in fieldnames_lower:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "CSV is missing the required 'observation_time' column. "
                "Please download the template and add observation timestamps."
            ),
        )

    # ── Process rows ──────────────────────────────────────────────────────────
    inserted = 0
    failed   = 0
    errors: list[dict] = []
    row_errors: list[str] = []

    for row_num, row in enumerate(reader, start=2):   # row 1 = header

        row_errors.clear()

        # ── observation_time (required) ───────────────────────────────────────
        obs_raw = (row.get("observation_time") or "").strip()
        obs_time, obs_err = _parse_observation_time(obs_raw, row_num)
        if obs_err:
            failed += 1
            errors.append({"row": row_num, "reason": obs_err})
            continue

        # ── source_system ─────────────────────────────────────────────────────
        source_raw = (row.get("source_system") or "").strip().upper()
        if source_raw not in _VALID_SOURCES:
            failed += 1
            errors.append({
                "row": row_num,
                "reason": f"Invalid source_system={source_raw!r}. "
                          f"Must be one of {sorted(_VALID_SOURCES)}.",
            })
            continue

        # ── Location fields ───────────────────────────────────────────────────
        station_code = (row.get("station_code") or "").strip().upper() or None
        mast_id      = (row.get("mast_id")      or "").strip().upper() or None
        lat_str      = (row.get("latitude")  or "").strip()
        lon_str      = (row.get("longitude") or "").strip()

        try:
            latitude  = float(lat_str) if lat_str else None
            longitude = float(lon_str) if lon_str else None
        except ValueError:
            failed += 1
            errors.append({"row": row_num, "reason": "Non-numeric latitude or longitude."})
            continue

        if (latitude is None) != (longitude is None):
            failed += 1
            errors.append({
                "row": row_num,
                "reason": "latitude and longitude must both be present together.",
            })
            continue

        if latitude is not None and (not _math.isfinite(latitude) or not _math.isfinite(longitude)):
            failed += 1
            errors.append({"row": row_num, "reason": "Non-finite latitude or longitude."})
            continue

        if not (station_code or mast_id or latitude is not None):
            failed += 1
            errors.append({
                "row": row_num,
                "reason": "Missing location — provide station_code, mast_id, or latitude+longitude.",
            })
            continue

        # ── Build payload & validate ML numeric fields ────────────────────────
        payload: dict = {}
        row_invalid = False

        for col, val in row.items():
            if col in _CSV_META_COLS:
                continue
            if val is None or val.strip() == "":
                continue
            val_s = val.strip()

            if col in _ML_NUMERIC_FIELDS:
                # ML fields: must be finite float if non-empty
                float_val, ml_err = _parse_ml_float(col, val_s, row_num)
                if ml_err:
                    failed += 1
                    errors.append({"row": row_num, "reason": ml_err})
                    row_invalid = True
                    break
                if float_val is not None:
                    payload[col] = float_val
            else:
                # Generic column: coerce to float if possible, else string
                try:
                    payload[col] = float(val_s)
                except ValueError:
                    payload[col] = val_s

        if row_invalid:
            continue

        # ── Delay-record cross-field validation ───────────────────────────────
        if "delay_minutes" in payload:
            if station_code is None:
                failed += 1
                errors.append({
                    "row": row_num,
                    "reason": (
                        "delay_minutes requires station_code to be present "
                        "(needed for GCN-LSTM station routing)."
                    ),
                })
                continue
            if station_code not in _DELAY_STATIONS:
                failed += 1
                errors.append({
                    "row": row_num,
                    "reason": (
                        f"station_code={station_code!r} is not a supported GCN-LSTM station. "
                        f"Must be one of {sorted(_DELAY_STATIONS)}."
                    ),
                })
                continue

        # ── Insert record ─────────────────────────────────────────────────────
        record = RawIngestionRecord(
            source_system      = source_raw,
            latitude           = latitude,
            longitude          = longitude,
            station_code       = station_code,
            mast_id            = mast_id,
            observation_time   = obs_time,
            payload            = payload,
            chainage_processed = False,
        )
        db.add(record)
        db.flush()   # assigns record.id

        # ── Auto-resolve chainage (Stage 2 inline) ────────────────────────────
        chainage_km, error_reason = chainage_module.resolve_chainage(record)
        if error_reason is None and chainage_km is not None:
            record.chainage_km        = chainage_km
            record.chainage_processed = True
            record.chainage_error     = None
        else:
            record.chainage_error = error_reason

        inserted += 1

    db.commit()

    log.info(
        "CSV upload complete: inserted=%s failed=%s file=%s",
        inserted, failed, file.filename,
    )

    return {
        "inserted":   inserted,
        "failed":     failed,
        "total_rows": inserted + failed,
        "filename":   file.filename,
        "errors":     errors,
    }


# ---------------------------------------------------------------------------
# Authentication endpoints
# ---------------------------------------------------------------------------

@app.post(
    "/auth/login",
    response_model=LoginResponse,
    summary="Authenticate and receive a JWT access token",
    tags=["Auth"],
)
def login(body: LoginRequest, db: DbDep):
    """
    Accepts email + password, returns a JWT access token with role info.
    """
    user = db.query(User).filter(User.email == body.email).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_access_token({"sub": user.email, "role": user.role})
    return LoginResponse(
        access_token=token,
        role=user.role,
        department_name=user.department_name,
        display_name=user.display_name,
    )


@app.get(
    "/auth/me",
    response_model=UserResponse,
    summary="Get current authenticated user profile",
    tags=["Auth"],
)
def get_me(user: User = Depends(get_current_user_required)):
    """Returns the profile of the currently authenticated user."""
    return user


# ---------------------------------------------------------------------------
# SHAP Explainability endpoint
# ---------------------------------------------------------------------------

@app.get(
    "/predict/risk/{prediction_id}/shap",
    response_model=ShapExplanation | None,
    summary="Compute SHAP explanation for a risk prediction",
    tags=["Risk"],
)
def get_risk_shap(prediction_id: int, db: DbDep):
    """
    Fetches the saved risk prediction, re-runs SHAP on its feature vector,
    and returns per-feature SHAP values.
    """
    pred = db.query(RiskPrediction).filter(RiskPrediction.id == prediction_id).first()
    if pred is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Risk prediction {prediction_id} not found.",
        )

    if not risk_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Risk model not available for SHAP computation.",
        )

    result = risk_module.compute_shap_values(
        tqi=pred.tqi,
        gmt=pred.gmt,
        age_since_maint=pred.age_since_maint,
        temperature=pred.temperature,
    )

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SHAP explainer not available.",
        )

    return ShapExplanation(**result)


@app.post(
    "/predict/risk-shap",
    response_model=ShapExplanation | None,
    summary="Compute real-time SHAP explanation for arbitrary telemetry or simulation values",
    tags=["Risk"],
)
def compute_risk_shap_for_values(body: RiskPredictionRequest):
    """
    Computes real-time SHAP attribution for any telemetry values or simulation scenario.
    """
    if not risk_module.model_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Risk model not available for SHAP computation.",
        )
    result = risk_module.compute_shap_values(
        tqi=body.tqi,
        gmt=body.gmt,
        age_since_maint=body.age_since_maint,
        temperature=body.temperature,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SHAP explainer not available.",
        )
    return ShapExplanation(**result)


# ---------------------------------------------------------------------------
# What-If Sandbox (Schedule Preview / Dry-Run)
# ---------------------------------------------------------------------------

@app.post(
    "/schedule/optimize/preview",
    response_model=SchedulePreviewResponse,
    summary="What-If sandbox: preview the schedule without persisting",
    tags=["Scheduling"],
)
def preview_schedule(body: ScheduleOptimizeRequest, db: DbDep):
    """
    Runs the CP-SAT optimizer in dry-run mode.
    Returns the same result shape as /schedule/optimize but does NOT
    persist any blocks or update task statuses.
    """
    result = scheduler_module.optimize_schedule(
        db,
        safety_headway_minutes=body.safety_headway_minutes,
        max_crew_shift_hours=body.max_crew_shift_hours,
        dry_run=True,
    )

    if not result["ok"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=result.get("reason", "no_feasible_schedule"),
        )

    return SchedulePreviewResponse(
        dry_run=True,
        tasks_scheduled=result["tasks_scheduled"],
        tasks_unscheduled=result["tasks_unscheduled"],
        blocks_created=result["blocks_created"],
        blocks=[PreviewBlockResponse(**b) for b in result["blocks"]],
    )


# ---------------------------------------------------------------------------
# Notifications endpoints
# ---------------------------------------------------------------------------

@app.get(
    "/notifications",
    response_model=list[NotificationResponse],
    summary="List notifications (admin: all; department: own)",
    tags=["Notifications"],
)
def list_notifications(
    db: DbDep,
    user: User = Depends(get_current_user_required),
    unread_only: bool = Query(False, description="Only return unread notifications"),
):
    """
    Returns notifications scoped to the user's role:
    - section_controller: all notifications
    - department: only notifications for their department
    """
    query = db.query(Notification).order_by(Notification.created_at.desc())

    if user.role == "department" and user.department_name:
        query = query.filter(Notification.department_name == user.department_name)

    if unread_only:
        query = query.filter(Notification.read_at.is_(None))

    return query.limit(100).all()


@app.post(
    "/notifications/{notification_id}/read",
    response_model=NotificationResponse,
    summary="Mark a notification as read",
    tags=["Notifications"],
)
def mark_notification_read(
    notification_id: int,
    db: DbDep,
    user: User = Depends(get_current_user_required),
):
    """Marks a single notification as read. Department users can only mark their own."""
    notif = db.query(Notification).filter(Notification.id == notification_id).first()
    if notif is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Notification {notification_id} not found.",
        )

    # Department users can only see/mark their own notifications
    if user.role == "department" and user.department_name != notif.department_name:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only access your own department's notifications.",
        )

    from datetime import datetime, timezone
    notif.read_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(notif)
    return notif


# ---------------------------------------------------------------------------
# Block Sanction Letters
# ---------------------------------------------------------------------------

@app.get(
    "/department/letters/{block_id}",
    response_class=HTMLResponse,
    summary="Download a block sanction letter for an executed block",
    tags=["Letters"],
)
def get_letter(block_id: int, db: DbDep):
    """
    Generates and returns an HTML block-sanction letter for the given block.
    Only available for blocks with status 'executed'.
    """
    block = db.query(ScheduledBlock).filter(ScheduledBlock.id == block_id).first()
    if block is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Block {block_id} not found.",
        )

    task = db.query(MaintenanceTask).filter(MaintenanceTask.id == block.task_id).first()
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task for block {block_id} not found.",
        )

    html = letters_module.generate_letter(
        block_id=block.id,
        task_department=task.department,
        task_chainage_km=task.chainage_km,
        estimated_duration_minutes=task.estimated_duration_minutes,
        block_start=block.start_time,
        block_end=block.end_time,
        block_status=block.status,
    )
    return HTMLResponse(content=html)


@app.get(
    "/department/letters",
    response_model=list[LetterResponse],
    summary="List available letters for a department",
    tags=["Letters"],
)
def list_letters(
    db: DbDep,
    user: User = Depends(get_current_user_required),
):
    """
    Returns metadata for all block sanction letters available to the user.
    Department users see only their own department's executed blocks.
    Admin users see all.
    """
    query = (
        db.query(ScheduledBlock, MaintenanceTask)
        .join(MaintenanceTask, ScheduledBlock.task_id == MaintenanceTask.id)
        .filter(ScheduledBlock.status == "executed")
    )

    if user.role == "department" and user.department_name:
        query = query.filter(MaintenanceTask.department == user.department_name)

    results = query.order_by(ScheduledBlock.created_at.desc()).all()

    letters_list = []
    for block, task in results:
        ref_date = block.created_at or datetime.now(timezone.utc)
        ref = f"RS/{block.id:04d}/{ref_date.strftime('%Y%m%d')}"
        letters_list.append(LetterResponse(
            block_id=block.id,
            department=task.department,
            reference=ref,
            status=block.status,
        ))

    return letters_list


# ---------------------------------------------------------------------------
# Department-scoped upload (enforces department from token)
# ---------------------------------------------------------------------------

@app.get(
    "/department/uploads",
    response_model=list[UnprocessedRecord],
    summary="List ingestion records uploaded by this department",
    tags=["Department"],
)
def list_department_uploads(
    db: DbDep,
    user: User = Depends(require_role("department")),
):
    """
    Returns ingestion records where the payload's department matches
    the logged-in department user's department_name.
    Department users see only their own data — enforced server-side.
    """
    dept = user.department_name
    if not dept:
        return []

    # Match records by source_system convention or payload department
    # For simplicity, we map departments to source systems:
    dept_source_map = {
        "Civil": "TMS",
        "Signalling": "SMMS",
        "Electrical": "TDMS",
    }
    source = dept_source_map.get(dept)

    query = db.query(RawIngestionRecord).order_by(RawIngestionRecord.ingested_at.desc())
    if source:
        query = query.filter(RawIngestionRecord.source_system == source)

    return query.limit(200).all()


# ---------------------------------------------------------------------------
# Enriched blocks with SHAP (for admin scheduling page)
# ---------------------------------------------------------------------------

@app.get(
    "/schedule/pending/enriched",
    response_model=list[EnrichedBlockWithShap],
    summary="Pending blocks enriched with SHAP explanations",
    tags=["Scheduling"],
)
def get_pending_blocks_with_shap(db: DbDep):
    """
    Same as GET /schedule/pending but includes SHAP explanation for the
    nearest risk prediction.  Used by the admin scheduling page.
    """
    blocks = (
        db.query(ScheduledBlock)
        .filter(ScheduledBlock.status.in_(["scheduled", "bundled"]))
        .order_by(ScheduledBlock.start_time)
        .all()
    )

    enriched = []
    for block in blocks:
        task = db.query(MaintenanceTask).filter(MaintenanceTask.id == block.task_id).first()
        if task is None:
            continue

        # Count high-risk predictions within 500 m
        high_risk_nearby = 0
        high_risk_record_ids = [
            r[0] for r in
            db.query(RiskPrediction.record_id).filter(RiskPrediction.risk_level == "high").all()
        ]
        if high_risk_record_ids:
            nearby = (
                db.query(RawIngestionRecord.chainage_km)
                .filter(
                    RawIngestionRecord.id.in_(high_risk_record_ids),
                    RawIngestionRecord.chainage_km.isnot(None),
                )
                .all()
            )
            for (ch,) in nearby:
                if abs(ch - block.chainage_km) <= 0.5:
                    high_risk_nearby += 1

        # Latest delay for nearest station
        nearest_station = _nearest_station(block.chainage_km)
        latest_delay_row = (
            db.query(DelayPrediction.predicted_delay_minutes)
            .filter(DelayPrediction.station_code == nearest_station)
            .order_by(DelayPrediction.predicted_at.desc())
            .first()
        )
        latest_delay_minutes = latest_delay_row[0] if latest_delay_row else None

        # SHAP: find nearest risk prediction by chainage
        nearest_risk_pred = (
            db.query(RiskPrediction)
            .join(RawIngestionRecord, RiskPrediction.record_id == RawIngestionRecord.id)
            .filter(RawIngestionRecord.chainage_km.isnot(None))
            .order_by(func.abs(RawIngestionRecord.chainage_km - block.chainage_km))
            .first()
        )

        shap_explanation = None
        if nearest_risk_pred and risk_module.model_available:
            shap_result = risk_module.compute_shap_values(
                tqi=nearest_risk_pred.tqi,
                gmt=nearest_risk_pred.gmt,
                age_since_maint=nearest_risk_pred.age_since_maint,
                temperature=nearest_risk_pred.temperature,
            )
            if shap_result:
                shap_explanation = ShapExplanation(**shap_result)

        enriched.append(EnrichedBlockWithShap(
            id=block.id,
            task_id=block.task_id,
            chainage_km=block.chainage_km,
            start_time=block.start_time,
            end_time=block.end_time,
            status=block.status,
            parent_block_id=block.parent_block_id,
            rejection_reason=block.rejection_reason,
            created_at=block.created_at,
            task=MaintenanceTaskResponse.model_validate(task),
            high_risk_nearby=high_risk_nearby,
            latest_delay_minutes=latest_delay_minutes,
            shap_explanation=shap_explanation,
        ))

    return enriched
