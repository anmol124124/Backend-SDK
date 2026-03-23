import uuid

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis_client import get_redis
from app.core.security import decode_token
from app.modules.auth.models import User

bearer_scheme = HTTPBearer()
bearer_scheme_optional = HTTPBearer(auto_error=False)

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid or expired token",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme_optional),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    if not credentials:
        return None
    try:
        payload = decode_token(credentials.credentials)
    except JWTError:
        return None

    if payload.get("type") != "access":
        return None

    user_id: str | None = payload.get("sub")
    if not user_id:
        return None

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    return result.scalar_one_or_none()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    token = credentials.credentials

    try:
        payload = decode_token(token)
    except JWTError:
        raise _UNAUTHORIZED

    if payload.get("type") != "access":
        raise _UNAUTHORIZED

    user_id: str | None = payload.get("sub")
    jti: str | None = payload.get("jti")

    if not user_id:
        raise _UNAUTHORIZED

    # Check Redis token blacklist (populated on logout if implemented later)
    redis = get_redis()
    if jti and await redis.exists(f"blacklist:{jti}"):
        raise _UNAUTHORIZED

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()

    if user is None:
        raise _UNAUTHORIZED

    return user
