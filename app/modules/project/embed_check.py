"""
Shared helper: check whether a given origin is allowed for an embed token.
Used by both the HTTP pre-check endpoint and the WebSocket handler.
"""

import uuid
from urllib.parse import urlparse

from jose import JWTError, jwt
from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.modules.project.models import ProjectDomain


def _extract_host(origin: str) -> str:
    if not origin:
        return ""
    try:
        parsed = urlparse(origin)
        return parsed.netloc or ""
    except Exception:
        return ""


async def check_embed_domain(token: str, origin: str) -> bool:
    """
    Returns True if the origin is permitted to use this embed token.
    - Tokens without project_id → always allowed (regular user tokens).
    - Tokens with project_id and no domains configured → blocked (closed by default).
    - Tokens with project_id and domains configured → only matching hosts allowed.
    """
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return False

    raw_project_id = payload.get("project_id")
    if not raw_project_id:
        return True  # not an embed token, skip domain check

    try:
        project_id = uuid.UUID(raw_project_id)
    except ValueError:
        return False

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ProjectDomain).where(ProjectDomain.project_id == project_id)
        )
        allowed = [row.domain for row in result.scalars().all()]

    if not allowed:
        return False  # no domains configured → block all

    return _extract_host(origin) in allowed
