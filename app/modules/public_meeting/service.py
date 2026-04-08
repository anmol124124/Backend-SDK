"""
Public meeting service.

Room code format: "abc-defg-hij"  (3-4-3 lowercase letters, like Google Meet)
e.g. zfv-nidu-hjd
"""

import asyncio
import logging
import random
import smtplib
import string
import uuid as _uuid
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rsa_tokens import create_guest_token, create_host_token

logger = logging.getLogger(__name__)
from app.modules.public_meeting.models import PublicMeeting
from app.modules.public_meeting.schemas import (
    CreateMeetingResponse,
    MeetingInfoResponse,
    MeetingListItem,
    MeetingSettings,
    TokenResponse,
)


def _send_invites_smtp(
    invitees: list[str],
    meeting_name: str,
    join_url: str,
    scheduled_at: Optional[datetime],
    tz_name: str = "UTC",
) -> None:
    """Send invitation emails via Brevo SMTP (runs in thread pool)."""
    gcal_btn = ""
    time_line = ""
    if scheduled_at:
        try:
            tz = ZoneInfo(tz_name)
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("UTC")
            tz_name = "UTC"
        local_dt = scheduled_at.astimezone(tz)
        dt_str = local_dt.strftime("%A, %B %d, %Y at %I:%M %p") + f" ({tz_name})"
        time_line = f"<p style='margin:0 0 8px'><strong>When:</strong> {dt_str}</p>"

        # Build Google Calendar URL using local time + ctz (no UTC conversion needed)
        start = local_dt.strftime("%Y%m%dT%H%M%S")
        end_dt = local_dt.replace(hour=(local_dt.hour + 1) % 24)
        end = end_dt.strftime("%Y%m%dT%H%M%S")
        from urllib.parse import urlencode
        gcal_params = urlencode({
            "action":   "TEMPLATE",
            "text":     meeting_name,
            "dates":    f"{start}/{end}",
            "ctz":      tz_name,
            "details":  f"Join RoomLy meeting: {join_url}",
            "location": join_url,
        })
        gcal_url = f"https://calendar.google.com/calendar/render?{gcal_params}"
        gcal_btn = f"""
        <a href="{gcal_url}" target="_blank"
           style="display:inline-flex;align-items:center;gap:8px;margin-top:12px;background:#fff;color:#1a73e8;border:1.5px solid #1a73e8;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
          <img src="https://www.gstatic.com/images/branding/product/1x/calendar_48dp.png" width="18" height="18" style="vertical-align:middle" alt=""/>
          Add to Google Calendar
        </a>"""

    html_body = f"""
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden">
      <div style="background:#1a73e8;padding:28px 32px">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600">You're invited to a meeting</h1>
      </div>
      <div style="padding:28px 32px;background:#fff">
        <p style="margin:0 0 8px"><strong>Meeting:</strong> {meeting_name}</p>
        {time_line}
        <p style="margin:0 0 24px"><strong>Join link:</strong>
          <a href="{join_url}" style="color:#1a73e8">{join_url}</a>
        </p>
        <a href="{join_url}"
           style="display:inline-block;background:#1a73e8;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:500;font-size:15px">
          Join Meeting
        </a>
        {gcal_btn}
        <p style="margin:28px 0 0;font-size:12px;color:#9aa0a6">
          Powered by RoomLy &mdash; no account needed to join.
        </p>
      </div>
    </div>
    """

    with smtplib.SMTP("smtp-relay.brevo.com", 587) as server:
        server.starttls()
        server.login(settings.BREVO_SMTP_LOGIN, settings.BREVO_SMTP_KEY)
        for email in invitees:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"You're invited: {meeting_name}"
            msg["From"]    = f"{settings.BREVO_SENDER_NAME} <{settings.BREVO_SENDER_EMAIL}>"
            msg["To"]      = email
            msg.attach(MIMEText(html_body, "html"))
            server.sendmail(settings.BREVO_SENDER_EMAIL, email, msg.as_string())


async def _send_meeting_invites(
    invitees: list[str],
    meeting_name: str,
    room_code: str,
    scheduled_at: Optional[datetime],
    tz_name: str = "UTC",
) -> None:
    """Send meeting invitation emails via Brevo SMTP. Silently skips if not configured."""
    if not settings.BREVO_SMTP_KEY or not settings.BREVO_SMTP_LOGIN or not invitees:
        logger.warning("Brevo SMTP not configured — skipping invite emails")
        return

    join_url = f"{settings.PUBLIC_MEET_URL}/{room_code}"
    try:
        await asyncio.to_thread(
            _send_invites_smtp, invitees, meeting_name, join_url, scheduled_at, tz_name
        )
        logger.info("Invites sent via Brevo SMTP  room_code=%s  recipients=%d", room_code, len(invitees))
    except Exception as exc:
        logger.warning("Brevo SMTP error  room_code=%s  error=%s", room_code, exc)


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
    perms: Optional[MeetingSettings] = None,
    scheduled_at: Optional[datetime] = None,
    timezone: str = "UTC",
    invitees: Optional[list[str]] = None,
) -> CreateMeetingResponse:
    if perms is None:
        perms = MeetingSettings()

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

    invitees_str = ",".join(invitees) if invitees else None

    meeting = PublicMeeting(
        room_code=code,
        name=name,
        created_by=user_id,
        require_approval=perms.require_approval,
        allow_participants_see_others=perms.allow_participants_see_others,
        allow_participant_admit=perms.allow_participant_admit,
        allow_chat=perms.allow_chat,
        allow_screen_share=perms.allow_screen_share,
        allow_unmute_self=perms.allow_unmute_self,
        scheduled_at=scheduled_at,
        invitees=invitees_str,
    )
    db.add(meeting)
    await db.commit()
    await db.refresh(meeting)

    logger.info("Public meeting created  room_code=%s  name=%s  user_id=%s  scheduled=%s", meeting.room_code, meeting.name, user_id, scheduled_at)

    # Send email invitations (fire-and-forget — errors are logged, not raised)
    if invitees:
        await _send_meeting_invites(
            invitees=invitees,
            meeting_name=name,
            room_code=code,
            scheduled_at=scheduled_at,
            tz_name=timezone,
        )

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
            scheduled_at=m.scheduled_at,
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
        settings=MeetingSettings(
            require_approval=meeting.require_approval,
            allow_participants_see_others=meeting.allow_participants_see_others,
            allow_participant_admit=meeting.allow_participant_admit,
            allow_chat=meeting.allow_chat,
            allow_screen_share=meeting.allow_screen_share,
            allow_unmute_self=meeting.allow_unmute_self,
        ),
    )


async def get_host_token(room_code: str, user_id: str, user_name: str, db: AsyncSession) -> TokenResponse:
    meeting = (
        await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == room_code))
    ).scalar_one_or_none()

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if not meeting.is_active:
        raise HTTPException(status_code=410, detail="Meeting has ended")
    if str(meeting.created_by) != str(user_id):
        raise HTTPException(status_code=403, detail="Only the meeting creator can get a host token")

    token = create_host_token(user_id=user_id, room_code=room_code)
    logger.info("Host token issued  room_code=%s  user_id=%s  name=%s", room_code, user_id, user_name)
    return TokenResponse(token=token, room_code=room_code, name=user_name)


async def get_guest_token(room_code: str, name: str, db: AsyncSession) -> TokenResponse:
    logger.info("Guest token request  room_code=%s  name=%s", room_code, name)
    meeting = (
        await db.execute(select(PublicMeeting).where(PublicMeeting.room_code == room_code))
    ).scalar_one_or_none()

    if meeting is None:
        logger.warning("Guest token rejected — room not found  room_code=%s", room_code)
        raise HTTPException(status_code=404, detail="Meeting not found")
    if not meeting.is_active:
        logger.warning("Guest token rejected — meeting ended  room_code=%s", room_code)
        raise HTTPException(status_code=410, detail="Meeting has ended")

    token = create_guest_token(name=name, room_code=room_code)
    logger.info("Guest token issued  room_code=%s  name=%s", room_code, name)
    return TokenResponse(token=token, room_code=room_code, name=name)
