from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.mediasoup_client import sfu
from app.core.rabbitmq import close_rabbitmq, get_rabbitmq, init_rabbitmq
from app.core.redis_client import close_redis, get_redis, init_redis
from app.modules.auth.router import router as auth_router
from app.modules.meeting.router import router as meeting_router
from app.modules.meeting.websocket import router as signaling_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ── Startup ───────────────────────────────────────────────────────────
    await init_redis()
    await init_rabbitmq()
    await sfu.start()          # open persistent HTTP connection pool to mediasoup
    yield
    # ── Shutdown ──────────────────────────────────────────────────────────
    await sfu.stop()
    await close_redis()
    await close_rabbitmq()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description=(
        "SaaS WebRTC Video Meeting Platform — modular monolith backend. "
        "Modules: Auth, Meeting, WebRTC Signaling."
    ),
    lifespan=lifespan,
)

# ── CORS ─────────────────────────────────────────────────────────────────────
# Origins are controlled via the CORS_ORIGINS env var (comma-separated).
# Default is localhost:5173 for local development only.
# In production set: CORS_ORIGINS=https://app.yourplatform.com
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS_LIST,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────

API_PREFIX = "/api/v1"

app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(meeting_router, prefix=API_PREFIX)
app.include_router(signaling_router)  # WebSocket — no /api/v1 prefix, uses /ws/meetings/{id}


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health", tags=["Health"], summary="Deep health check — DB, Redis, RabbitMQ")
async def health_check() -> dict:
    checks = {}

    # Postgres
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception as e:
        checks["postgres"] = f"error: {e}"

    # Redis
    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    # RabbitMQ
    try:
        conn = get_rabbitmq()
        checks["rabbitmq"] = "ok" if not conn.is_closed else "error: connection closed"
    except Exception as e:
        checks["rabbitmq"] = f"error: {e}"

    overall = "healthy" if all(v == "ok" for v in checks.values()) else "degraded"

    return {
        "status": overall,
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "checks": checks,
    }
