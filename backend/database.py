"""
database.py — SQLAlchemy engine and session setup for RailSetu.

DATABASE_URL is read from the environment; falls back to the local-dev
default that matches the docker-compose service credentials.
"""

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql://railflow:railflow@localhost:5432/railflow",
)

engine = create_engine(
    DATABASE_URL,
    # Keep a small pool; the ingestion layer is not high-concurrency yet.
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,  # Detect stale connections (important after restarts).
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Shared declarative base for all ORM models."""
    pass


def get_db():
    """
    FastAPI dependency — yields a SQLAlchemy session and ensures it is
    closed after the request, even if an exception is raised.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
