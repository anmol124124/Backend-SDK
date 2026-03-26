import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.modules.auth.models import User
from app.modules.project.schemas import (
    DomainAddRequest,
    DomainResponse,
    EmbedResponse,
    ProjectCreateRequest,
    ProjectResponse,
    SdkJoinResponse,
)
from app.modules.project.service import ProjectService, _make_guest_token
from app.modules.project.embed_check import check_embed_domain
from app.modules.project.models import Project
from sqlalchemy import select

router = APIRouter(prefix="/projects", tags=["Projects"], redirect_slashes=False)


@router.post("", status_code=201, response_model=ProjectResponse)
async def create_project(
    payload: ProjectCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    project = await ProjectService.create_project(db, user.id, payload)
    return project


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProjectResponse]:
    return await ProjectService.list_projects(db, user.id)


# ── Public embed domain check (no auth required) ─────────────────────────────

@router.get("/embed-check")
async def embed_check(token: str, request: Request) -> JSONResponse:
    origin = request.headers.get("origin") or request.headers.get("referer", "")
    logger.warning("embed-check origin=%r referer=%r allowed_result=pending", origin, request.headers.get("referer", ""))
    allowed = await check_embed_domain(token, origin)
    logger.warning("embed-check origin=%r allowed=%s", origin, allowed)
    if allowed:
        return JSONResponse({"allowed": True})
    return JSONResponse({"allowed": False}, status_code=403)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    return await ProjectService.get_project(db, project_id, user.id)


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await ProjectService.delete_project(db, project_id, user.id)


@router.get("/{project_id}/embed", response_model=EmbedResponse)
async def get_embed(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EmbedResponse:
    project = await ProjectService.get_project(db, project_id, user.id)
    html = ProjectService.generate_embed_html(project, settings.BACKEND_PUBLIC_URL)
    guest_html = ProjectService.generate_guest_html(project, settings.BACKEND_PUBLIC_URL)
    return EmbedResponse(html=html, guest_html=guest_html, host_token=project.embed_token, room_name=project.room_name)


# ── Public SDK join endpoint (no auth — for guests via public meet) ───────────

@router.get("/sdk-join/{room_name}", response_model=SdkJoinResponse)
async def sdk_join(
    room_name: str,
    db: AsyncSession = Depends(get_db),
) -> SdkJoinResponse:
    result = await db.execute(
        select(Project).where(Project.room_name == room_name)
    )
    project = result.scalar_one_or_none()
    if not project:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Meeting not found")
    return SdkJoinResponse(
        guest_token=_make_guest_token(project.id),
        room_name=project.room_name,
        name=project.name,
    )


# ── Domain allowlist endpoints ────────────────────────────────────────────────

@router.get("/{project_id}/domains", response_model=list[DomainResponse])
async def list_domains(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DomainResponse]:
    return await ProjectService.list_domains(db, project_id, user.id)


@router.post("/{project_id}/domains", status_code=201, response_model=DomainResponse)
async def add_domain(
    project_id: UUID,
    payload: DomainAddRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DomainResponse:
    return await ProjectService.add_domain(db, project_id, user.id, payload)


@router.delete("/{project_id}/domains/{domain_id}", status_code=204)
async def delete_domain(
    project_id: UUID,
    domain_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await ProjectService.delete_domain(db, project_id, domain_id, user.id)
