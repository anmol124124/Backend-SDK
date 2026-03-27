import re
import uuid
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import HTTPException
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dynamic_cors import invalidate_cors_cache
from app.modules.project.models import Project, ProjectDomain, ProjectMeeting
from app.modules.project.schemas import DomainAddRequest, ProjectCreateRequest


def _normalize_domain(domain: str) -> str:
    """Strip scheme and trailing slashes — store only the hostname."""
    d = domain.lower().strip()
    d = re.sub(r'^https?://', '', d)
    d = d.split('/')[0]  # remove any path
    return d


def _make_room_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
    return f"{slug}-{str(uuid.uuid4())[:8]}"


def _make_embed_token(user_id: UUID, project_id: UUID) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=365 * 100)
    payload = {
        "sub": str(user_id),
        "exp": expire,
        "type": "access",
        "role": "host",
        "jti": str(uuid.uuid4()),
        "project_id": str(project_id),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def _make_guest_token(project_id: UUID) -> str:
    """Deterministic guest token for a project — no DB storage needed."""
    expire = datetime.now(timezone.utc) + timedelta(days=365 * 100)
    # Use a fixed sub derived from project_id so the token is deterministic.
    # Each WS connection gets a random suffix from the websocket handler anyway.
    sub = str(uuid.uuid5(uuid.NAMESPACE_URL, f"guest:{project_id}"))
    payload = {
        "sub": sub,
        "exp": expire,
        "type": "access",
        "role": "guest",
        "project_id": str(project_id),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


class ProjectService:

    @staticmethod
    async def create_project(
        db: AsyncSession, owner_id: UUID, payload: ProjectCreateRequest
    ) -> Project:
        project_id = uuid.uuid4()
        project = Project(
            id=project_id,
            name=payload.name,
            owner_id=owner_id,
            room_name=_make_room_name(payload.name),
            embed_token=_make_embed_token(owner_id, project_id),
        )
        db.add(project)
        await db.flush()
        # Save the domain provided at creation time
        domain = ProjectDomain(
            project_id=project_id,
            domain=_normalize_domain(payload.domain),
        )
        db.add(domain)
        await db.refresh(project)
        invalidate_cors_cache()
        return project

    @staticmethod
    async def list_projects(db: AsyncSession, owner_id: UUID) -> list[Project]:
        result = await db.execute(
            select(Project)
            .where(Project.owner_id == owner_id)
            .order_by(Project.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_project(
        db: AsyncSession, project_id: UUID, owner_id: UUID
    ) -> Project:
        result = await db.execute(
            select(Project).where(
                Project.id == project_id, Project.owner_id == owner_id
            )
        )
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        return project

    @staticmethod
    async def delete_project(
        db: AsyncSession, project_id: UUID, owner_id: UUID
    ) -> None:
        project = await ProjectService.get_project(db, project_id, owner_id)
        await db.delete(project)

    # ── Domain allowlist ──────────────────────────────────────────────────────

    @staticmethod
    async def list_domains(
        db: AsyncSession, project_id: UUID, owner_id: UUID
    ) -> list[ProjectDomain]:
        await ProjectService.get_project(db, project_id, owner_id)
        result = await db.execute(
            select(ProjectDomain)
            .where(ProjectDomain.project_id == project_id)
            .order_by(ProjectDomain.created_at)
        )
        return list(result.scalars().all())

    @staticmethod
    async def add_domain(
        db: AsyncSession, project_id: UUID, owner_id: UUID, payload: DomainAddRequest
    ) -> ProjectDomain:
        await ProjectService.get_project(db, project_id, owner_id)
        domain = ProjectDomain(project_id=project_id, domain=_normalize_domain(payload.domain))
        db.add(domain)
        await db.flush()
        await db.refresh(domain)
        invalidate_cors_cache()
        return domain

    @staticmethod
    async def delete_domain(
        db: AsyncSession, project_id: UUID, domain_id: UUID, owner_id: UUID
    ) -> None:
        await ProjectService.get_project(db, project_id, owner_id)
        result = await db.execute(
            select(ProjectDomain).where(
                ProjectDomain.id == domain_id,
                ProjectDomain.project_id == project_id,
            )
        )
        domain = result.scalar_one_or_none()
        if not domain:
            raise HTTPException(status_code=404, detail="Domain not found")
        await db.delete(domain)
        invalidate_cors_cache()

    @staticmethod
    async def create_project_meeting(
        db: AsyncSession, project_id: UUID, title: str
    ) -> ProjectMeeting:
        room_name = _make_room_name(title)
        # host_token for this meeting uses project owner's id from the project
        result = await db.execute(select(Project).where(Project.id == project_id))
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        host_token = _make_embed_token(project.owner_id, project_id)
        meeting = ProjectMeeting(
            project_id=project_id,
            title=title,
            room_name=room_name,
            host_token=host_token,
        )
        db.add(meeting)
        await db.flush()
        await db.refresh(meeting)
        return meeting

    @staticmethod
    def generate_embed_html(project: Project, backend_url: str) -> str:
        """
        Combined embed HTML — embeds both host and guest tokens.
        URL param ?role=host  → host token (direct join, can admit guests).
        No param / anything else → guest token (knock-to-join, waits for approval).
        """
        backend_url = backend_url.rstrip("/")
        public_meet_url = settings.PUBLIC_MEET_URL.rstrip("/")
        return f"""<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{project.name}</title>
    <script src="{backend_url}/public/js/app.js?ngrok-skip-browser-warning=true" async></script>
    <style>
      html, body, #meeting-container {{ height: 100%; margin: 0; padding: 0; }}
      #wrtc-pre {{
        position: fixed; inset: 0;
        background: linear-gradient(160deg, #1a1c22, #202124);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }}
      #wrtc-pre h2 {{ color: #e8eaed; font-size: 24px; font-weight: 700; margin: 0; }}
      #wrtc-pre p {{ color: #9aa0a6; font-size: 14px; margin: 0; }}
      #wrtc-title-input {{
        background: rgba(255,255,255,.07); border: 1.5px solid rgba(255,255,255,.15);
        border-radius: 10px; padding: 13px 16px; color: #e8eaed; font-size: 15px;
        width: 320px; outline: none; box-sizing: border-box;
      }}
      #wrtc-title-input::placeholder {{ color: #5f6368; }}
      #wrtc-create-btn {{
        background: linear-gradient(90deg, #1a73e8, #4d94ff);
        color: #fff; border: none; border-radius: 12px;
        padding: 14px 36px; font-size: 16px; font-weight: 600;
        cursor: pointer; box-shadow: 0 4px 16px rgba(26,115,232,.4);
        transition: transform .15s, box-shadow .15s; width: 320px;
      }}
      #wrtc-create-btn:disabled {{ opacity: 0.5; cursor: not-allowed; transform: none; }}
      #wrtc-create-btn:hover:not(:disabled) {{ transform: translateY(-2px); box-shadow: 0 6px 20px rgba(26,115,232,.5); }}
      #wrtc-err {{ color: #ea4335; font-size: 13px; display: none; }}
    </style>
  </head>
  <body>
    <div id="meeting-container"></div>
    <div id="wrtc-pre">
      <div style="text-align:center">
        <h2>{project.name}</h2>
        <p>Enter a title and start your meeting</p>
      </div>
      <input id="wrtc-title-input" type="text" placeholder="Meeting title (e.g. Weekly Standup)" maxlength="255" />
      <div id="wrtc-err"></div>
      <button id="wrtc-create-btn">Create Meeting</button>
    </div>
    <script>
      window.onload = function() {{
        var BACKEND = '{backend_url}';
        var PUBLIC_MEET = '{public_meet_url}';
        var EMBED_TOKEN = '{project.embed_token}';
        var PROJECT_ID = '{project.id}';

        var btn = document.getElementById('wrtc-create-btn');
        var inp = document.getElementById('wrtc-title-input');
        var err = document.getElementById('wrtc-err');

        btn.onclick = function() {{
          var title = inp.value.trim();
          if (!title) {{ inp.focus(); return; }}
          btn.disabled = true;
          btn.textContent = 'Creating…';
          err.style.display = 'none';

          fetch(BACKEND + '/api/v1/projects/create-meeting', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{embed_token: EMBED_TOKEN, title: title}})
          }})
          .then(function(r) {{ return r.ok ? r.json() : r.json().then(function(e) {{ throw new Error(e.detail || 'Failed'); }}); }})
          .then(function(data) {{
            document.getElementById('wrtc-pre').style.display = 'none';
            document.getElementById('meeting-container').style.position = 'fixed';
            document.getElementById('meeting-container').style.inset = '0';
            new WebRTCMeetingAPI({{
              roomName:   data.room_name,
              token:      data.host_token,
              shareUrl:   data.share_url,
              parentNode: document.querySelector('#meeting-container'),
            }});
          }})
          .catch(function(e) {{
            err.textContent = e.message;
            err.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Create Meeting';
          }});
        }};

        inp.addEventListener('keydown', function(e) {{ if (e.key === 'Enter') btn.click(); }});
      }};
    </script>
  </body>
</html>"""

    @staticmethod
    def generate_guest_html(project: Project, backend_url: str) -> str:
        """Kept for backward compat — returns same combined HTML."""
        return ProjectService.generate_embed_html(project, backend_url)
