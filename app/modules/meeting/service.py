import json
import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, delete as sql_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rabbitmq import publish_event
from app.modules.meeting.models import Meeting, Participant
from app.modules.meeting.schemas import MeetingCreateRequest


class MeetingService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _get_or_404(self, meeting_id: uuid.UUID) -> Meeting:
        result = await self.db.execute(
            select(Meeting).where(Meeting.id == meeting_id)
        )
        meeting = result.scalar_one_or_none()
        if meeting is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Meeting not found",
            )
        return meeting

    @staticmethod
    async def _publish(routing_key: str, data: dict) -> None:
        """Fire-and-forget RabbitMQ event — never fails the HTTP request."""
        try:
            await publish_event(
                "meeting.events", routing_key, json.dumps(data).encode()
            )
        except Exception:
            pass

    # ── Public API ────────────────────────────────────────────────────────────

    async def create_meeting(
        self, host_id: uuid.UUID, payload: MeetingCreateRequest
    ) -> Meeting:
        """
        Create a new meeting room and automatically add the host as the
        first participant.
        """
        meeting = Meeting(
            title=payload.title,
            host_id=host_id,
            is_active=True,
        )
        self.db.add(meeting)
        await self.db.flush()  # populate meeting.id

        # Host is automatically a participant
        self.db.add(Participant(meeting_id=meeting.id, user_id=host_id))
        await self.db.flush()

        await self._publish(
            "meeting.created",
            {"meeting_id": str(meeting.id), "host_id": str(host_id)},
        )
        return meeting

    async def get_meeting(self, meeting_id: uuid.UUID) -> Meeting:
        return await self._get_or_404(meeting_id)

    async def join_meeting(
        self, meeting_id: uuid.UUID, user_id: uuid.UUID
    ) -> Participant:
        """
        Add the user to the meeting's participant list.
        Raises 404 if meeting doesn't exist, 400 if not active,
        409 if already joined.
        """
        meeting = await self._get_or_404(meeting_id)

        if not meeting.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Meeting is not active",
            )

        # Prevent duplicate participation
        existing = await self.db.execute(
            select(Participant).where(
                Participant.meeting_id == meeting_id,
                Participant.user_id == user_id,
            )
        )
        if existing.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User already joined this meeting",
            )

        participant = Participant(meeting_id=meeting_id, user_id=user_id)
        self.db.add(participant)
        await self.db.flush()

        await self._publish(
            "meeting.participant.joined",
            {"meeting_id": str(meeting_id), "user_id": str(user_id)},
        )
        return participant

    async def get_participants(self, meeting_id: uuid.UUID) -> list[Participant]:
        """Return all participants for a meeting. Validates meeting exists first."""
        await self._get_or_404(meeting_id)

        result = await self.db.execute(
            select(Participant).where(Participant.meeting_id == meeting_id)
        )
        return list(result.scalars().all())

    async def list_all_meetings(self) -> list[tuple]:
        """
        Return every meeting with its participant count, newest first.
        Visible to all authenticated users.
        """
        result = await self.db.execute(
            select(Meeting, func.count(Participant.id).label("participant_count"))
            .outerjoin(Participant, Participant.meeting_id == Meeting.id)
            .group_by(Meeting.id)
            .order_by(Meeting.created_at.desc())
        )
        return result.all()

    async def delete_meeting(
        self, meeting_id: uuid.UUID, host_id: uuid.UUID
    ) -> None:
        """
        Hard-delete a meeting and all its participants.
        Only the host may delete their own meeting.
        """
        meeting = await self._get_or_404(meeting_id)

        if meeting.host_id != host_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the host can delete this meeting",
            )

        # Remove participants first (no CASCADE on FK) using bulk DELETE
        await self.db.execute(
            sql_delete(Participant).where(Participant.meeting_id == meeting_id)
        )
        await self.db.execute(
            sql_delete(Meeting).where(Meeting.id == meeting_id)
        )

        await self._publish(
            "meeting.deleted",
            {"meeting_id": str(meeting_id), "host_id": str(host_id)},
        )
