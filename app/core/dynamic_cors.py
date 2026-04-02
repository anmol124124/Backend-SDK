"""
Dynamic CORS middleware.

Allowed origins are resolved in this order:
1. CORS_ORIGINS env var  — static list (comma-separated), supports "*"
2. project_domains table — every domain added to any project is auto-allowed

DB domains are cached for CACHE_TTL seconds and invalidated immediately
whenever a domain is added or removed (call invalidate_cors_cache()).
"""

import time
from urllib.parse import urlparse

from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.modules.project.models import ProjectDomain

CACHE_TTL = 30  # seconds

_cache: set[str] = set()
_cache_ts: float = 0.0


def invalidate_cors_cache() -> None:
    """Call this after adding or removing a project domain."""
    global _cache_ts
    _cache_ts = 0.0


async def _get_db_domains() -> set[str]:
    global _cache, _cache_ts
    if time.time() - _cache_ts < CACHE_TTL:
        return _cache
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(ProjectDomain.domain))
        _cache = set(result.scalars().all())
        _cache_ts = time.time()
    return _cache


def _netloc(origin: str) -> str:
    try:
        return urlparse(origin).netloc or ""
    except Exception:
        return ""


async def _is_allowed(origin: str) -> bool:
    if not origin:
        return True

    # Wildcard in env → allow everything
    if "*" in settings.CORS_ORIGINS_LIST:
        return True

    # Exact match against env list
    if origin in settings.CORS_ORIGINS_LIST:
        return True

    # Check project_domains table (by netloc)
    db_domains = await _get_db_domains()
    return _netloc(origin) in db_domains


class DynamicCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin", "")
        allowed = await _is_allowed(origin)

        # Preflight request
        if request.method == "OPTIONS":
            if allowed:
                res = Response(status_code=200)
                res.headers["Access-Control-Allow-Origin"] = origin
                res.headers["Access-Control-Allow-Credentials"] = "true"
                res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
                res.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Accept"
                return res
            return Response(status_code=403)

        response = await call_next(request)

        if origin and allowed:
            # Background images are public — always return wildcard so any
            # origin gets them. Echoing a specific origin here would poison
            # shared CDN/browser caches for other origins.
            if request.url.path.startswith("/api/v1/bg/"):
                response.headers["Access-Control-Allow-Origin"] = "*"
            else:
                response.headers["Access-Control-Allow-Origin"] = origin
                response.headers["Access-Control-Allow-Credentials"] = "true"

        return response
