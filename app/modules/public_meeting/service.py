"""
Public meeting service.

Room code format: "abc-defg-hij"  (3-4-3 lowercase letters, like Google Meet)
e.g. zfv-nidu-hjd
"""

import random
import string
import uuid as _uuid
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rsa_tokens import create_guest_token, create_host_token
from app.modules.public_meeting.models import PublicMeeting
from app.modules.public_meeting.schemas import (
    CreateMeetingResponse,
    MeetingInfoResponse,
    MeetingListItem,
    TokenResponse,
)


def _generate_room_code() -> str:
    """Generate a Google-Meet-style room code: 'abc-defg-hij'"""
    chars = string.ascii_lowercase
    part1 = "".join(random.choices(chars, k=3))
    part2 = "".join(random.choices(chars, k=4))
    part3 = "".join(random.choices(chars, k=3))
    return f"{part1}-{part2}-{part3}"


async def create_meeting(
    name: str,
    db: AsyncSession,
    user_id: Optional[_uuid.UUID] = None,
) -> CreateMeetingResponse:
    # Ensure room code is unique (retry up to 5 times — collision extremely unlikely)
    for _ in range(5):
        code = _generate_room_code()
        existing = (
            await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == code))
        ).scalar_one_or_none()
        if existing is None:
            break
    else:
        raise HTTPException(status_code=500, detail="Could not generate unique room code")

    meeting = PublicMeeting(room_code=code, name=name, created_by=user_id)
    db.add(meeting)
    await db.commit()
    await db.refresh(meeting)

    return CreateMeetingResponse(
        room_code=meeting.room_code,
        name=meeting.name,
        url=f"{settings.PUBLIC_MEET_URL}/{meeting.room_code}",
    )


async def list_user_meetings(user_id: _uuid.UUID, db: AsyncSession) -> list[MeetingListItem]:
    rows = (
        await db.execute(
            select(PublicMeeting)
            .where(PublicMeeting.created_by == user_id)
            .order_by(PublicMeeting.created_at.desc())
        )
    ).scalars().all()

    return [
        MeetingListItem(
            room_code=m.room_code,
            name=m.name,
            url=f"{settings.PUBLIC_MEET_URL}/{m.room_code}",
            is_active=m.is_active,
        )
        for m in rows
    ]


async def get_meeting(room_code: str, db: AsyncSession) -> MeetingInfoResponse:
    meeting = (
        await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == room_code))
    ).scalar_one_or_none()

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    return MeetingInfoResponse(
        room_code=meeting.room_code,
        name=meeting.name,
        is_active=meeting.is_active,
    )


async def get_host_token(room_code: str, user_id: str, user_name: str, db: AsyncSession) -> TokenResponse:
    meeting = (
        await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == room_code))
    ).scalar_one_or_none()

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if not meeting.is_active:
        raise HTTPException(status_code=410, detail="Meeting has ended")

    token = create_host_token(user_id=user_id, room_code=room_code)
    return TokenResponse(token=token, room_code=room_code, name=user_name)


async def get_guest_token(room_code: str, name: str, db: AsyncSession) -> TokenResponse:
    meeting = (
        await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == room_code))
    ).scalar_one_or_none()

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if not meeting.is_active:
        raise HTTPException(status_code=410, detail="Meeting has ended")

    token = create_guest_token(name=name, room_code=room_code)
    return TokenResponse(token=token, room_code=room_code, name=name)
