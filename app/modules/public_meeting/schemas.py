import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

_ALLOWED_NAME_RE  = re.compile(r"^[a-zA-Z0-9 _.@()]+$")
_EMOJI_RE         = re.compile(r"[\U0001F000-\U0001FFFF\U00002600-\U000027BF]")
_SQL_KEYWORD_RE   = re.compile(
    r"\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|UNION|OR|AND|NOT|NULL|"
    r"WHERE|FROM|INTO|SET|CAST|CONVERT|DECLARE|TRUNCATE|SCRIPT|ALERT)\b",
    re.IGNORECASE,
)


class MeetingSettings(BaseModel):
    require_approval: bool             = True
    allow_participants_see_others: bool = True
    allow_participant_admit: bool       = False
    allow_chat: bool                   = True
    allow_screen_share: bool           = True
    allow_unmute_self: bool            = True


class CreateMeetingRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100, description="Meeting display name")
    settings: MeetingSettings = Field(default_factory=MeetingSettings)
    scheduled_at: Optional[str] = None   # "YYYY-MM-DDTHH:MM:SS" in the given timezone
    timezone: str = "UTC"
    invitees: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def name_no_dangerous_chars(cls, v: str) -> str:
        if _EMOJI_RE.search(v):
            raise ValueError("Meeting name may not contain emoji or special symbols.")
        if not _ALLOWED_NAME_RE.match(v):
            raise ValueError("Meeting name may only contain letters, numbers, spaces, and: _ . @ ( )")
        if _SQL_KEYWORD_RE.search(v):
            raise ValueError("Meeting name contains reserved words that are not allowed.")
        if not re.search(r"[a-zA-Z0-9]", v):
            raise ValueError("Meeting name must contain at least one letter or number.")
        return v


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
    created_at: Optional[datetime] = None


class GuestTokenRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60, description="Guest display name")


class TokenResponse(BaseModel):
    token: str
    room_code: str
    name: str
