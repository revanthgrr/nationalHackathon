"""
seed_users.py — Demo user provisioning for RailSetu.

⚠️  DEMO ONLY — This script creates accounts with known passwords and
prints credentials to the console.  In a production environment, accounts
would be provisioned through a secure admin workflow, not a seeding script.

Usage:
    cd backend
    python seed_users.py

Reads real department names from the maintenance_tasks table so the seeded
department accounts match actual pipeline data.
"""

from __future__ import annotations

import sys

from sqlalchemy import text

from auth import hash_password
from database import Base, SessionLocal, engine
from models import MaintenanceTask, User  # noqa: F401 — registers models


def seed():
    """Create demo accounts — idempotent (skips existing emails)."""
    # Ensure tables exist
    Base.metadata.create_all(bind=engine, checkfirst=True)

    db = SessionLocal()
    try:
        created: list[dict] = []

        # 1. Section Controller (admin)
        admin_email = "admin@railsetu.in"
        existing = db.query(User).filter(User.email == admin_email).first()
        if existing is None:
            admin = User(
                email=admin_email,
                password_hash=hash_password("admin123"),
                role="section_controller",
                department_name=None,
                display_name="Section Controller",
            )
            db.add(admin)
            created.append({
                "email": admin_email,
                "password": "admin123",
                "role": "section_controller",
                "department": None,
            })

        # 2. One account per department found in maintenance_tasks
        departments = (
            db.query(MaintenanceTask.department)
            .distinct()
            .all()
        )
        dept_names = sorted({d[0] for d in departments}) if departments else []

        # Fallback: if no tasks exist yet, use the standard three departments
        if not dept_names:
            dept_names = ["Civil", "Signalling", "Electrical"]

        for dept in dept_names:
            dept_email = f"{dept.lower().replace(' ', '_')}@railsetu.in"
            dept_password = f"{dept.lower()}123"
            existing = db.query(User).filter(User.email == dept_email).first()
            if existing is None:
                user = User(
                    email=dept_email,
                    password_hash=hash_password(dept_password),
                    role="department",
                    department_name=dept,
                    display_name=f"{dept} Department",
                )
                db.add(user)
                created.append({
                    "email": dept_email,
                    "password": dept_password,
                    "role": "department",
                    "department": dept,
                })

        db.commit()

        # Print credentials
        if created:
            print("\n" + "=" * 60)
            print("  RailSetu — Demo Accounts Seeded")
            print("=" * 60)
            for cred in created:
                print(f"\n  Email:      {cred['email']}")
                print(f"  Password:   {cred['password']}")
                print(f"  Role:       {cred['role']}")
                if cred["department"]:
                    print(f"  Department: {cred['department']}")
            print("\n" + "=" * 60)
            print(f"  Total: {len(created)} accounts created")
            print("=" * 60 + "\n")
        else:
            print("\nAll demo accounts already exist — no changes made.\n")

    finally:
        db.close()


if __name__ == "__main__":
    seed()
