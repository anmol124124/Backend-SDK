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
      *{{box-sizing:border-box;margin:0;padding:0}}
      html,body,#meeting-container{{height:100%}}
      body{{background:#1a1c22;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8eaed}}
      #wrtc-pre{{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;padding:40px 16px;overflow-y:auto}}
      .wrtc-header{{text-align:center;margin-bottom:32px}}
      .wrtc-header h2{{font-size:26px;font-weight:700;color:#e8eaed}}
      .wrtc-header p{{color:#9aa0a6;font-size:14px;margin-top:6px}}
      .wrtc-card{{background:#25262b;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;width:100%;max-width:560px;margin-bottom:16px}}
      .wrtc-card h3{{font-size:14px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:.06em;margin-bottom:16px}}
      .wrtc-input{{background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#e8eaed;font-size:15px;width:100%;outline:none}}
      .wrtc-input::placeholder{{color:#5f6368}}
      .wrtc-input:focus{{border-color:#1a73e8}}
      .wrtc-btn-primary{{background:linear-gradient(90deg,#1a73e8,#4d94ff);color:#fff;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-top:12px;transition:opacity .15s}}
      .wrtc-btn-primary:disabled{{opacity:.5;cursor:not-allowed}}
      .wrtc-err{{color:#ea4335;font-size:13px;margin-top:8px;display:none}}
      .wrtc-meeting-row{{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}}
      .wrtc-meeting-row:last-child{{border-bottom:none}}
      .wrtc-meeting-title{{font-size:15px;font-weight:500;color:#e8eaed}}
      .wrtc-meeting-date{{font-size:12px;color:#9aa0a6;margin-top:2px}}
      .wrtc-btn-join{{background:#1a73e8;color:#fff;border:none;border-radius:8px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}}
      .wrtc-empty{{color:#9aa0a6;font-size:14px;text-align:center;padding:8px 0}}
      .wrtc-spinner{{width:32px;height:32px;border:3px solid rgba(255,255,255,.1);border-top-color:#1a73e8;border-radius:50%;animation:spin .8s linear infinite;margin:8px auto}}
      @keyframes spin{{to{{transform:rotate(360deg)}}}}
    </style>
  </head>
  <body>
    <div id="meeting-container"></div>
    <div id="wrtc-pre">
      <div class="wrtc-header">
        <h2>{project.name}</h2>
        <p>Create a new meeting or join a previous one</p>
      </div>

      <!-- Create new meeting -->
      <div class="wrtc-card">
        <h3>New Meeting</h3>
        <input id="wrtc-title-input" class="wrtc-input" type="text" placeholder="Enter meeting title…" maxlength="255" />
        <div id="wrtc-err" class="wrtc-err"></div>
        <button id="wrtc-create-btn" class="wrtc-btn-primary">Create &amp; Start</button>
      </div>

      <!-- Past meetings -->
      <div class="wrtc-card">
        <h3>Previous Meetings</h3>
        <div id="wrtc-meetings-list"><div class="wrtc-spinner"></div></div>
      </div>
    </div>

    <script>
      window.onload = function() {{
        var BACKEND = '{backend_url}';
        var EMBED_TOKEN = '{project.embed_token}';

        function startMeeting(roomName, hostToken, shareUrl) {{
          document.getElementById('wrtc-pre').style.display = 'none';
          var mc = document.getElementById('meeting-container');
          mc.style.position = 'fixed'; mc.style.inset = '0';
          new WebRTCMeetingAPI({{
            roomName: roomName, token: hostToken, shareUrl: shareUrl,
            parentNode: mc,
          }});
        }}

        function fmtDate(iso) {{
          return new Date(iso).toLocaleString(undefined, {{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}});
        }}

        // Load past meetings
        fetch(BACKEND + '/api/v1/projects/my-meetings?embed_token=' + encodeURIComponent(EMBED_TOKEN))
          .then(function(r) {{ return r.json(); }})
          .then(function(list) {{
            var el = document.getElementById('wrtc-meetings-list');
            if (!list.length) {{
              el.innerHTML = '<p class="wrtc-empty">No meetings yet.</p>';
              return;
            }}
            el.innerHTML = list.map(function(m) {{
              return '<div class="wrtc-meeting-row">' +
                '<div><div class="wrtc-meeting-title">' + m.title + '</div>' +
                '<div class="wrtc-meeting-date">' + fmtDate(m.created_at) + '</div></div>' +
                '<button class="wrtc-btn-join" data-room="' + m.room_name + '" data-token="' + m.host_token + '" data-share="' + m.share_url + '">Join</button>' +
              '</div>';
            }}).join('');
            el.querySelectorAll('.wrtc-btn-join').forEach(function(btn) {{
              btn.addEventListener('click', function() {{
                startMeeting(this.dataset.room, this.dataset.token, this.dataset.share);
              }});
            }});
          }})
          .catch(function() {{
            document.getElementById('wrtc-meetings-list').innerHTML = '<p class="wrtc-empty">Could not load meetings.</p>';
          }});

        // Create new meeting
        var createBtn = document.getElementById('wrtc-create-btn');
        var titleInp  = document.getElementById('wrtc-title-input');
        var errEl     = document.getElementById('wrtc-err');

        createBtn.onclick = function() {{
          var title = titleInp.value.trim();
          if (!title) {{ titleInp.focus(); return; }}
          createBtn.disabled = true; createBtn.textContent = 'Creating…';
          errEl.style.display = 'none';
          fetch(BACKEND + '/api/v1/projects/create-meeting', {{
            method: 'POST',
            headers: {{'Content-Type': 'application/json'}},
            body: JSON.stringify({{embed_token: EMBED_TOKEN, title: title}})
          }})
          .then(function(r) {{ return r.ok ? r.json() : r.json().then(function(e) {{ throw new Error(e.detail || 'Failed'); }}); }})
          .then(function(data) {{ startMeeting(data.room_name, data.host_token, data.share_url); }})
          .catch(function(e) {{
            errEl.textContent = e.message; errEl.style.display = 'block';
            createBtn.disabled = false; createBtn.textContent = 'Create & Start';
          }});
        }};
        titleInp.addEventListener('keydown', function(e) {{ if (e.key === 'Enter') createBtn.click(); }});
      }};
    </script>
  </body>
</html>"""

    @staticmethod
    def generate_guest_html(project: Project, backend_url: str) -> str:
        """Kept for backward compat — returns same combined HTML."""
        return ProjectService.generate_embed_html(project, backend_url)
