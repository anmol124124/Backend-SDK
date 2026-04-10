import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, Request, UploadFile
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
    EmbedScheduleInviteRequest,
    ProjectCreateRequest,
    ProjectMeetingResponse,
    ProjectResponse,
    ScheduleInviteRequest,
    SdkJoinResponse,
)
from app.modules.project.service import ProjectService, _make_guest_token
from app.modules.project.embed_check import check_embed_domain
from app.modules.project.models import Project, ProjectMeeting, ProjectMeetingParticipant, ProjectRecording
from sqlalchemy import select

_PUBLIC_DIR = Path(__file__).parent.parent.parent.parent / "public"

router = APIRouter(prefix="/projects", tags=["Projects"], redirect_slashes=False)


@router.post("", status_code=201, response_model=ProjectResponse)
async def create_project(
    payload: ProjectCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    from fastapi import HTTPException
    from app.modules.project.mau import PLAN_PROJECT_LIMITS

    limit = PLAN_PROJECT_LIMITS.get(user.plan, 1)
    if limit is not None:
        count_result = await db.execute(
            select(Project).where(Project.owner_id == user.id)
        )
        existing = count_result.scalars().all()
        if len(existing) >= limit:
            plan_label = user.plan or "basic"
            raise HTTPException(
                status_code=403,
                detail=f"Project limit reached ({len(existing)}/{limit} on {plan_label} plan). Upgrade to Premium to create unlimited projects.",
            )

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
            scheduled_at=m.scheduled_at,
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
    from fastapi import HTTPException
    from app.modules.public_meeting.models import PublicMeeting
    from app.core.rsa_tokens import create_guest_token

    # 1. Check project_meetings (embed HTML meetings)
    pm_result = await db.execute(
        select(ProjectMeeting).where(ProjectMeeting.room_name == room_name)
    )
    pm = pm_result.scalar_one_or_none()
    if pm:
        proj_result = await db.execute(select(Project).where(Project.id == pm.project_id))
        proj = proj_result.scalar_one_or_none()
        return SdkJoinResponse(
            guest_token=_make_guest_token(pm.project_id),
            room_name=pm.room_name,
            name=pm.title,
            logo_url=proj.logo_url if proj else None,
        )

    # 2. Check public_meetings (public-meet dashboard meetings)
    pub_result = await db.execute(
        select(PublicMeeting).where(PublicMeeting.room_code == room_name)
    )
    pub = pub_result.scalar_one_or_none()
    if pub:
        if not pub.is_active:
            raise HTTPException(status_code=410, detail="This meeting has ended")
        guest_token = create_guest_token(name="Guest", room_code=pub.room_code)
        return SdkJoinResponse(
            guest_token=guest_token,
            room_name=pub.room_code,
            name=pub.name,
            logo_url=None,
        )

    # 3. Fall back to project room_name (legacy)
    result = await db.execute(
        select(Project).where(Project.room_name == room_name)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return SdkJoinResponse(
        guest_token=_make_guest_token(project.id),
        room_name=project.room_name,
        name=project.name,
        logo_url=project.logo_url,
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
    logo_url = f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{project.logo_url}" if project.logo_url else None
    return EmbedResponse(html=html, guest_html=guest_html, host_token=project.embed_token, room_name=project.room_name, logo_url=logo_url)


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

    # Fetch participant counts and first-join times for all meetings in one query
    room_names = [m.room_name for m in meetings]
    counts_result = await db.execute(
        select(
            ProjectMeetingParticipant.room_name,
            func.count().label("cnt"),
            func.min(ProjectMeetingParticipant.joined_at).label("first_join"),
        )
        .where(ProjectMeetingParticipant.room_name.in_(room_names))
        .group_by(ProjectMeetingParticipant.room_name)
    )
    participant_info = {row.room_name: row for row in counts_result}

    def _duration(m):
        if not m.ended_at:
            return None
        info = participant_info.get(m.room_name)
        start = info.first_join if info else m.created_at
        return max(0, int((m.ended_at - start).total_seconds()))

    return {
        "total": len(meetings),
        "meetings": [
            {
                "id": str(m.id),
                "title": m.title,
                "room_name": m.room_name,
                "created_at": m.created_at.isoformat(),
                "ended_at": m.ended_at.isoformat() if m.ended_at else None,
                "scheduled_at": m.scheduled_at.isoformat() if m.scheduled_at else None,
                "started_at": participant_info[m.room_name].first_join.isoformat()
                              if m.room_name in participant_info else None,
                "duration_seconds": _duration(m),
                "participant_count": participant_info[m.room_name].cnt
                                     if m.room_name in participant_info else 0,
            }
            for m in meetings
        ],
    }


# ── MAU stats (authenticated) ────────────────────────────────────────────────

@router.get("/{project_id}/mau")
async def project_mau_stats(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.modules.project.mau import get_mau_stats
    await ProjectService.get_project(db, project_id, user.id)
    return await get_mau_stats(str(project_id), user.plan)


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

    # Duration: from first participant join to ended_at (not created_at)
    first_join = participants[0].joined_at if participants else None
    duration_seconds = None
    if meeting.ended_at and first_join:
        duration_seconds = max(0, int((meeting.ended_at - first_join).total_seconds()))

    return {
        "id": str(meeting.id),
        "title": meeting.title,
        "room_name": meeting.room_name,
        "created_at": meeting.created_at.isoformat(),
        "started_at": first_join.isoformat() if first_join else None,
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


# ── Recording upload (public — uses embed token) ──────────────────────────────

@router.post("/recordings/upload")
async def upload_recording(
    embed_token: str,
    room_name: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    from jose import JWTError, jwt as jose_jwt
    from app.core.config import settings as _settings
    import uuid as _uuid_mod
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
    project_id = _uuid_mod.UUID(raw_project_id)

    recordings_dir = _PUBLIC_DIR / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(file.filename).suffix if file.filename else ".webm"
    if not ext:
        ext = ".webm"
    filename = f"{_uuid_mod.uuid4()}{ext}"
    file_path = recordings_dir / filename

    content = await file.read()
    file_path.write_bytes(content)

    url = f"{_settings.BACKEND_PUBLIC_URL}/public/recordings/{filename}"

    recording = ProjectRecording(
        id=_uuid_mod.uuid4(),
        project_id=project_id,
        room_name=room_name,
        filename=filename,
        url=url,
        file_size=len(content),
    )
    db.add(recording)
    await db.commit()
    await db.refresh(recording)

    return {
        "id": str(recording.id),
        "filename": recording.filename,
        "url": recording.url,
        "file_size": recording.file_size,
        "room_name": recording.room_name,
        "created_at": recording.created_at.isoformat(),
    }


# ── List recordings (authenticated) ──────────────────────────────────────────

@router.get("/{project_id}/recordings")
async def list_recordings(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await ProjectService.get_project(db, project_id, user.id)
    result = await db.execute(
        select(ProjectRecording)
        .where(ProjectRecording.project_id == project_id)
        .order_by(ProjectRecording.created_at.desc())
    )
    recordings = result.scalars().all()
    return [
        {
            "id": str(r.id),
            "room_name": r.room_name,
            "filename": r.filename,
            "url": r.url,
            "file_size": r.file_size,
            "created_at": r.created_at.isoformat(),
        }
        for r in recordings
    ]


# ── Activity feed (authenticated) ─────────────────────────────────────────────

@router.get("/{project_id}/activity")
async def project_activity(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await ProjectService.get_project(db, project_id, user.id)

    meetings_result = await db.execute(
        select(ProjectMeeting)
        .where(ProjectMeeting.project_id == project_id)
        .order_by(ProjectMeeting.created_at.desc())
        .limit(50)
    )
    meetings = meetings_result.scalars().all()

    room_names = [m.room_name for m in meetings]
    meeting_map = {m.room_name: m for m in meetings}

    parts_result = await db.execute(
        select(ProjectMeetingParticipant)
        .where(ProjectMeetingParticipant.room_name.in_(room_names))
        .order_by(ProjectMeetingParticipant.joined_at.desc())
    )
    participants = parts_result.scalars().all()

    events = []
    for m in meetings:
        events.append({
            "type": "meeting_started",
            "title": m.title,
            "room_name": m.room_name,
            "timestamp": m.created_at.isoformat(),
        })
        if m.ended_at:
            events.append({
                "type": "meeting_ended",
                "title": m.title,
                "room_name": m.room_name,
                "timestamp": m.ended_at.isoformat(),
            })

    for p in participants:
        m = meeting_map.get(p.room_name)
        events.append({
            "type": "participant_joined",
            "display_name": p.display_name,
            "role": p.role,
            "room_name": p.room_name,
            "meeting_title": m.title if m else p.room_name,
            "timestamp": p.joined_at.isoformat(),
        })
        if p.left_at:
            events.append({
                "type": "participant_left",
                "display_name": p.display_name,
                "role": p.role,
                "room_name": p.room_name,
                "meeting_title": m.title if m else p.room_name,
                "timestamp": p.left_at.isoformat(),
            })

    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return {"events": events[:100]}


# ── Logo upload ───────────────────────────────────────────────────────────────

_LOGOS_DIR = _PUBLIC_DIR / "logos"
_ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
_MAX_LOGO_BYTES = 3 * 1024 * 1024  # 3 MB


@router.post("/{project_id}/logo")
async def upload_logo(
    project_id: UUID,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from fastapi import HTTPException
    import uuid as _uuid_mod

    project = await ProjectService.get_project(db, project_id, user.id)

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only PNG, JPG, GIF, WebP, or SVG images are allowed.")

    content = await file.read()
    if len(content) > _MAX_LOGO_BYTES:
        raise HTTPException(status_code=400, detail="Logo must be under 3 MB.")

    _LOGOS_DIR.mkdir(parents=True, exist_ok=True)

    # Remove old logo file if one exists
    if project.logo_url:
        old_filename = project.logo_url.rstrip("/").split("/")[-1]
        old_path = _LOGOS_DIR / old_filename
        if old_path.exists():
            old_path.unlink()

    ext = Path(file.filename).suffix if file.filename else ".png"
    if not ext or ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        ext = ".png"
    filename = f"{project_id}{ext}"
    file_path = _LOGOS_DIR / filename
    file_path.write_bytes(content)

    from app.core.config import settings as _settings
    relative_path = f"/public/logos/{filename}"
    project.logo_url = relative_path
    await db.commit()
    await db.refresh(project)

    logo_url = f"{_settings.BACKEND_PUBLIC_URL.rstrip('/')}{relative_path}"
    return {"logo_url": logo_url}


@router.post("/embed-schedule-invite")
async def embed_schedule_invite(
    payload: EmbedScheduleInviteRequest,
    db: AsyncSession = Depends(get_db),
):
    """Send scheduled meeting invitation emails using an embed token (no dashboard auth needed)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    import asyncio
    from jose import JWTError, jwt as jose_jwt
    from fastapi import HTTPException
    from app.modules.public_meeting.service import _send_invites_smtp
    import uuid as _uuid

    if not payload.invitees:
        raise HTTPException(status_code=400, detail="At least one invitee email is required")

    # Decode embed_token to get project_id
    try:
        token_payload = jose_jwt.decode(
            payload.embed_token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid embed token")

    raw_project_id = token_payload.get("project_id")
    if not raw_project_id or token_payload.get("role") != "host":
        raise HTTPException(status_code=403, detail="Not a host token")

    project_id = _uuid.UUID(raw_project_id)
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        tz = ZoneInfo(payload.timezone)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
        payload.timezone = "UTC"

    naive_dt = datetime.fromisoformat(payload.scheduled_at)
    scheduled_at_local = naive_dt.replace(tzinfo=tz)
    # Create a ProjectMeeting record for the scheduled meeting so it appears in the list
    scheduled_meeting = await ProjectService.create_project_meeting(
        db, project_id, payload.meeting_title
    )
    # Set scheduled_at on the just-created meeting
    scheduled_meeting.scheduled_at = scheduled_at_local
    await db.commit()
    await db.refresh(scheduled_meeting)

    join_url = f"{settings.PUBLIC_MEET_URL}/sdk/join/{scheduled_meeting.room_name}"

    try:
        await asyncio.to_thread(
            _send_invites_smtp,
            payload.invitees,
            payload.meeting_title,
            join_url,
            scheduled_at_local,
            payload.timezone,
        )
        logger.info(
            "Embed schedule invites sent  project_id=%s  room=%s  recipients=%d",
            project_id, scheduled_meeting.room_name, len(payload.invitees),
        )
    except Exception as exc:
        logger.warning("Embed schedule invite SMTP error  project_id=%s  error=%s", project_id, exc)
        raise HTTPException(status_code=500, detail=f"Failed to send invites: {exc}")

    return {"ok": True, "sent": len(payload.invitees)}


@router.post("/{project_id}/schedule-invite")
async def schedule_meeting_invite(
    project_id: UUID,
    payload: ScheduleInviteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send scheduled meeting invitation emails for a project room."""
    from datetime import datetime
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    import asyncio
    from app.modules.public_meeting.service import _send_invites_smtp

    project = await ProjectService.get_project(db, project_id, user.id)

    if not payload.invitees:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="At least one invitee email is required")

    try:
        tz = ZoneInfo(payload.timezone)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
        payload.timezone = "UTC"

    naive_dt = datetime.fromisoformat(payload.scheduled_at)
    scheduled_at_local = naive_dt.replace(tzinfo=tz)

    join_url = f"{settings.PUBLIC_MEET_URL}/sdk/{project.room_name}"

    try:
        await asyncio.to_thread(
            _send_invites_smtp,
            payload.invitees,
            payload.meeting_title,
            join_url,
            scheduled_at_local,
            payload.timezone,
        )
        logger.info(
            "Project schedule invites sent  project_id=%s  room=%s  recipients=%d",
            project_id, project.room_name, len(payload.invitees),
        )
    except Exception as exc:
        logger.warning("Project schedule invite SMTP error  project_id=%s  error=%s", project_id, exc)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Failed to send invites: {exc}")

    return {"ok": True, "sent": len(payload.invitees)}


@router.delete("/{project_id}/logo")
async def delete_logo(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await ProjectService.get_project(db, project_id, user.id)

    if project.logo_url:
        old_filename = project.logo_url.rstrip("/").split("/")[-1]
        old_path = _LOGOS_DIR / old_filename
        if old_path.exists():
            old_path.unlink()
        project.logo_url = None
        await db.commit()

    return {"ok": True}
