"""
schemas.py — Pydantic request/response schemas for the ingestion layer.

Validation rule:  every incoming record must carry at least one location
field:
  • latitude AND longitude together (both must be present if either is)
  • OR station_code
  • OR mast_id

Source-specific fields (TQI, GMT index, relay voltage, etc.) are passed
in the `payload` dict rather than being rigid columns.
"""

from __future__ import annotations

from datetime import datetime
from datetime import time as time_type
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------

class IngestRequest(BaseModel):
    """
    Shared ingest request body accepted by all four endpoints.

    At least one of the location triplet must be populated:
      - (latitude + longitude)  — GPS fix
      - station_code            — known railway station
      - mast_id                 — OHE/traction mast identifier
    """

    latitude: float | None = Field(
        default=None,
        description="WGS-84 latitude in decimal degrees.",
        ge=-90.0,
        le=90.0,
    )
    longitude: float | None = Field(
        default=None,
        description="WGS-84 longitude in decimal degrees.",
        ge=-180.0,
        le=180.0,
    )
    station_code: str | None = Field(
        default=None,
        max_length=20,
        description="Indian Railways station code (e.g. HYB, SC, NDLS).",
    )
    mast_id: str | None = Field(
        default=None,
        max_length=50,
        description="OHE traction mast identifier.",
    )
    payload: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Source-specific key-value pairs. "
            "Examples: {\"tqi\": 87.3, \"gmt_index\": 2.1} for TMS; "
            "{\"relay_voltage\": 109.5} for SMMS."
        ),
    )

    # ------------------------------------------------------------------
    # Validators
    # ------------------------------------------------------------------

    @field_validator("station_code", "mast_id", mode="before")
    @classmethod
    def strip_whitespace(cls, v: str | None) -> str | None:
        """Normalise station codes and mast IDs to stripped uppercase."""
        if v is not None:
            v = v.strip().upper()
            if not v:
                return None
        return v

    @model_validator(mode="after")
    def require_at_least_one_location(self) -> "IngestRequest":
        """
        Reject records that carry no location signal at all.

        Also enforces that latitude and longitude are always provided
        together — never one without the other.
        """
        lat, lon = self.latitude, self.longitude

        # lat/lon must come in pairs
        if (lat is None) != (lon is None):
            raise ValueError(
                "latitude and longitude must both be provided together, "
                "or both omitted."
            )

        has_coords = lat is not None and lon is not None
        has_station = self.station_code is not None
        has_mast = self.mast_id is not None

        if not (has_coords or has_station or has_mast):
            raise ValueError(
                "At least one location field is required: "
                "(latitude + longitude), station_code, or mast_id."
            )
        return self


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class IngestResponse(BaseModel):
    """Returned after a successful single-record ingestion."""

    id: int
    source_system: str
    ingested_at: datetime
    observation_time: datetime | None   # when the telemetry occurred (from CSV or API)
    latitude: float | None
    longitude: float | None
    station_code: str | None
    mast_id: str | None
    chainage_km: float | None
    chainage_error: str | None
    chainage_processed: bool
    payload: dict[str, Any]

    model_config = {"from_attributes": True}


class UnprocessedRecord(BaseModel):
    """One record returned by GET /ingest/unprocessed and GET /ingest/records."""

    id: int
    source_system: str
    ingested_at: datetime
    observation_time: datetime | None   # when the telemetry occurred
    latitude: float | None
    longitude: float | None
    station_code: str | None
    mast_id: str | None
    chainage_km: float | None
    chainage_error: str | None
    chainage_processed: bool
    payload: dict[str, Any]

    model_config = {"from_attributes": True}


class HealthResponse(BaseModel):
    status: str
    database: str


# ---------------------------------------------------------------------------
# Stage 2 — Chainage processing response schemas
# ---------------------------------------------------------------------------

class ChainageFailure(BaseModel):
    """One failed record in the POST /chainage/process response."""

    id: int
    reason: str


class ChainageProcessResponse(BaseModel):
    """Summary returned by POST /chainage/process."""

    processed: int
    failed: int
    failures: list[ChainageFailure]


class ChainageLookupResponse(BaseModel):
    """Response from GET /chainage/lookup."""

    chainage_km: float | None
    source: str          # "gps" | "station_code" | "mast_id"
    error: str | None


# ---------------------------------------------------------------------------
# Stage 3a — XGBoost Risk Prediction schemas
# ---------------------------------------------------------------------------

class RiskPredictionRequest(BaseModel):
    """Input features for the XGBoost 14-day failure probability model."""

    tqi: float = Field(
        description="Track Quality Index — higher is better.",
        ge=0.0,
        le=100.0,
    )
    gmt: float = Field(
        description="Geometry Mean Track index.",
        ge=0.0,
        le=100.0,
    )
    age_since_maint: float = Field(
        description="Days elapsed since the last maintenance event.",
        ge=0.0,
    )
    temperature: float = Field(
        description="Ambient temperature in degrees Celsius.",
        ge=-50.0,
        le=80.0,
    )


class RiskPredictionResponse(BaseModel):
    """Output from POST /predict/risk."""

    probability: float = Field(description="14-day failure probability (0–1).")
    risk_level: str    = Field(description='"low" | "medium" | "high".')
    model_available: bool


# ---------------------------------------------------------------------------
# Stage 3b — GCN-LSTM Delay Prediction schemas
# ---------------------------------------------------------------------------

class StationDelay(BaseModel):
    """Predicted delay for one station."""

    station: str
    predicted_delay_minutes: float


class DelayPredictionRequest(BaseModel):
    """
    Input for the GCN-LSTM delay prediction model.

    sequence: exactly 12 time steps, each with one observed delay value
    per station (5 stations in chainage order: SC, MJF, AWL, GHKT, BBN).
    sequence[t] must contain exactly 5 float values.
    """

    sequence: list[list[float]] = Field(
        description=(
            "12 time steps × 5 stations.  "
            "sequence[t][s] = observed delay in minutes for station s at step t."
        )
    )

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, v: list[list[float]]) -> list[list[float]]:
        from delay_model import SEQ_LEN, N_STATIONS
        if len(v) != SEQ_LEN:
            raise ValueError(f"sequence must have exactly {SEQ_LEN} time steps, got {len(v)}")
        for t, step in enumerate(v):
            if len(step) != N_STATIONS:
                raise ValueError(
                    f"Each time step must have {N_STATIONS} values; step {t} has {len(step)}"
                )
        return v


class DelayPredictionResponse(BaseModel):
    """Output from POST /predict/delay."""

    predictions: list[StationDelay]
    model_available: bool


# ---------------------------------------------------------------------------
# Stage 3a — DB-backed risk prediction schemas
# ---------------------------------------------------------------------------

class RiskPredictionRecord(BaseModel):
    """One saved risk prediction row (from the risk_predictions table)."""

    id:               int
    record_id:        int
    tqi:              float
    gmt:              float
    age_since_maint:  float
    temperature:      float
    probability:      float
    risk_level:       str     # low | medium | high
    predicted_at:     datetime
    model_version:    str

    model_config = {"from_attributes": True}


class RiskPredictionByRecordResponse(BaseModel):
    """Returned by POST /predict/risk/{record_id}."""

    prediction_id:    int
    record_id:        int
    tqi:              float
    gmt:              float
    age_since_maint:  float
    temperature:      float
    probability:      float
    risk_level:       str
    predicted_at:     datetime
    model_version:    str


class IneligibleRecordResponse(BaseModel):
    """Returned when a record lacks the required features for risk prediction."""

    record_id: int
    eligible:  bool = False
    reason:    str


# ---------------------------------------------------------------------------
# Stage 3b — DB-backed delay prediction schemas
# ---------------------------------------------------------------------------

class DelayPredictionRunResponse(BaseModel):
    """One complete delay prediction run (all 5 stations)."""

    run_id:               str
    predicted_at:         datetime
    input_window_start:   datetime | None
    input_window_end:     datetime | None
    obs_count:            int | None = None   # qualifying observations used
    predictions:          list[StationDelay]


class InsufficientHistoryResponse(BaseModel):
    """Returned when there is not enough delay history to run the GCN-LSTM."""

    reason:           str   # always "insufficient_history"
    detail:           str
    steps_available:  int
    steps_needed:     int


# ---------------------------------------------------------------------------
# Pipeline schemas
# ---------------------------------------------------------------------------

class PipelineChainageResult(BaseModel):
    processed:  int
    failed:     int
    failures:   list[dict]


class PipelineRiskDetail(BaseModel):
    record_id:      int
    prediction_id:  int | None = None
    probability:    float | None = None
    risk_level:     str | None = None
    error:          str | None = None


class PipelineRiskResult(BaseModel):
    attempted:          int
    succeeded:          int
    skipped_ineligible: int
    failed:             int
    details:            list[dict]


class PipelineDelayResult(BaseModel):
    ok:          bool
    run_id:      str | None = None
    reason:      str | None = None
    detail:      str | None = None
    predictions: list[StationDelay] | None = None


class PipelineRunResponse(BaseModel):
    chainage:   PipelineChainageResult
    risk:       PipelineRiskResult
    delay:      dict   # flexible — ok:True has run_id; ok:False has reason


class PipelineStatusResponse(BaseModel):
    """Live counts from all pipeline tables."""

    total_records:       int
    chainage_processed:  int
    chainage_failed:     int
    risk_predictions:    int
    delay_runs:          int
    high_risk:           int
    medium_risk:         int
    low_risk:            int
    train_runs:          int
    maintenance_windows: int
    pending_tasks:       int
    scheduled_blocks:    int
    executed_blocks:     int
    disruption_events:   int



# ===========================================================================
# Stage 4 — Timetable Analysis
# ===========================================================================

class TrainRunRequest(BaseModel):
    """Request body for POST /timetable/trains."""
    route:          str        = Field(..., max_length=200)
    scheduled_time: time_type
    day_of_week:    int        = Field(..., ge=0, le=6)   # 0=Mon … 6=Sun
    is_daily:       bool       = False


class TrainRunResponse(BaseModel):
    """One train run record."""
    id:             int
    route:          str
    scheduled_time: time_type
    day_of_week:    int
    is_daily:       bool
    created_at:     datetime

    model_config = {"from_attributes": True}


class TimetableAnalyzeRequest(BaseModel):
    """Optional parameters for POST /timetable/analyze."""
    tau_minutes:        int = Field(default=15,  ge=5,  le=60)
    min_window_minutes: int = Field(default=30,  ge=10, le=240)


class MaintenanceWindowResponse(BaseModel):
    """One maintenance window row."""
    id:                   int
    window_start:         datetime
    window_end:           datetime
    chainage_range_start: float
    chainage_range_end:   float
    source_run_id:        int | None
    created_at:           datetime

    model_config = {"from_attributes": True}


class TimetableAnalyzeResponse(BaseModel):
    """Response from POST /timetable/analyze."""
    clusters_found: int
    virtual_slots:  list[str]   # HH:MM strings for each cluster mean time
    windows_saved:  int
    windows:        list[MaintenanceWindowResponse]


# ===========================================================================
# Stage 5 — CP-SAT Scheduling
# ===========================================================================

class MaintenanceTaskRequest(BaseModel):
    """Request body for POST /tasks."""
    chainage_km:                float
    department:                 Literal["Civil", "Signalling", "Electrical"]
    estimated_duration_minutes: int   = Field(..., gt=0)
    priority_weight:            float | None = None


class MaintenanceTaskResponse(BaseModel):
    """One maintenance task record."""
    id:                         int
    chainage_km:                float
    department:                 str
    estimated_duration_minutes: int
    priority_weight:            float | None
    status:                     str
    created_at:                 datetime

    model_config = {"from_attributes": True}


class ScheduleOptimizeRequest(BaseModel):
    """Optional parameters for POST /schedule/optimize."""
    safety_headway_minutes: int = Field(default=10, ge=0, le=60)
    max_crew_shift_hours:   int = Field(default=8,  ge=1, le=12)


class ScheduledBlockResponse(BaseModel):
    """One scheduled block record."""
    id:               int
    task_id:          int
    chainage_km:      float
    start_time:       datetime
    end_time:         datetime
    status:           str
    parent_block_id:  int | None
    rejection_reason: str | None
    created_at:       datetime

    model_config = {"from_attributes": True}


class ScheduleOptimizeResponse(BaseModel):
    """Response from POST /schedule/optimize."""
    tasks_scheduled:   int
    tasks_unscheduled: int
    blocks_created:    int
    blocks:            list[ScheduledBlockResponse]


# ===========================================================================
# Stage 6 — VNS Joint-Block Bundling
# ===========================================================================

class BundleRequest(BaseModel):
    """Optional parameters for POST /schedule/bundle."""
    proximity_threshold_m:  float = Field(default=500.0, ge=100.0, le=2000.0)
    safety_headway_minutes: int   = Field(default=10, ge=0, le=60)


class BundleGroup(BaseModel):
    parent_id:  int
    child_ids:  list[int]


class BundleResponse(BaseModel):
    """Response from POST /schedule/bundle."""
    bundles_created:  int
    blocks_bundled:   int
    blocks_unchanged: int
    bundle_groups:    list[BundleGroup]


# ===========================================================================
# Stage 7 — Field Controller Review
# ===========================================================================

class EnrichedBlockResponse(ScheduledBlockResponse):
    """ScheduledBlock enriched with risk/delay context for the field controller."""
    task:                  MaintenanceTaskResponse
    high_risk_nearby:      int
    latest_delay_minutes:  float | None


class BlockDecisionRequest(BaseModel):
    """Request body for POST /schedule/{block_id}/decision."""
    decision: Literal["accept", "reject"]
    reason:   str | None = None


# ===========================================================================
# Stage 9 — Disruption Monitoring
# ===========================================================================

class DisruptionRequest(BaseModel):
    """Request body for POST /monitor/disruption."""
    delay_minutes:        float = Field(..., ge=0.0)
    affected_chainage_km: float = Field(..., ge=0.0)


class DisruptionEventResponse(BaseModel):
    """One disruption event record."""
    id:                       int
    delay_minutes:            float
    affected_chainage_km:     float
    received_at:              datetime
    triggered_reoptimization: bool

    model_config = {"from_attributes": True}


class DisruptionResponse(DisruptionEventResponse):
    """Full response from POST /monitor/disruption."""
    reoptimized:              bool
    reason:                   str | None = None
    reoptimization_result:    ScheduleOptimizeResponse | None = None


# ===========================================================================
# Notifications
# ===========================================================================

class NotificationResponse(BaseModel):
    """One in-app notification record."""
    id:              int
    department_name: str
    event_type:      str
    block_id:        int | None
    message:         str
    created_at:      datetime
    read_at:         datetime | None

    model_config = {"from_attributes": True}


# ===========================================================================
# SHAP Explainability
# ===========================================================================

class ShapExplanation(BaseModel):
    """SHAP values for a risk prediction."""
    base_value:     float
    shap_values:    dict[str, float]
    feature_values: dict[str, float]


class EnrichedBlockWithShap(EnrichedBlockResponse):
    """ScheduledBlock enriched with SHAP explanation."""
    shap_explanation: ShapExplanation | None = None


# ===========================================================================
# What-If Preview
# ===========================================================================

class PreviewBlockResponse(BaseModel):
    """A block from a dry-run / What-If preview (no DB ID)."""
    id:               int | None = None
    task_id:          int
    chainage_km:      float
    start_time:       datetime
    end_time:         datetime
    status:           str
    parent_block_id:  int | None = None
    rejection_reason: str | None = None
    created_at:       datetime | None = None


class SchedulePreviewResponse(BaseModel):
    """Response from POST /schedule/optimize/preview (What-If sandbox)."""
    dry_run:           bool = True
    tasks_scheduled:   int
    tasks_unscheduled: int
    blocks_created:    int
    blocks:            list[PreviewBlockResponse]


# ===========================================================================
# Letters
# ===========================================================================

class LetterResponse(BaseModel):
    """Metadata for a downloadable block sanction letter."""
    block_id:       int
    department:     str
    reference:      str
    status:         str
    available:      bool = True


class ScheduledBlockFlat(BaseModel):
    """Flat block response for nullable IDs (preview blocks)."""
    id:               int | None = None
    task_id:          int
    chainage_km:      float
    start_time:       datetime
    end_time:         datetime
    status:           str
    parent_block_id:  int | None = None
    rejection_reason: str | None = None
    created_at:       datetime | None = None

