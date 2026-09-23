"""
task_service.py — Maintenance Task generation and correlation with predictive telemetry.
Bridges Stage 3 (Risk & Delay Predictions) to Stage 5 (CP-SAT Scheduling).
"""

import logging
from sqlalchemy.orm import Session
from models import MaintenanceTask, RawIngestionRecord, RiskPrediction

log = logging.getLogger("railsetu.tasks")

DEPT_MAP = {
    "TMS":  "Civil",
    "SMMS": "Signalling",
    "TDMS": "Electrical",
    "COA":  "Civil",
}


def auto_generate_tasks_from_risk(
    db: Session,
    min_prob: float = 0.65,
) -> list[MaintenanceTask]:
    """
    Scans risk_predictions for high/critical probability sections that do not yet
    have a pending or active MaintenanceTask, and persists MaintenanceTask rows.
    Clusters by ~100m chainage and department to avoid duplicate demands.
    """
    high_risks = (
        db.query(RiskPrediction)
        .filter(RiskPrediction.probability >= min_prob)
        .order_by(RiskPrediction.probability.desc())
        .all()
    )
    if not high_risks:
        return []

    rec_ids = [hr.record_id for hr in high_risks]
    records = {
        r.id: r
        for r in db.query(RawIngestionRecord).filter(RawIngestionRecord.id.in_(rec_ids)).all()
    }

    # Avoid duplicate tasks for the same ~100m track section and department
    existing_tasks = db.query(MaintenanceTask).all()
    existing_keys = {(round(t.chainage_km, 1), t.department) for t in existing_tasks}

    created_tasks: list[MaintenanceTask] = []
    seen = set(existing_keys)

    for hr in high_risks:
        rec = records.get(hr.record_id)
        if not rec or rec.chainage_km is None:
            continue
        dept = DEPT_MAP.get(rec.source_system, "Civil")
        key = (round(rec.chainage_km, 1), dept)
        if key in seen:
            continue
        seen.add(key)

        duration = 60 if dept == "Civil" else (45 if dept == "Signalling" else 50)
        task = MaintenanceTask(
            chainage_km=round(rec.chainage_km, 2),
            department=dept,
            estimated_duration_minutes=duration,
            priority_weight=round(float(hr.probability), 2),
            status="pending",
        )
        db.add(task)
        created_tasks.append(task)

    if created_tasks:
        try:
            db.commit()
            for t in created_tasks:
                db.refresh(t)
            log.info(
                "Auto-generated %d maintenance tasks from high-risk telemetry (threshold=%.2f)",
                len(created_tasks), min_prob,
            )
        except Exception as exc:
            db.rollback()
            log.error("Failed to commit auto-generated tasks: %s", exc)
            return []

    return created_tasks
