import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PublicMeeting(Base):
    __tablename__ = "public_meetings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Google-Meet-style room code: "zfv-nidu-hjd"
    room_code: Mapped[str] = mapped_column(String(12), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # ── Schedule fields ──────────────────────────────────────────────────────
    scheduled_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Comma-separated list of invitee email addresses
    invitees: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Participant permissions ───────────────────────────────────────────────
    require_approval: Mapped[bool]             = mapped_column(Boolean, default=True,  nullable=False)
    allow_participants_see_others: Mapped[bool] = mapped_column(Boolean, default=True,  nullable=False)
    allow_participant_admit: Mapped[bool]       = mapped_column(Boolean, default=False, nullable=False)
    allow_chat: Mapped[bool]                   = mapped_column(Boolean, default=True,  nullable=False)
    allow_screen_share: Mapped[bool]           = mapped_column(Boolean, default=True,  nullable=False)
    allow_unmute_self: Mapped[bool]            = mapped_column(Boolean, default=True,  nullable=False)


class PublicMeetingParticipant(Base):
    __tablename__ = "public_meeting_participants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_code: Mapped[str] = mapped_column(
        String(12), ForeignKey("public_meetings.room_code", ondelete="CASCADE"), nullable=False, index=True
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="guest")  # host | guest
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    left_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
