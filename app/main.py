from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.mediasoup_client import sfu
from app.core.rabbitmq import close_rabbitmq, init_rabbitmq
from app.core.redis_client import close_redis, init_redis
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

@app.get("/health", tags=["Health"], summary="Liveness probe")
async def health_check() -> dict:
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }
