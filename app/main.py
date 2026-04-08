import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.dynamic_cors import DynamicCORSMiddleware
from app.core.mediasoup_client import sfu
from app.core.rabbitmq import close_rabbitmq, get_rabbitmq, init_rabbitmq
from app.core.redis_client import close_redis, get_redis, init_redis
from app.modules.auth.router import router as auth_router
from app.modules.meeting.router import router as meeting_router
from app.modules.meeting.websocket import router as signaling_router
from app.modules.project.router import router as project_router
from app.modules.payments.router import router as payments_router
from app.modules.public_meeting.router import router as public_meeting_router
from app.modules.contact.router import router as contact_router


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
    redirect_slashes=False,
)

# ── CORS ─────────────────────────────────────────────────────────────────────
# Dynamic CORS: allowed origins = CORS_ORIGINS env var + all project_domains in DB.
# No server restart needed — adding/removing a domain takes effect immediately.
app.add_middleware(DynamicCORSMiddleware)

# ── ngrok browser warning bypass ─────────────────────────────────────────────
# ngrok free tier shows an interstitial warning page unless this header is set.
@app.middleware("http")
async def ngrok_skip_browser_warning(request, call_next):
    response = await call_next(request)
    response.headers["ngrok-skip-browser-warning"] = "true"
    return response

# ── Static files ──────────────────────────────────────────────────────────────
_PUBLIC_DIR = Path(__file__).parent.parent / "public"

app.mount("/public", StaticFiles(directory=_PUBLIC_DIR), name="public")

# ── Routers ───────────────────────────────────────────────────────────────────

API_PREFIX = "/api/v1"

app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(meeting_router, prefix=API_PREFIX)
app.include_router(project_router, prefix=API_PREFIX)
app.include_router(public_meeting_router, prefix=API_PREFIX)
app.include_router(payments_router, prefix=API_PREFIX)
app.include_router(contact_router, prefix=API_PREFIX)
app.include_router(signaling_router)  # WebSocket — no /api/v1 prefix, uses /ws/meetings/{id}


# ── Background images (CORS-safe route for virtual background feature) ────────
_ALLOWED_BG = {"office", "nature", "library", "abstract", "beach"}

@app.get("/api/v1/bg/{name}", tags=["Meeting UI"])
async def background_image(name: str) -> FileResponse:
    stem = name.removesuffix(".jpg")
    if stem not in _ALLOWED_BG:
        raise HTTPException(status_code=404)
    path = _PUBLIC_DIR / "backgrounds" / f"{stem}.jpg"
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={
            # no-store: prevents CDN/proxy from caching this response.
            # If a CDN caches it once with a specific origin in ACAO it will
            # serve that wrong header to every other origin. Since the files
            # are small JPEGs the browser can cache them locally (private) but
            # no shared cache should ever store them.
            "Cache-Control": "no-store",
        },
    )


# ── Meeting page ──────────────────────────────────────────────────────────────
# Served inside an iframe from the client.
# Token is read from ?token= query param and passed to WebRTCMeetingAPI.

@app.get("/meet/{room_id}", response_class=HTMLResponse, tags=["Meeting UI"])
async def meeting_page(room_id: str) -> HTMLResponse:
    # Never cache the meeting page — it must always load the latest app.js version.
    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="/public/js/app.js?v=4"></script>
  <style>
    html, body, #meeting-container {{ height: 100%; margin: 0; padding: 0; }}
  </style>
</head>
<body>
  <div id="meeting-container"></div>
  <script>
    const params   = new URLSearchParams(window.location.search);
    const token    = params.get("token") || "";
    const roomName = "{room_id}";

    window.onload = () => {{
      new WebRTCMeetingAPI({{
        serverUrl:  window.location.origin.replace("http", "ws"),
        roomName:   roomName,
        token:      token,
        parentNode: document.querySelector("#meeting-container"),
      }});
    }};
  </script>
</body>
</html>"""
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})


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
