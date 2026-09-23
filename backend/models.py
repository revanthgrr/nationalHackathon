"""
models.py — ORM model for the raw ingestion layer.

All source systems (TMS, SMMS, TDMS, COA) land in the single table
`raw_ingestion_records`, distinguished by the `source_system` column.

The table is converted to a TimescaleDB hypertable partitioned by
`ingested_at` at application startup (see main.py).  TimescaleDB
requires the partition column to be part of the primary key, so the
primary key is composite: (id, ingested_at).
"""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Float,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Time,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP

from database import Base


class RawIngestionRecord(Base):
    __tablename__ = "raw_ingestion_records"

    # --- Primary key ---
    # Composite (id, ingested_at) so TimescaleDB can partition by ingested_at.
    id = Column(BigInteger, autoincrement=True, nullable=False)
    ingested_at = Column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        PrimaryKeyConstraint("id", "ingested_at", name="pk_raw_ingestion"),
    )

    # --- Source identifier ---
    source_system = Column(String(10), nullable=False, index=True)  # TMS | SMMS | TDMS | COA

    # --- Location fields (at least one must be present — enforced in Pydantic) ---
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    station_code = Column(String(20), nullable=True, index=True)
    mast_id = Column(String(50), nullable=True, index=True)

    # --- Observation time (when the telemetry was MEASURED, not when ingested) ---
    # Populated from CSV `observation_time` column or explicit API field.
    # NULL for records ingested via the manual POST /ingest/* endpoints that
    # do not supply this field.  When present, the delay window builder uses
    # this column for time-series ordering instead of ingested_at.
    observation_time = Column(TIMESTAMP(timezone=True), nullable=True, index=True)

    # --- Chainage (filled by Stage 2, NULL on ingestion) ---
    chainage_km = Column(Float, nullable=True)

    # --- Chainage error (NULL on success; short reason string on failure) ---
    # Safe ALTER for existing databases — idempotent ALTER runs at startup.
    chainage_error = Column(String(100), nullable=True)

    # --- Source-specific payload (TQI/GMT for TMS, relay voltage for SMMS …) ---
    payload = Column(JSONB, nullable=False, default=dict)

    # --- Pipeline state ---
    chainage_processed = Column(Boolean, nullable=False, default=False, server_default=text("false"))

    def __repr__(self) -> str:
        return (
            f"<RawIngestionRecord id={self.id} source={self.source_system} "
            f"ingested_at={self.ingested_at}>"
        )


# ---------------------------------------------------------------------------
# Stage 3a — Risk Prediction results
# ---------------------------------------------------------------------------

class RiskPrediction(Base):
    """
    One saved XGBoost risk prediction, tied to the source ingestion record.

    record_id references raw_ingestion_records.id (BigInteger, no FK
    constraint because raw_ingestion_records uses a composite PK with the
    TimescaleDB partition column ingested_at).
    """
    __tablename__ = "risk_predictions"

    id              = Column(BigInteger, primary_key=True, autoincrement=True)
    record_id       = Column(BigInteger, nullable=False, index=True)

    # Extracted feature values (stored for full traceability)
    tqi             = Column(Float, nullable=False)
    gmt             = Column(Float, nullable=False)
    age_since_maint = Column(Float, nullable=False)
    temperature     = Column(Float, nullable=False)

    # Model output
    probability     = Column(Float, nullable=False)
    risk_level      = Column(String(10), nullable=False)   # low | medium | high

    # Metadata
    predicted_at    = Column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    model_version   = Column(String(50), nullable=False, default="risk_model_2.json")

    def __repr__(self) -> str:
        return (
            f"<RiskPrediction id={self.id} record_id={self.record_id} "
            f"risk_level={self.risk_level} probability={self.probability:.4f}>"
        )


# ---------------------------------------------------------------------------
# Stage 3b — Delay Prediction results
# ---------------------------------------------------------------------------

class DelayPrediction(Base):
    """
    One saved GCN-LSTM delay prediction row (one row per station per run).

    All five station rows for a single inference call share the same run_id
    (UUID string) so they can be grouped when fetching a full prediction run.
    """
    __tablename__ = "delay_predictions"

    id                      = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id                  = Column(String(36), nullable=False, index=True)   # UUID

    # Input window provenance
    input_window_start      = Column(TIMESTAMP(timezone=True), nullable=True)
    input_window_end        = Column(TIMESTAMP(timezone=True), nullable=True)
    # Number of station-time observations used to build the 12×5 matrix
    obs_count               = Column(Integer, nullable=True)

    # Per-station result
    station_code            = Column(String(10), nullable=False, index=True)
    predicted_delay_minutes = Column(Float, nullable=False)

    # Metadata
    predicted_at            = Column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    model_version           = Column(String(50), nullable=False, default="delay_model.pt")

    def __repr__(self) -> str:
        return (
            f"<DelayPrediction id={self.id} run_id={self.run_id[:8]}… "
            f"station={self.station_code} delay={self.predicted_delay_minutes:.2f}>"
        )



# ---------------------------------------------------------------------------
# Stage 4 — Timetable Analysis
# ---------------------------------------------------------------------------

class TrainRun(Base):
    """One train service instance: route, scheduled time, day-of-week pattern."""
    __tablename__ = "train_runs"

    id             = Column(BigInteger, primary_key=True, autoincrement=True)
    route          = Column(String(200), nullable=False)
    scheduled_time = Column(Time(timezone=True), nullable=False)
    day_of_week    = Column(Integer, nullable=False)   # 0=Mon … 6=Sun
    is_daily       = Column(Boolean, default=False, nullable=False)
    created_at     = Column(TIMESTAMP(timezone=True), server_default=text("now()"))

    def __repr__(self) -> str:
        return f"<TrainRun id={self.id} route={self.route!r} time={self.scheduled_time}>"


class MaintenanceWindow(Base):
    """A free time interval on a chainage range, identified by timetable clustering."""
    __tablename__ = "maintenance_windows"

    id                   = Column(BigInteger, primary_key=True, autoincrement=True)
    window_start         = Column(TIMESTAMP(timezone=True), nullable=False)
    window_end           = Column(TIMESTAMP(timezone=True), nullable=False)
    chainage_range_start = Column(Float, nullable=False)
    chainage_range_end   = Column(Float, nullable=False)
    source_run_id        = Column(BigInteger, nullable=True)   # logical FK to train_runs.id
    created_at           = Column(TIMESTAMP(timezone=True), server_default=text("now()"))

    def __repr__(self) -> str:
        return (
            f"<MaintenanceWindow id={self.id} "
            f"start={self.window_start} end={self.window_end}>"
        )


# ---------------------------------------------------------------------------
# Stage 5 — Maintenance Tasks and Scheduled Blocks
# ---------------------------------------------------------------------------

class MaintenanceTask(Base):
    """A maintenance work item to be scheduled by CP-SAT."""
    __tablename__ = "maintenance_tasks"

    id                         = Column(BigInteger, primary_key=True, autoincrement=True)
    chainage_km                = Column(Float, nullable=False)
    department                 = Column(String(20), nullable=False)   # Civil|Signalling|Electrical
    estimated_duration_minutes = Column(Integer, nullable=False)
    priority_weight            = Column(Float, nullable=True)
    status                     = Column(String(20), nullable=False, default="pending")
    # pending → scheduled → bundled → executed
    created_at                 = Column(TIMESTAMP(timezone=True), server_default=text("now()"))

    def __repr__(self) -> str:
        return (
            f"<MaintenanceTask id={self.id} dept={self.department} "
            f"chainage={self.chainage_km} status={self.status}>"
        )


class ScheduledBlock(Base):
    """
    A maintenance task assigned to a specific time window after CP-SAT optimisation.
    Blocks may be nested (parent/child) after VNS bundling.
    """
    __tablename__ = "scheduled_blocks"

    id               = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id          = Column(BigInteger, ForeignKey("maintenance_tasks.id"), nullable=False)
    chainage_km      = Column(Float, nullable=False)
    start_time       = Column(TIMESTAMP(timezone=True), nullable=False)
    end_time         = Column(TIMESTAMP(timezone=True), nullable=False)
    status           = Column(String(20), nullable=False, default="scheduled")
    # scheduled → bundled → executed  (or back to pending on rejection)
    parent_block_id  = Column(BigInteger, ForeignKey("scheduled_blocks.id"), nullable=True)
    rejection_reason = Column(String(500), nullable=True)
    created_at       = Column(TIMESTAMP(timezone=True), server_default=text("now()"))

    def __repr__(self) -> str:
        return (
            f"<ScheduledBlock id={self.id} task_id={self.task_id} "
            f"status={self.status} start={self.start_time}>"
        )


# ---------------------------------------------------------------------------
# Stage 9 — Disruption Monitoring
# ---------------------------------------------------------------------------

class DisruptionEvent(Base):
    """A manually-reported or sensor-triggered disruption event."""
    __tablename__ = "disruption_events"

    id                       = Column(BigInteger, primary_key=True, autoincrement=True)
    delay_minutes            = Column(Float, nullable=False)
    affected_chainage_km     = Column(Float, nullable=False)
    received_at              = Column(TIMESTAMP(timezone=True), server_default=text("now()"))
    triggered_reoptimization = Column(Boolean, default=False, nullable=False)

    def __repr__(self) -> str:
        return (
            f"<DisruptionEvent id={self.id} delay={self.delay_minutes}min "
            f"reopt={self.triggered_reoptimization}>"
        )


# ---------------------------------------------------------------------------
# Authentication — Users
# ---------------------------------------------------------------------------

class User(Base):
    """
    Application user account.

    Roles:
        section_controller — admin access (scheduling, optimisation, review)
        department          — scoped to own department (upload, notifications, letters)

    Accounts are provisioned via seed script only — no self-registration.
    password_hash uses bcrypt via passlib.
    """
    __tablename__ = "users"

    id              = Column(BigInteger, primary_key=True, autoincrement=True)
    email           = Column(String(255), unique=True, nullable=False, index=True)
    password_hash   = Column(String(255), nullable=False)
    role            = Column(String(30), nullable=False)   # 'section_controller' | 'department'
    department_name = Column(String(100), nullable=True)   # required if role='department'
    display_name    = Column(String(200), nullable=False)
    created_at      = Column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<User id={self.id} email={self.email!r} "
            f"role={self.role} dept={self.department_name}>"
        )


# ---------------------------------------------------------------------------
# In-app Notifications (alongside SMTP email)
# ---------------------------------------------------------------------------

class Notification(Base):
    """
    In-app notification for department users.

    Populated alongside SMTP email by the notification service at
    Accept/Reject/Disruption events.  Each row is scoped to one
    department_name so department-facing queries filter by it.
    """
    __tablename__ = "notifications"

    id              = Column(BigInteger, primary_key=True, autoincrement=True)
    department_name = Column(String(100), nullable=False, index=True)
    event_type      = Column(String(50), nullable=False)    # block_accepted | block_rejected | disruption_detected
    block_id        = Column(BigInteger, nullable=True)
    message         = Column(String(2000), nullable=False)
    created_at      = Column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    read_at         = Column(TIMESTAMP(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return (
            f"<Notification id={self.id} dept={self.department_name!r} "
            f"type={self.event_type} read={self.read_at is not None}>"
        )
