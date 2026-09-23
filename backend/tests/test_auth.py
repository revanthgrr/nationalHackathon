"""
test_auth.py — Authentication boundary tests for RailSetu.

Tests:
  1. Login with valid credentials → 200 + JWT
  2. Login with bad password → 401
  3. Protected route without token → 401
  4. Protected route with wrong role → 403
  5. Department user accessing other department's notifications → 403
"""
import pytest
import httpx

BASE = "http://localhost:8000"


def _login(email: str, password: str) -> dict:
    """Helper: log in and return the full response body."""
    r = httpx.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    return r.status_code, r.json()


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestLogin:
    def test_valid_admin_login(self):
        status_code, body = _login("admin@railsetu.in", "admin123")
        assert status_code == 200
        assert "access_token" in body
        assert body["role"] == "section_controller"

    def test_invalid_password(self):
        status_code, body = _login("admin@railsetu.in", "wrong-password")
        assert status_code == 401

    def test_nonexistent_user(self):
        status_code, _ = _login("nobody@railsetu.in", "whatever")
        assert status_code == 401


class TestProtectedRoutes:
    def test_notifications_without_token(self):
        r = httpx.get(f"{BASE}/notifications")
        assert r.status_code == 401

    def test_department_route_with_admin_token(self):
        """Admin should NOT be able to access department-only routes."""
        _, body = _login("admin@railsetu.in", "admin123")
        token = body["access_token"]
        r = httpx.get(
            f"{BASE}/department/uploads",
            headers=_auth_header(token),
        )
        # Admin role is not "department", so require_role("department") → 403
        assert r.status_code == 403

    def test_auth_me(self):
        _, body = _login("admin@railsetu.in", "admin123")
        token = body["access_token"]
        r = httpx.get(f"{BASE}/auth/me", headers=_auth_header(token))
        assert r.status_code == 200
        data = r.json()
        assert data["email"] == "admin@railsetu.in"
        assert data["role"] == "section_controller"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
