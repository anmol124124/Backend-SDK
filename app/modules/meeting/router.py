import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.modules.auth.models import User
from app.modules.meeting.schemas import (
    JoinResponse,
    MeetingCreateRequest,
    MeetingCreateResponse,
    MeetingListItem,
    MeetingResponse,
    ParticipantResponse,
)
from app.modules.meeting.service import MeetingService

router = APIRouter(prefix="/meetings", tags=["Meetings"])


@router.post(
    "",
    response_model=MeetingCreateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new meeting room",
    responses={
        201: {
            "description": "Meeting created. Authenticated user is set as host.",
            "content": {
                "application/json": {
                    "example": {
                        "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                        "title": "Team Standup",
                        "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
                    }
                }
            },
        },
        401: {"description": "Missing or invalid JWT token"},
    },
)
async def create_meeting(
    payload: MeetingCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MeetingCreateResponse:
    """
    **Header required:**
    ```
    Authorization: Bearer <access_token>
    ```
    **Request body:**
    ```json
    { "title": "Team Standup" }
    ```
    **Response (201):**
    ```json
    {
      "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "title": "Team Standup",
      "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d"
    }
    ```
    The authenticated user becomes the host and is automatically added
    as the first participant.
    """
    meeting = await MeetingService(db).create_meeting(current_user.id, payload)
    return MeetingCreateResponse(
        meeting_id=meeting.id,
        title=meeting.title,
        host_id=meeting.host_id,
    )


@router.get(
    "/{meeting_id}",
    response_model=MeetingResponse,
    summary="Get meeting details",
    responses={
        200: {
            "description": "Meeting details",
            "content": {
                "application/json": {
                    "example": {
                        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                        "title": "Team Standup",
                        "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
                        "is_active": True,
                        "created_at": "2026-03-16T12:00:00Z",
                    }
                }
            },
        },
        404: {"description": "Meeting not found"},
        401: {"description": "Missing or invalid JWT token"},
    },
)
async def get_meeting(
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MeetingResponse:
    """
    **Header required:**
    ```
    Authorization: Bearer <access_token>
    ```
    **Response (200):**
    ```json
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "title": "Team Standup",
      "host_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
      "is_active": true,
      "created_at": "2026-03-16T12:00:00Z"
    }
    ```
    """
    meeting = await MeetingService(db).get_meeting(meeting_id)
    return MeetingResponse.model_validate(meeting)


@router.post(
    "/{meeting_id}/join",
    response_model=JoinResponse,
    status_code=status.HTTP_200_OK,
    summary="Join an existing meeting",
    responses={
        200: {
            "description": "Successfully joined the meeting",
            "content": {
                "application/json": {
                    "example": {
                        "participant_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                        "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                        "user_id": "b1234abc-0000-0000-0000-000000000001",
                        "joined_at": "2026-03-16T12:05:00Z",
                    }
                }
            },
        },
        400: {"description": "Meeting is not active"},
        404: {"description": "Meeting not found"},
        409: {"description": "User already joined this meeting"},
        401: {"description": "Missing or invalid JWT token"},
    },
)
async def join_meeting(
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> JoinResponse:
    """
    **Header required:**
    ```
    Authorization: Bearer <access_token>
    ```
    **Response (200):**
    ```json
    {
      "participant_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "user_id": "b1234abc-0000-0000-0000-000000000001",
      "joined_at": "2026-03-16T12:05:00Z"
    }
    ```
    """
    participant = await MeetingService(db).join_meeting(meeting_id, current_user.id)
    return JoinResponse(
        participant_id=participant.id,
        meeting_id=participant.meeting_id,
        user_id=participant.user_id,
        joined_at=participant.joined_at,
    )


@router.get(
    "/{meeting_id}/participants",
    response_model=list[ParticipantResponse],
    summary="List all participants in a meeting",
    responses={
        200: {
            "description": "List of participants",
            "content": {
                "application/json": {
                    "example": [
                        {
                            "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                            "meeting_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                            "user_id": "a6739a2c-b394-487f-92a2-b5437ac2fa6d",
                            "joined_at": "2026-03-16T12:00:00Z",
                        }
                    ]
                }
            },
        },
        404: {"description": "Meeting not found"},
        401: {"description": "Missing or invalid JWT token"},
    },
)
async def get_participants(
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ParticipantResponse]:
    """
    **Header required:**
    ```
    Authorization: Bearer <access_token>
    ```
    **Response (200):**
    ```json
    [
      {
        "id": "7c9e6679-...",
        "meeting_id": "3fa85f64-...",
        "user_id": "a6739a2c-...",
        "joined_at": "2026-03-16T12:00:00Z"
      }
    ]
    ```
    """
    participants = await MeetingService(db).get_participants(meeting_id)
    return [ParticipantResponse.model_validate(p) for p in participants]


@router.get(
    "",
    response_model=list[MeetingListItem],
    summary="List all meetings (visible to every authenticated user)",
)
async def list_all_meetings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[MeetingListItem]:
    rows = await MeetingService(db).list_all_meetings()
    return [
        MeetingListItem(
            id=meeting.id,
            title=meeting.title,
            host_id=meeting.host_id,
            is_active=meeting.is_active,
            created_at=meeting.created_at,
            participant_count=count,
        )
        for meeting, count in rows
    ]


@router.delete(
    "/{meeting_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a meeting (host only)",
    responses={
        204: {"description": "Meeting deleted"},
        403: {"description": "Only the host can delete this meeting"},
        404: {"description": "Meeting not found"},
    },
)
async def delete_meeting(
    meeting_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    await MeetingService(db).delete_meeting(meeting_id, current_user.id)
