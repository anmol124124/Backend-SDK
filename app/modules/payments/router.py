import time
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.modules.auth.models import User

# Testing: 20 minutes. Change to 30 * 24 * 60 for production (1 month).
PLAN_EXPIRY_MINUTES = 20  # 20 minutes

stripe.api_key = settings.STRIPE_SECRET_KEY

router = APIRouter(prefix="/payments", tags=["Payments"])


async def _apply_plan_to_active_meetings(user_id_str: str, new_plan: str) -> None:
    """If the user is currently hosting any public meetings, update their time limits."""
    from app.modules.meeting.connection_manager import manager
    from app.modules.project.mau import PUBLIC_MEETING_TIME_LIMITS

    rooms = manager.get_rooms_hosted_by(user_id_str)
    for room_id in rooms:
        if not manager.is_public_room(room_id):
            continue

        new_limit_min = PUBLIC_MEETING_TIME_LIMITS.get(new_plan)  # None = unlimited

        if new_limit_min is None:
            # Upgraded to unlimited — cancel any running timer
            manager.cancel_time_limit(room_id)
        else:
            started_at = manager.get_meeting_started_at(room_id)
            if started_at:
                elapsed_sec = (time.time() * 1000 - started_at) / 1000
                remaining_sec = new_limit_min * 60 - elapsed_sec
                if remaining_sec > 60:
                    manager.update_time_limit(room_id, int(remaining_sec))
                # If remaining <= 60s the old timer will fire shortly — don't restart

        await manager.broadcast_to_room(room_id, {
            "type": "plan-upgraded",
            "from": "server",
            "payload": {
                "plan": new_plan,
                "newLimitMinutes": new_limit_min,
            },
        })

PLAN_PRICES = {
    "free":       0,   # $0 / forever
    "basic":    999,   # $9.99 / month
    "pro":     2999,   # $29.99 / month
    "premium": 9999,   # $99.99 / month
}

PLAN_NAMES = {
    "free":    "Starter (Free)",
    "basic":   "Basic Plan",
    "pro":     "Pro Plan",
    "premium": "Premium Plan",
}


class CheckoutRequest(BaseModel):
    plan: str


class CheckoutResponse(BaseModel):
    checkout_url: str
    session_id: str


class PlanResponse(BaseModel):
    plan: str
    email: str
    plan_expires_at: datetime | None = None


@router.post(
    "/create-checkout-session",
    response_model=CheckoutResponse,
    summary="Create a Stripe Checkout session for a plan",
)
async def create_checkout_session(
    body: CheckoutRequest,
    current_user: User = Depends(get_current_user),
) -> CheckoutResponse:
    plan = body.plan.lower()
    if plan not in PLAN_PRICES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown plan '{plan}'. Choose from: free, basic, pro, premium.",
        )

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[
                {
                    "price_data": {
                        "currency": "usd",
                        "product_data": {"name": PLAN_NAMES[plan]},
                        "unit_amount": PLAN_PRICES[plan],
                    },
                    "quantity": 1,
                }
            ],
            mode="payment",
            success_url=(
                f"{settings.DASHBOARD_URL}?session_id={{CHECKOUT_SESSION_ID}}&plan={plan}"
            ),
            cancel_url=settings.DASHBOARD_URL,
            customer_email=current_user.email,
            metadata={"user_id": str(current_user.id), "plan": plan},
        )
    except stripe.StripeError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    return CheckoutResponse(checkout_url=session.url, session_id=session.id)


@router.post(
    "/activate-plan",
    response_model=PlanResponse,
    summary="Sandbox: directly activate a plan without Stripe",
)
async def activate_plan(
    body: CheckoutRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlanResponse:
    plan = body.plan.lower()
    if plan not in PLAN_PRICES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown plan '{plan}'. Choose from: free, basic, pro, premium.",
        )
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    user.plan = plan
    user.plan_expires_at = (
        datetime.now(timezone.utc) + timedelta(minutes=PLAN_EXPIRY_MINUTES)
        if plan != "free" else None
    )
    await db.commit()
    await _apply_plan_to_active_meetings(str(user.id), plan)
    return PlanResponse(plan=plan, email=user.email, plan_expires_at=user.plan_expires_at)


@router.get(
    "/verify-session",
    response_model=PlanResponse,
    summary="Verify a completed Stripe Checkout session and activate plan",
)
async def verify_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlanResponse:
    try:
        session = stripe.checkout.Session.retrieve(session_id)
    except stripe.StripeError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    if session.payment_status != "paid":
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Payment not completed.",
        )

    plan = session.metadata.get("plan") if session.metadata else None
    if not plan:
        plan = "basic"

    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    user.plan = plan
    user.plan_expires_at = (
        datetime.now(timezone.utc) + timedelta(minutes=PLAN_EXPIRY_MINUTES)
        if plan != "free" else None
    )
    await db.commit()
    await _apply_plan_to_active_meetings(str(user.id), plan)
    return PlanResponse(plan=plan, email=user.email, plan_expires_at=user.plan_expires_at)
