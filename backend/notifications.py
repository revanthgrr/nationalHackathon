"""
notifications.py — Shared notification service and BDMS integration stub.

send_notification() fires emails via smtplib AND persists to the in-app
notifications table on key pipeline events:
  - "block_accepted"     — field controller approved a scheduled block
  - "block_rejected"     — field controller rejected a scheduled block
  - "disruption_detected" — a live disruption triggered re-optimisation

execute_schedule() is the BDMS permit stub (see inline comment).

Email credentials are read from environment variables — never hardcoded.
The function is fire-and-forget: SMTP errors are logged but never propagate
to the calling endpoint.

In-app notifications are persisted to the `notifications` table so the
department-facing /department/notifications page can display them.
"""

from __future__ import annotations

import logging
import os
import smtplib
from email.mime.text import MIMEText

from sqlalchemy.orm import Session

log = logging.getLogger("railsetu.notifications")

_REQUIRED_ENV_VARS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "NOTIFICATION_EMAIL_TO")


def _build_message(event_type: str, details: dict) -> str:
    """Build a human-readable notification message from event details."""
    parts = [f"RailSetu Event: {event_type.replace('_', ' ').title()}"]
    for key, val in details.items():
        parts.append(f"  {key}: {val}")
    return "\n".join(parts)


def send_notification(
    event_type: str,
    details: dict,
    db: Session | None = None,
) -> None:
    """
    Send a structured notification for a pipeline event.

    This function does TWO things:
    1. Sends an email via SMTP (if configured — silently skipped if not)
    2. Persists a row to the notifications table (if db session provided)

    Parameters
    ----------
    event_type : str
        One of "block_accepted", "block_rejected", "disruption_detected".
    details : dict
        Context-specific key/value pairs included in the notification.
    db : Session | None
        SQLAlchemy session for persisting in-app notification.
        If None, only email is attempted (backwards compatible).

    The function is fire-and-forget — it never raises. Missing SMTP
    configuration is logged as a warning and the call returns immediately.
    """
    message = _build_message(event_type, details)

    # ── Persist in-app notification ───────────────────────────────────────────
    if db is not None:
        try:
            from models import Notification

            department = details.get("department", "unknown")
            block_id = details.get("block_id")

            notification = Notification(
                department_name=department,
                event_type=event_type,
                block_id=int(block_id) if block_id is not None else None,
                message=message,
            )
            db.add(notification)
            db.commit()
            db.refresh(notification)
            log.info(
                "In-app notification saved: id=%s dept=%s event=%s",
                notification.id, department, event_type,
            )
        except Exception as exc:
            log.error("Failed to persist in-app notification: %s", exc)
            try:
                db.rollback()
            except Exception:
                pass

    # ── Send email via SMTP ───────────────────────────────────────────────────
    missing = [v for v in _REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        log.warning(
            "Email notification skipped: SMTP not configured (missing: %s)",
            ", ".join(missing),
        )
        return

    smtp_host  = os.environ["SMTP_HOST"]
    smtp_port  = int(os.environ["SMTP_PORT"])
    smtp_user  = os.environ["SMTP_USER"]
    smtp_pass  = os.environ["SMTP_PASSWORD"]
    email_to   = os.environ["NOTIFICATION_EMAIL_TO"]

    subject = f"[RailSetu] {event_type.replace('_', ' ').title()}"
    body_lines = [message, "", "-- RailSetu Pipeline (automated notification)"]
    body = "\n".join(body_lines)

    msg = MIMEText(body, "plain")
    msg["Subject"] = subject
    msg["From"]    = smtp_user
    msg["To"]      = email_to

    try:
        # EXTENSIBILITY: swap smtplib for Twilio SMS or Firebase FCM by replacing this block.
        with smtplib.SMTP_SSL(smtp_host, smtp_port) as server:
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, [email_to], msg.as_string())
        log.info("Email notification sent: event_type=%s to=%s", event_type, email_to)
    except Exception as exc:
        log.error(
            "Email notification failed (event_type=%s): %s",
            event_type, exc,
        )


def execute_schedule(block_id: int) -> None:
    """
    Submit a scheduled block to the external BDMS permit system.

    # STUB: Replace with actual BDMS permit API call in production.
    Currently logs what would be sent; no external call is made.
    """
    # STUB: Replace with actual BDMS permit API call in production.
    log.info("BDMS permit stub: block %s submitted", block_id)
