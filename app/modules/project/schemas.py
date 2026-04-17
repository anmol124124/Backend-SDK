from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    domain: str = Field(min_length=1, max_length=255)


class ProjectResponse(BaseModel):
    id: UUID
    name: str
    room_name: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EmbedResponse(BaseModel):
    html: str
    guest_html: str
    host_token: str
    room_name: str
    logo_url: str | None = None


class SdkJoinResponse(BaseModel):
    guest_token: str
    room_name: str
    name: str
    logo_url: str | None = None
    primary_color: str | None = None
    button_label: str | None = None
    welcome_message: str | None = None
    theme: str | None = None


class ProjectMeetingResponse(BaseModel):
    id: UUID
    project_id: UUID
    title: str
    room_name: str
    host_token: str
    share_url: str
    created_at: datetime
    scheduled_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class CreateMeetingRequest(BaseModel):
    embed_token: str
    title: str = Field(min_length=1, max_length=255)


class CreateMeetingResponse(BaseModel):
    room_name: str
    host_token: str
    share_url: str
    title: str


class ScheduleInviteRequest(BaseModel):
    meeting_title: str = Field(min_length=1, max_length=255)
    scheduled_at: str                    # "YYYY-MM-DDTHH:MM:SS" in the given timezone
    timezone: str = "UTC"
    invitees: list[str] = Field(default_factory=list)


class EmbedScheduleInviteRequest(BaseModel):
    embed_token: str
    meeting_title: str = Field(min_length=1, max_length=255)
    scheduled_at: str                    # "YYYY-MM-DDTHH:MM:SS" in the given timezone
    timezone: str = "UTC"
    invitees: list[str] = Field(default_factory=list)


class BrandingRequest(BaseModel):
    primary_color:   str | None = Field(None, max_length=20)
    button_label:    str | None = Field(None, max_length=100)
    welcome_message: str | None = Field(None, max_length=500)
    theme:           str | None = Field(None, pattern=r'^(light|dark)$')


class BrandingResponse(BaseModel):
    primary_color:   str | None = None
    button_label:    str | None = None
    welcome_message: str | None = None
    logo_url:        str | None = None
    theme:           str | None = None

    model_config = ConfigDict(from_attributes=True)


class ProjectSettingsRequest(BaseModel):
    allow_recording: bool


class ProjectSettingsResponse(BaseModel):
    allow_recording: bool

    model_config = ConfigDict(from_attributes=True)


class DomainAddRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=255)


class DomainResponse(BaseModel):
    id: UUID
    project_id: UUID
    domain: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
