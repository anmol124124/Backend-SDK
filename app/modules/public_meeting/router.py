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
    return await service.create_meeting(
        name=payload.name,
        db=db,
        user_id=current_user.id if current_user else None,
    )


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
