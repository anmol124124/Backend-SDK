"""
RS256 token utilities for public meeting tokens.

Two token types:
  - public_host  : issued to a logged-in user who created/hosts a public meeting
  - public_guest : issued to an anonymous user who joins via a shared URL

Both are signed with the RSA private key and verified with the public key.
This ensures only this backend can create valid tokens — forging is impossible
without the private key.
"""

import base64
import uuid as _uuid
from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError

from app.core.config import settings

# Token lifetimes
_HOST_TOKEN_TTL_HOURS  = 12
_GUEST_TOKEN_TTL_HOURS = 12

_ALGORITHM = "RS256"


def _private_key() -> str:
    """Decode base64 PEM private key from settings."""
    return base64.b64decode(settings.RSA_PRIVATE_KEY).decode()


def _public_key() -> str:
    """Decode base64 PEM public key from settings."""
    return base64.b64decode(settings.RSA_PUBLIC_KEY).decode()


def create_host_token(user_id: str, room_code: str) -> str:
    """
    Create a short-lived RS256 token for a logged-in meeting host.
    The WebSocket handler uses this to authenticate the host.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=_HOST_TOKEN_TTL_HOURS)
    payload = {
        "sub":       user_id,
        "room":      room_code,
        "type":      "public_host",
        "exp":       expire,
        "jti":       str(_uuid.uuid4()),
    }
    return jwt.encode(payload, _private_key(), algorithm=_ALGORITHM)


def create_guest_token(name: str, room_code: str) -> str:
    """
    Create a short-lived RS256 token for an anonymous meeting guest.
    The WebSocket handler uses this to authenticate the guest.
    """
    expire = datetime.now(timezone.utc) + timedelta(hours=_GUEST_TOKEN_TTL_HOURS)
    payload = {
        "sub":       f"guest:{_uuid.uuid4()}",   # unique per session
        "name":      name,
        "room":      room_code,
        "type":      "public_guest",
        "exp":       expire,
        "jti":       str(_uuid.uuid4()),
    }
    return jwt.encode(payload, _private_key(), algorithm=_ALGORITHM)


def decode_public_token(token: str) -> dict:
    """
    Verify and decode an RS256 public meeting token.
    Raises jose.JWTError if invalid or expired.
    """
    return jwt.decode(token, _public_key(), algorithms=[_ALGORITHM])


def is_public_token(token: str) -> bool:
    """
    Quick check — returns True if the token is a valid RS256 public meeting token.
    Does NOT raise; returns False on any error.
    """
    try:
        payload = decode_public_token(token)
        return payload.get("type") in ("public_host", "public_guest")
    except JWTError:
        return False
