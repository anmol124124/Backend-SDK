import stripe
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.modules.auth.models import User

stripe.api_key = settings.STRIPE_SECRET_KEY

router = APIRouter(prefix="/payments", tags=["Payments"])

PLAN_PRICES = {
    "basic":   999,   # $9.99 / month
    "pro":    2999,   # $29.99 / month
    "premium": 9999,  # $99.99 / month
}

PLAN_NAMES = {
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
            detail=f"Unknown plan '{plan}'. Choose from: basic, pro, premium.",
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
            detail=f"Unknown plan '{plan}'. Choose from: basic, pro, premium.",
        )
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    user.plan = plan
    await db.commit()
    return PlanResponse(plan=plan, email=user.email)


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
    await db.commit()

    return PlanResponse(plan=plan, email=user.email)
