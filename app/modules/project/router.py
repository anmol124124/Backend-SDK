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
    CreateMeetingRequest,
    CreateMeetingResponse,
    DomainAddRequest,
    DomainResponse,
    EmbedResponse,
    ProjectCreateRequest,
    ProjectMeetingResponse,
    ProjectResponse,
    SdkJoinResponse,
)
from app.modules.project.service import ProjectService, _make_guest_token
from app.modules.project.embed_check import check_embed_domain
from app.modules.project.models import Project, ProjectMeeting, ProjectMeetingParticipant
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


# ── Public: list meetings for embed HTML (uses embed token) ──────────────────

@router.get("/my-meetings", response_model=list[ProjectMeetingResponse])
async def my_meetings(
    embed_token: str,
    db: AsyncSession = Depends(get_db),
) -> list[ProjectMeetingResponse]:
    from jose import JWTError, jwt as jose_jwt
    from app.core.config import settings as _settings
    import uuid as _uuid
    try:
        token_payload = jose_jwt.decode(
            embed_token, _settings.JWT_SECRET_KEY, algorithms=[_settings.JWT_ALGORITHM]
        )
    except JWTError:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid embed token")
    raw_project_id = token_payload.get("project_id")
    if not raw_project_id or token_payload.get("role") != "host":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Not a host token")
    project_id = _uuid.UUID(raw_project_id)
    public_meet_url = _settings.PUBLIC_MEET_URL.rstrip("/")
    result = await db.execute(
        select(ProjectMeeting)
        .where(ProjectMeeting.project_id == project_id)
        .order_by(ProjectMeeting.created_at.desc())
    )
    meetings = result.scalars().all()
    return [
        ProjectMeetingResponse(
            id=m.id,
            project_id=m.project_id,
            title=m.title,
            room_name=m.room_name,
            host_token=m.host_token,
            share_url=f"{public_meet_url}/sdk/join/{m.room_name}",
            created_at=m.created_at,
        )
        for m in meetings
    ]


# ── Public: create meeting from embed HTML (no auth header — uses embed token) ─

@router.post("/create-meeting", response_model=CreateMeetingResponse)
async def create_meeting_from_embed(
    payload: CreateMeetingRequest,
    db: AsyncSession = Depends(get_db),
) -> CreateMeetingResponse:
    from jose import JWTError, jwt as jose_jwt
    from app.core.config import settings as _settings
    try:
        token_payload = jose_jwt.decode(
            payload.embed_token, _settings.JWT_SECRET_KEY, algorithms=[_settings.JWT_ALGORITHM]
        )
    except JWTError:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid embed token")
    raw_project_id = token_payload.get("project_id")
    if not raw_project_id or token_payload.get("role") != "host":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Not a host token")
    import uuid as _uuid
    project_id = _uuid.UUID(raw_project_id)
    meeting = await ProjectService.create_project_meeting(db, project_id, payload.title)
    public_meet_url = _settings.PUBLIC_MEET_URL.rstrip("/")
    share_url = f"{public_meet_url}/sdk/join/{meeting.room_name}"
    return CreateMeetingResponse(
        room_name=meeting.room_name,
        host_token=meeting.host_token,
        share_url=share_url,
        title=meeting.title,
    )


# ── Public SDK join endpoint (no auth — for guests via public meet) ───────────

@router.get("/sdk-join/{room_name}", response_model=SdkJoinResponse)
async def sdk_join(
    room_name: str,
    db: AsyncSession = Depends(get_db),
) -> SdkJoinResponse:
    # Check project_meetings first (meetings created from embed HTML)
    pm_result = await db.execute(
        select(ProjectMeeting).where(ProjectMeeting.room_name == room_name)
    )
    pm = pm_result.scalar_one_or_none()
    if pm:
        return SdkJoinResponse(
            guest_token=_make_guest_token(pm.project_id),
            room_name=pm.room_name,
            name=pm.title,
        )
    # Fall back to project room_name (legacy)
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


# ── Project analytics (authenticated) ────────────────────────────────────────

@router.get("/{project_id}/analytics")
async def project_analytics(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func
    await ProjectService.get_project(db, project_id, user.id)
    result = await db.execute(
        select(ProjectMeeting)
        .where(ProjectMeeting.project_id == project_id)
        .order_by(ProjectMeeting.created_at.desc())
    )
    meetings = result.scalars().all()

    # Fetch participant counts for all meetings in one query
    room_names = [m.room_name for m in meetings]
    counts_result = await db.execute(
        select(ProjectMeetingParticipant.room_name, func.count().label("cnt"))
        .where(ProjectMeetingParticipant.room_name.in_(room_names))
        .group_by(ProjectMeetingParticipant.room_name)
    )
    participant_counts = {row.room_name: row.cnt for row in counts_result}

    return {
        "total": len(meetings),
        "meetings": [
            {
                "id": str(m.id),
                "title": m.title,
                "room_name": m.room_name,
                "created_at": m.created_at.isoformat(),
                "ended_at": m.ended_at.isoformat() if m.ended_at else None,
                "duration_seconds": int((m.ended_at - m.created_at).total_seconds()) if m.ended_at else None,
                "participant_count": participant_counts.get(m.room_name, 0),
            }
            for m in meetings
        ],
    }


# ── Meeting detail (participants + duration + admin) ─────────────────────────

@router.get("/{project_id}/meetings/{meeting_id}")
async def meeting_detail(
    project_id: UUID,
    meeting_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify ownership
    project = await ProjectService.get_project(db, project_id, user.id)

    # Fetch the meeting
    result = await db.execute(
        select(ProjectMeeting).where(
            ProjectMeeting.id == meeting_id,
            ProjectMeeting.project_id == project_id,
        )
    )
    meeting = result.scalar_one_or_none()
    if not meeting:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Fetch admin (project owner)
    from app.modules.auth.models import User as UserModel
    owner_result = await db.execute(select(UserModel).where(UserModel.id == project.owner_id))
    owner = owner_result.scalar_one_or_none()

    # Fetch participants
    parts_result = await db.execute(
        select(ProjectMeetingParticipant)
        .where(ProjectMeetingParticipant.room_name == meeting.room_name)
        .order_by(ProjectMeetingParticipant.joined_at)
    )
    participants = parts_result.scalars().all()

    # Duration
    duration_seconds = None
    if meeting.ended_at and meeting.created_at:
        duration_seconds = int((meeting.ended_at - meeting.created_at).total_seconds())

    return {
        "id": str(meeting.id),
        "title": meeting.title,
        "room_name": meeting.room_name,
        "created_at": meeting.created_at.isoformat(),
        "ended_at": meeting.ended_at.isoformat() if meeting.ended_at else None,
        "duration_seconds": duration_seconds,
        "admin": {"email": owner.email if owner else "Unknown"},
        "participants": [
            {
                "display_name": p.display_name,
                "role": p.role,
                "joined_at": p.joined_at.isoformat(),
                "left_at": p.left_at.isoformat() if p.left_at else None,
            }
            for p in participants
        ],
    }


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
