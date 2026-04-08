from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class MeetingSettings(BaseModel):
    require_approval: bool             = True
    allow_participants_see_others: bool = True
    allow_participant_admit: bool       = False
    allow_chat: bool                   = True
    allow_screen_share: bool           = True
    allow_unmute_self: bool            = True


class CreateMeetingRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Meeting display name")
    settings: MeetingSettings = Field(default_factory=MeetingSettings)
    scheduled_at: Optional[str] = None   # "YYYY-MM-DDTHH:MM:SS" in the given timezone
    timezone: str = "UTC"
    invitees: list[str] = Field(default_factory=list)


class CreateMeetingResponse(BaseModel):
    room_code: str
    name: str
    url: str


class MeetingInfoResponse(BaseModel):
    room_code: str
    name: str
    is_active: bool
    settings: MeetingSettings


class MeetingListItem(BaseModel):
    room_code: str
    name: str
    url: str
    is_active: bool
    scheduled_at: Optional[datetime] = None


class GuestTokenRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60, description="Guest display name")


class TokenResponse(BaseModel):
    token: str
    room_code: str
    name: str
