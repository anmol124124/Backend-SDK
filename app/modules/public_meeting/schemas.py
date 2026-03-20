from pydantic import BaseModel, Field


class CreateMeetingRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Meeting display name")


class CreateMeetingResponse(BaseModel):
    room_code: str
    name: str
    url: str


class MeetingInfoResponse(BaseModel):
    room_code: str
    name: str
    is_active: bool


class GuestTokenRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60, description="Guest display name")


class TokenResponse(BaseModel):
    token: str
    room_code: str
    name: str
