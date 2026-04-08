from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.modules.contact.models import ContactInquiry

router = APIRouter(prefix="/contact", tags=["Contact"])


class ContactRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=50)
    company: str | None = Field(default=None, max_length=255)
    employee_size: str | None = Field(default=None, max_length=50)
    message: str | None = Field(default=None, max_length=2000)


class ContactResponse(BaseModel):
    ok: bool


@router.post("", response_model=ContactResponse, summary="Submit enterprise contact inquiry")
async def submit_contact(
    body: ContactRequest,
    db: AsyncSession = Depends(get_db),
) -> ContactResponse:
    inquiry = ContactInquiry(
        name=body.name,
        email=body.email,
        phone=body.phone,
        company=body.company,
        employee_size=body.employee_size,
        message=body.message,
    )
    db.add(inquiry)
    await db.commit()
    return ContactResponse(ok=True)
