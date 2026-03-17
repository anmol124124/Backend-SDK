import uuid
from datetime import datetime

from pydantic import BaseModel, Field


# ── Requests ──────────────────────────────────────────────────────────────────

class MeetingCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)

    model_config = {
        "json_schema_extra": {
            "example": {"title": "Team Standup"}
        }
    }


# ── Responses ─────────────────────────────────────────────────────────────────

class MeetingCreateResponse(BaseModel):
    """Returned immediately after creating a meeting."""
    meeting_id: uuid.UUID
    title: str
    host_id: uuid.UUID

    model_config = {
        "json_schema_extra": {
            "example": {
                "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "title": "Team Standup",
                "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
            }
        }
    }


class MeetingListItem(BaseModel):
    """Returned in GET /meetings — all meetings visible to any logged-in user."""
    id: uuid.UUID
    title: str
    host_id: uuid.UUID
    is_active: bool
    created_at: datetime
    participant_count: int = 0

    model_config = {"from_attributes": True}


class MeetingResponse(BaseModel):
    """Full meeting detail returned by GET /meetings/{id}."""
    id: uuid.UUID
    title: str
    host_id: uuid.UUID
    is_active: bool
    created_at: datetime

    model_config = {
        "from_attributes": True,
        "json_schema_extra": {
            "example": {
                "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "title": "Team Standup",
                "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
                "is_active": True,
                "created_at": "2026-03-16T12:00:00Z",
            }
        },
    }


class ParticipantResponse(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    user_id: uuid.UUID
    joined_at: datetime

    model_config = {
        "from_attributes": True,
        "json_schema_extra": {
            "example": {
                "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "user_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
                "joined_at": "2026-03-16T12:01:00Z",
            }
        },
    }


class JoinResponse(BaseModel):
    """Returned when a user successfully joins a meeting."""
    participant_id: uuid.UUID
    meeting_id: uuid.UUID
    user_id: uuid.UUID
    joined_at: datetime

    model_config = {
        "json_schema_extra": {
            "example": {
                "participant_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                "user_id": "b1234abc-0000-0000-0000-000000000001",
                "joined_at": "2026-03-16T12:05:00Z",
            }
        }
    }
