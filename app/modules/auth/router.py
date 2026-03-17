from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.modules.auth.models import User
from app.modules.auth.schemas import LoginRequest, SignupRequest, TokenResponse, UserResponse
from app.modules.auth.service import AuthService

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post(
    "/signup",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new user account",
    responses={
        201: {
            "description": "User created successfully",
            "content": {
                "application/json": {
                    "example": {
                        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                        "email": "alice@example.com",
                        "created_at": "2026-03-16T10:00:00Z",
                    }
                }
            },
        },
        409: {"description": "Email already registered"},
    },
)
async def signup(
    payload: SignupRequest,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """
    **Request body:**
    ```json
    {
      "email": "alice@example.com",
      "password": "supersecret123"
    }
    ```
    **Response (201):**
    ```json
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "alice@example.com",
      "created_at": "2026-03-16T10:00:00Z"
    }
    ```
    """
    user = await AuthService(db).signup(payload)
    return UserResponse.model_validate(user)


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Authenticate and receive a JWT access token",
    responses={
        200: {
            "description": "Login successful",
            "content": {
                "application/json": {
                    "example": {
                        "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                        "token_type": "bearer",
                    }
                }
            },
        },
        401: {"description": "Invalid email or password"},
    },
)
async def login(
    payload: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """
    **Request body:**
    ```json
    {
      "email": "alice@example.com",
      "password": "supersecret123"
    }
    ```
    **Response (200):**
    ```json
    {
      "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "token_type": "bearer"
    }
    ```
    Use the `access_token` as a **Bearer** token in the `Authorization` header
    for all protected endpoints.
    """
    return await AuthService(db).login(payload)


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Return the currently authenticated user",
    responses={
        200: {
            "description": "Current user info",
            "content": {
                "application/json": {
                    "example": {
                        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
                        "email": "alice@example.com",
                        "created_at": "2026-03-16T10:00:00Z",
                    }
                }
            },
        },
        401: {"description": "Missing or invalid Bearer token"},
    },
)
async def get_me(current_user: User = Depends(get_current_user)) -> UserResponse:
    """
    **Header required:**
    ```
    Authorization: Bearer <access_token>
    ```
    **Response (200):**
    ```json
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "email": "alice@example.com",
      "created_at": "2026-03-16T10:00:00Z"
    }
    ```
    """
    return UserResponse.model_validate(current_user)
