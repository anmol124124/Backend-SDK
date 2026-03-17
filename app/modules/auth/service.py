import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token, hash_password, verify_password
from app.modules.auth.models import User
from app.modules.auth.schemas import LoginRequest, SignupRequest, TokenResponse


class AuthService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def signup(self, payload: SignupRequest) -> User:
        """
        Create a new user account.
        Raises 409 if the email is already registered.
        """
        existing = await self.db.execute(select(User).where(User.email == payload.email))
        if existing.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already registered",
            )

        user = User(
            email=payload.email,
            password_hash=hash_password(payload.password),
        )
        self.db.add(user)
        await self.db.flush()  # assign user.id without committing
        return user

    async def login(self, payload: LoginRequest) -> TokenResponse:
        """
        Verify email + password and return a signed JWT access token.
        Always returns 401 for both wrong email and wrong password
        (avoids user enumeration).
        """
        result = await self.db.execute(select(User).where(User.email == payload.email))
        user = result.scalar_one_or_none()

        if not user or not verify_password(payload.password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )

        return TokenResponse(access_token=create_access_token(str(user.id)))

    async def get_user_by_id(self, user_id: uuid.UUID) -> User:
        """Fetch a user by primary key. Used by the /me dependency."""
        result = await self.db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        return user
