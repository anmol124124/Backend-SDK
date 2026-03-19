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
from app.modules.project.models import Project, ProjectDomain
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
        "jti": str(uuid.uuid4()),
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
    def generate_embed_html(project: Project, backend_url: str) -> str:
        backend_url = backend_url.rstrip("/")
        ws_url = backend_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"""<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{project.name}</title>
    <script src="{backend_url}/public/js/app.js?ngrok-skip-browser-warning=true" defer></script>
    <style>html, body, #meeting-container {{ height: 100%; margin: 0; padding: 0; }}</style>
  </head>
  <body>
    <div id="meeting-container"></div>
    <script>
      window.onload = () => {{
        new WebRTCMeetingAPI({{
          roomName:   "{project.room_name}",
          token:      "{project.embed_token}",
          parentNode: document.querySelector('#meeting-container'),
        }});
      }};
    </script>
  </body>
</html>"""
