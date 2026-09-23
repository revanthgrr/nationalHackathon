"""
auth.py — JWT authentication & role-based authorization for RailSetu.

Provides:
    - Password hashing via passlib/bcrypt
    - JWT access tokens (HS256, short-lived)
    - FastAPI dependencies for extracting the current user and enforcing roles
    - POST /auth/login and GET /auth/me endpoints (attached in main.py)

Accounts are provisioned via seed_users.py — no self-registration.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
import bcrypt
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import User

log = logging.getLogger("railsetu.auth")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# SECRET_KEY should be set in production via environment variable.
# This default is for local dev / demo only.
SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "railsetu-demo-secret-key-change-in-production")
ALGORITHM: str = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

# ---------------------------------------------------------------------------
# Password hashing (direct bcrypt — avoids passlib compatibility issues)
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


# ---------------------------------------------------------------------------
# JWT token creation / decoding
# ---------------------------------------------------------------------------

def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a signed JWT with the given payload."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT. Raises JWTError on invalid/expired tokens."""
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


# ---------------------------------------------------------------------------
# Pydantic schemas for auth
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    department_name: str | None = None
    display_name: str


class UserResponse(BaseModel):
    id: int
    email: str
    role: str
    department_name: str | None
    display_name: str

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# FastAPI security scheme
# ---------------------------------------------------------------------------

# tokenUrl must match the login endpoint path
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

# Strict version that always requires auth (raises 401)
oauth2_scheme_required = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=True)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

def get_current_user(
    token: Annotated[str | None, Depends(oauth2_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User | None:
    """
    Extract the current user from the JWT bearer token.
    Returns None if no token is provided (for optional auth).
    Raises 401 if token is present but invalid/expired.
    """
    if token is None:
        return None

    try:
        payload = decode_access_token(token)
        email: str | None = payload.get("sub")
        if email is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token.",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def get_current_user_required(
    token: Annotated[str, Depends(oauth2_scheme_required)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """
    Like get_current_user but ALWAYS requires authentication.
    Raises 401 if no token or invalid token.
    """
    try:
        payload = decode_access_token(token)
        email: str | None = payload.get("sub")
        if email is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token.",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_role(*allowed_roles: str):
    """
    Factory that returns a FastAPI dependency enforcing role-based access.

    Usage:
        @app.get("/admin/something", dependencies=[Depends(require_role("section_controller"))])
        def admin_endpoint(...):

    Or inject the user directly:
        def admin_endpoint(user: User = Depends(require_role("section_controller"))):
    """
    def _dependency(
        token: Annotated[str, Depends(oauth2_scheme_required)],
        db: Annotated[Session, Depends(get_db)],
    ) -> User:
        user = get_current_user_required(token, db)
        if user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied. Required role: {', '.join(allowed_roles)}. Your role: {user.role}.",
            )
        return user
    return _dependency
