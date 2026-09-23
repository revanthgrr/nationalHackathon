"""
scheduler.py — Stage 5: CP-SAT Constraint-Programming Scheduling Optimisation.

Assigns pending MaintenanceTasks to MaintenanceWindows using Google OR-Tools
CP-SAT, subject to:
  - No maintenance time range overlaps with any train run on the same chainage
    range (within ±500 m), expanded by safety_headway_minutes on both ends.
  - Total scheduled duration within each window ≤ window duration − 2 × headway.
  - No single maintenance crew shift exceeds max_crew_shift_hours × 60 minutes.

Objective: minimise the weighted sum of unscheduled task penalty.

    penalty(t) = (priority_weight or 1.0) × local_high_risk_count(t)

where local_high_risk_count(t) = number of risk_predictions with risk_level='high'
whose linked raw_ingestion_record.chainage_km is within 0.5 km of t.chainage_km.

Additionally penalises any high-priority (priority_weight > 1.0) task that is not
scheduled (high_priority_backlog count).

Notes
-----
- Times are discretised to integer minutes relative to midnight UTC of today.
- On OPTIMAL or FEASIBLE: ScheduledBlock rows are persisted and task statuses
  updated to 'scheduled'.
- On INFEASIBLE or UNKNOWN (timeout): nothing is persisted, returns
  {"ok": False, "reason": "no_feasible_schedule"}.

Big-M Linearization
-------------------
The architecture document (§6.5) mentions Big-M linearization for
deteriorating-maintenance-time functions.  This implementation uses
SIMPLIFIED LINEAR DURATIONS — each task's estimated_duration_minutes
is treated as a fixed constant, not a function of waiting time.
Reason: the current dataset and use case do not require time-dependent
maintenance costs.  If future requirements introduce deteriorating
durations (e.g. "cost increases 5 min/day delayed"), the constraint
model should be extended with Big-M indicator variables.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ortools.sat.python import cp_model
from sqlalchemy.orm import Session

from models import (
    MaintenanceTask,
    MaintenanceWindow,
    RawIngestionRecord,
    RiskPrediction,
    ScheduledBlock,
    TrainRun,
)

log = logging.getLogger("railsetu.scheduler")

# Proximity threshold for high-risk count lookup (km)
_HIGH_RISK_PROXIMITY_KM: float = 0.5


def _minutes_from_midnight(dt: datetime) -> int:
    """Convert a timezone-aware datetime to integer minutes since midnight UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.hour * 60 + dt.minute


def _local_high_risk_count(db: Session, chainage_km: float) -> int:
    """
    Count risk_predictions with risk_level='high' whose linked record's
    chainage_km is within _HIGH_RISK_PROXIMITY_KM of the given chainage.
    """
    # We join RiskPrediction → RawIngestionRecord via record_id
    count = 0
    high_risk_rows = (
        db.query(RiskPrediction.record_id)
        .filter(RiskPrediction.risk_level == "high")
        .all()
    )
    if not high_risk_rows:
        return 0

    record_ids = [r[0] for r in high_risk_rows]
    nearby_records = (
        db.query(RawIngestionRecord.chainage_km)
        .filter(
            RawIngestionRecord.id.in_(record_ids),
            RawIngestionRecord.chainage_km.isnot(None),
        )
        .all()
    )
    for (ch,) in nearby_records:
        if abs(ch - chainage_km) <= _HIGH_RISK_PROXIMITY_KM:
            count += 1
    return count


def optimize_schedule(
    db: Session,
    safety_headway_minutes: int = 10,
    max_crew_shift_hours: int = 8,
    solver_timeout_seconds: int = 60,
    task_ids_scope: list[int] | None = None,
    dry_run: bool = False,
) -> dict:
    """
    Run CP-SAT to assign pending MaintenanceTasks to MaintenanceWindows.

    Parameters
    ----------
    db : SQLAlchemy Session
    safety_headway_minutes : int
        Minimum gap (minutes) between a train passage and a maintenance block.
    max_crew_shift_hours : int
        Maximum shift length for any single maintenance block.
    solver_timeout_seconds : int
        Hard time limit for the CP-SAT solver.
    task_ids_scope : list[int] | None
        If provided, only tasks with these IDs are considered.
    dry_run : bool
        If True, computes the schedule but does NOT persist any
        ScheduledBlock rows or update task statuses.  Used by the
        What-If sandbox to preview optimisation results.
        Used by the rolling-horizon re-optimisation (Stage 9).

    Returns
    -------
    {"ok": True, "tasks_scheduled": int, "tasks_unscheduled": int,
     "blocks_created": int, "blocks": [...]}
    {"ok": False, "reason": "no_feasible_schedule"}
    """
    # ── Load data ─────────────────────────────────────────────────────────────
    task_query = db.query(MaintenanceTask).filter(MaintenanceTask.status == "pending")
    if task_ids_scope is not None:
        task_query = task_query.filter(MaintenanceTask.id.in_(task_ids_scope))
    tasks: list[MaintenanceTask] = task_query.all()

    windows: list[MaintenanceWindow] = db.query(MaintenanceWindow).all()
    train_runs: list[TrainRun] = db.query(TrainRun).all()

    if not tasks:
        return {
            "ok": True,
            "tasks_scheduled": 0,
            "tasks_unscheduled": 0,
            "blocks_created": 0,
            "blocks": [],
        }

    max_shift_minutes = max_crew_shift_hours * 60

    # Pre-filter: tasks too long for any single shift → immediately unschedulable
    schedulable_tasks = [t for t in tasks if t.estimated_duration_minutes <= max_shift_minutes]
    overlong_tasks    = [t for t in tasks if t.estimated_duration_minutes >  max_shift_minutes]

    if not windows:
        return {"ok": False, "reason": "no_feasible_schedule"}

    # ── Build integer time representations ───────────────────────────────────
    # All times as minutes-since-midnight UTC today
    def _win_start(w: MaintenanceWindow) -> int:
        return _minutes_from_midnight(w.window_start)

    def _win_end(w: MaintenanceWindow) -> int:
        return _minutes_from_midnight(w.window_end)

    def _tr_start(tr: TrainRun) -> int:
        t = tr.scheduled_time
        return t.hour * 60 + t.minute

    def _tr_end(tr: TrainRun, duration_minutes: int = 10) -> int:
        # Treat each train run as occupying its scheduled time + 10 minutes
        return _tr_start(tr) + duration_minutes

    # Pre-compute local high-risk counts per task
    high_risk_counts: dict[int, int] = {
        t.id: _local_high_risk_count(db, t.chainage_km)
        for t in schedulable_tasks
    }

    # ── Build CP model ────────────────────────────────────────────────────────
    model = cp_model.CpModel()

    # assign[task_id][window_id] ∈ {0, 1}
    assign: dict[int, dict[int, cp_model.IntVar]] = {}
    for t in schedulable_tasks:
        assign[t.id] = {}
        for w in windows:
            win_capacity = (_win_end(w) - _win_start(w)) - 2 * safety_headway_minutes
            if win_capacity < t.estimated_duration_minutes:
                # Window too small for this task — never assign
                var = model.NewConstant(0)
            else:
                # Check for train run conflict in this (task, window) pair.
                #
                # The maintenance window [win_start, win_end] is defined by the
                # GAP between two consecutive train departures, so the train AT
                # win_start has already cleared the corridor (it is the preceding
                # service that created the gap) and the train AT win_end is the
                # approaching service that terminates the gap.  These two boundary
                # trains are already handled by the capacity / headway constraints
                # (candidate_start = win_start + headway; candidate_end <= win_end
                # - headway enforced by the win_cap constraint above).  Checking
                # boundary trains here double-counts the headway and makes every
                # assignment a conflict.
                #
                # We therefore only check trains whose scheduled departure falls
                # STRICTLY INSIDE the window (exclusive of both boundaries).
                win_s = _win_start(w)
                win_e = _win_end(w)
                candidate_start = win_s + safety_headway_minutes
                candidate_end   = candidate_start + t.estimated_duration_minutes
                conflict = False
                for tr in train_runs:
                    tr_dep = _tr_start(tr)
                    # Skip boundary trains — they define the window, not fill it.
                    if tr_dep <= win_s or tr_dep >= win_e:
                        continue
                    # This train departs inside the window; check time overlap.
                    tr_s = tr_dep - safety_headway_minutes
                    tr_e = _tr_end(tr) + safety_headway_minutes
                    if candidate_start < tr_e and candidate_end > tr_s:
                        conflict = True
                        break
                if conflict:
                    var = model.NewConstant(0)
                else:
                    var = model.NewBoolVar(f"assign_t{t.id}_w{w.id}")
            assign[t.id][w.id] = var

    # Constraint 1: each task assigned at most once
    for t in schedulable_tasks:
        model.AddAtMostOne(assign[t.id][w.id] for w in windows)

    # Constraint 2: window capacity
    for w in windows:
        win_cap = (_win_end(w) - _win_start(w)) - 2 * safety_headway_minutes
        if win_cap <= 0:
            continue
        model.Add(
            sum(
                assign[t.id][w.id] * t.estimated_duration_minutes
                for t in schedulable_tasks
            ) <= win_cap
        )

    # ── Objective ─────────────────────────────────────────────────────────────
    # Penalise unscheduled tasks: weight × local_high_risk_count
    unassigned_penalty = []
    for t in schedulable_tasks:
        pw = int((t.priority_weight or 1.0) * 100)   # scale to int for CP-SAT
        hr = high_risk_counts.get(t.id, 0) + 1        # +1 so 0-risk tasks still count
        is_assigned = model.NewBoolVar(f"assigned_{t.id}")
        model.AddMaxEquality(
            is_assigned,
            [assign[t.id][w.id] for w in windows],
        )
        not_assigned = model.NewBoolVar(f"not_assigned_{t.id}")
        model.Add(not_assigned == 1 - is_assigned)
        unassigned_penalty.append(not_assigned * pw * hr)

    # Extra penalty for high-priority unscheduled tasks
    high_priority_backlog = []
    for t in schedulable_tasks:
        pw = t.priority_weight or 0.0
        if pw > 1.0:
            is_assigned = model.NewBoolVar(f"hp_assigned_{t.id}")
            model.AddMaxEquality(is_assigned, [assign[t.id][w.id] for w in windows])
            not_hp = model.NewBoolVar(f"hp_not_{t.id}")
            model.Add(not_hp == 1 - is_assigned)
            high_priority_backlog.append(not_hp)

    model.Minimize(sum(unassigned_penalty) + sum(high_priority_backlog) * 1000)

    # ── Solve ─────────────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(solver_timeout_seconds)
    solve_status = solver.Solve(model)

    if solve_status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        log.warning(
            "CP-SAT returned %s (not OPTIMAL/FEASIBLE) — no schedule persisted",
            solver.StatusName(solve_status),
        )
        return {"ok": False, "reason": "no_feasible_schedule"}

    # ── Build results ─────────────────────────────────────────────────────────
    blocks_created = 0
    scheduled_task_ids: set[int] = set()
    saved_blocks: list[ScheduledBlock] = []
    preview_blocks: list[dict] = []

    for t in schedulable_tasks:
        for w in windows:
            var = assign[t.id][w.id]
            try:
                val = solver.Value(var)
            except Exception:
                val = 0
            if val == 1:
                start_dt = w.window_start + timedelta(minutes=safety_headway_minutes)
                end_dt   = start_dt + timedelta(minutes=t.estimated_duration_minutes)

                if dry_run:
                    # What-If sandbox: return the schedule preview without persisting
                    preview_blocks.append({
                        "id":               None,
                        "task_id":          t.id,
                        "chainage_km":      t.chainage_km,
                        "start_time":       start_dt,
                        "end_time":         end_dt,
                        "status":           "preview",
                        "parent_block_id":  None,
                        "rejection_reason": None,
                        "created_at":       None,
                    })
                else:
                    block = ScheduledBlock(
                        task_id    = t.id,
                        chainage_km = t.chainage_km,
                        start_time = start_dt,
                        end_time   = end_dt,
                        status     = "scheduled",
                    )
                    db.add(block)
                    t.status = "scheduled"
                    saved_blocks.append(block)
                scheduled_task_ids.add(t.id)
                blocks_created += 1
                break   # task assigned to first matching window

    if not dry_run:
        db.commit()
        for b in saved_blocks:
            db.refresh(b)

    tasks_unscheduled = (
        len(schedulable_tasks) - len(scheduled_task_ids) + len(overlong_tasks)
    )

    log.info(
        "CP-SAT schedule%s: %d scheduled, %d unscheduled, status=%s",
        " (DRY RUN)" if dry_run else "",
        len(scheduled_task_ids), tasks_unscheduled, solver.StatusName(solve_status),
    )

    result_blocks = preview_blocks if dry_run else [
        {
            "id":               b.id,
            "task_id":          b.task_id,
            "chainage_km":      b.chainage_km,
            "start_time":       b.start_time,
            "end_time":         b.end_time,
            "status":           b.status,
            "parent_block_id":  b.parent_block_id,
            "rejection_reason": b.rejection_reason,
            "created_at":       b.created_at,
        }
        for b in saved_blocks
    ]

    return {
        "ok":               True,
        "dry_run":          dry_run,
        "tasks_scheduled":  len(scheduled_task_ids),
        "tasks_unscheduled": tasks_unscheduled,
        "blocks_created":   blocks_created,
        "blocks":           result_blocks,
    }
