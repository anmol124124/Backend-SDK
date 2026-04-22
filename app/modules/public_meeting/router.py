from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user, get_optional_user
from app.modules.auth.models import User
from app.modules.public_meeting import service
from app.modules.public_meeting.schemas import (
    CreateMeetingRequest,
    CreateMeetingResponse,
    GuestTokenRequest,
    MeetingInfoResponse,
    MeetingListItem,
    TokenResponse,
)

router = APIRouter(prefix="/public/meetings", tags=["Public Meet"])


@router.get("", response_model=list[MeetingListItem])
async def list_meetings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MeetingListItem]:
    """List all meetings created by the authenticated user."""
    return await service.list_user_meetings(user_id=current_user.id, db=db)


@router.post("", response_model=CreateMeetingResponse, status_code=201)
async def create_meeting(
    payload: CreateMeetingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
) -> CreateMeetingResponse:
    """
    Create a new public meeting room. Auth optional — if logged in, meeting is saved to your list.
    Returns the room code and shareable URL.
    """
    # Convert the raw "YYYY-MM-DDTHH:MM:SS" string in the user's chosen timezone to UTC
    scheduled_at_utc = None
    if payload.scheduled_at:
        try:
            tz = ZoneInfo(payload.timezone)
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("UTC")
        naive_dt = datetime.fromisoformat(payload.scheduled_at)
        scheduled_at_utc = naive_dt.replace(tzinfo=tz)

    return await service.create_meeting(
        name=payload.name,
        db=db,
        user_id=current_user.id if current_user else None,
        perms=payload.settings,
        scheduled_at=scheduled_at_utc,
        timezone=payload.timezone,
        invitees=payload.invitees,
    )


# ── Public Recordings (must be before /{room_code} to avoid route shadowing) ──

import uuid as _uuid
from fastapi import UploadFile, File, Query, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select as _select
from app.modules.project.models import PublicRecording
from app.core.gcs import upload_to_gcs
from app.core.config import settings as _cfg
import os, pathlib, datetime as _dt


class PublicRecordingItem(BaseModel):
    id: _uuid.UUID
    room_code: str
    filename: str
    url: str
    file_size: int | None
    created_at: _dt.datetime

    model_config = {"from_attributes": True}


@router.post("/recordings/upload", response_model=PublicRecordingItem, tags=["Public Recordings"])
async def upload_public_recording(
    room_code: str = Query(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = await file.read()
    filename = file.filename or f"recording-{_uuid.uuid4()}.webm"

    if getattr(_cfg, "GCS_ENABLED", False):
        blob_name = f"public-recordings/{current_user.id}/{filename}"
        url = await upload_to_gcs(data, blob_name, file.content_type or "video/webm")
    else:
        save_dir = pathlib.Path("/app/public/recordings/public")
        save_dir.mkdir(parents=True, exist_ok=True)
        save_path = save_dir / filename
        save_path.write_bytes(data)
        url = f"/public/recordings/public/{filename}"

    rec = PublicRecording(
        user_id=current_user.id,
        room_code=room_code,
        filename=filename,
        url=url,
        file_size=len(data),
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return rec


@router.get("/recordings", response_model=list[PublicRecordingItem], tags=["Public Recordings"])
async def list_public_recordings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        _select(PublicRecording)
        .where(PublicRecording.user_id == current_user.id)
        .order_by(PublicRecording.created_at.desc())
    )
    return result.scalars().all()


# ── Meeting Summary (participants) ────────────────────────────────────────────

import datetime as _dt_mod
from app.modules.public_meeting.models import PublicMeetingParticipant


class PublicParticipantItem(BaseModel):
    id: _uuid.UUID
    display_name: str
    role: str
    joined_at: _dt_mod.datetime
    left_at: _dt_mod.datetime | None
    duration_seconds: int | None

    model_config = {"from_attributes": True}


class MeetingSummaryResponse(BaseModel):
    room_code: str
    name: str
    is_active: bool
    created_at: _dt_mod.datetime | None
    scheduled_at: _dt_mod.datetime | None
    participants: list[PublicParticipantItem]


@router.get("/summary/{room_code}", response_model=MeetingSummaryResponse, tags=["Public Meet"])
async def get_meeting_summary(
    room_code: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select as _sel
    from app.modules.public_meeting.models import PublicMeeting
    mtg = (await db.execute(
        _sel(PublicMeeting).where(
            PublicMeeting.room_code == room_code,
            PublicMeeting.created_by == current_user.id,
        )
    )).scalar_one_or_none()
    if not mtg:
        raise HTTPException(status_code=404, detail="Meeting not found")

    parts = (await db.execute(
        _sel(PublicMeetingParticipant)
        .where(PublicMeetingParticipant.room_code == room_code)
        .order_by(PublicMeetingParticipant.joined_at.asc())
    )).scalars().all()

    return MeetingSummaryResponse(
        room_code=mtg.room_code,
        name=mtg.name,
        is_active=mtg.is_active,
        created_at=mtg.created_at,
        scheduled_at=mtg.scheduled_at,
        participants=parts,
    )


# ── Parametric routes (must come after static routes above) ───────────────────

@router.get("/{room_code}", response_model=MeetingInfoResponse)
async def get_meeting(
    room_code: str,
    db: AsyncSession = Depends(get_db),
) -> MeetingInfoResponse:
    """Get public meeting info by room code. No auth required."""
    return await service.get_meeting(room_code=room_code, db=db)


@router.post("/{room_code}/host-token", response_model=TokenResponse)
async def host_token(
    room_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TokenResponse:
    """
    Get an RS256-signed host token. Requires login.
    The host uses this token to join the WebSocket.
    """
    return await service.get_host_token(
        room_code=room_code,
        user_id=str(current_user.id),
        user_name=current_user.email.split("@")[0],
        db=db,
    )


@router.post("/{room_code}/guest-token", response_model=TokenResponse)
async def guest_token(
    room_code: str,
    payload: GuestTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """
    Get an RS256-signed guest token. No auth required — just a display name.
    The guest uses this token to join the WebSocket.
    """
    return await service.get_guest_token(
        room_code=room_code,
        name=payload.name,
        db=db,
    )
