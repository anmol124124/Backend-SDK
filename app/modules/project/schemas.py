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


class SdkJoinResponse(BaseModel):
    guest_token: str
    room_name: str
    name: str


class DomainAddRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=255)


class DomainResponse(BaseModel):
    id: UUID
    project_id: UUID
    domain: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
