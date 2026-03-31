"""
MAU (Monthly Active Users) tracking and enforcement.

Plan limits
───────────
  basic   →  5 MAU / month
  pro     → 15 MAU / month
  premium → unlimited

Project creation limits
───────────────────────
  basic / pro → 1 project
  premium     → unlimited
"""

import uuid as _uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.database import AsyncSessionLocal
from app.modules.auth.models import User
from app.modules.project.models import Project, ProjectMAU, ProjectMeeting

# ── Plan constants ────────────────────────────────────────────────────────────

PLAN_MAU_LIMITS: dict[str | None, int | None] = {
    None:      5,
    "basic":   5,
    "pro":    15,
    "premium": None,   # unlimited
}

PLAN_PROJECT_LIMITS: dict[str | None, int | None] = {
    None:      1,
    "basic":   1,
    "pro":     1,
    "premium": None,   # unlimited
}


def _current_month() -> str:
    """Return current month as 'YYYY-MM'."""
    return datetime.now(timezone.utc).strftime("%Y-%m")


# ── Helpers ───────────────────────────────────────────────────────────────────

async def get_project_and_plan(room_name: str) -> tuple[str | None, str | None]:
    """
    Given a meeting room_name, return (project_id_str, owner_plan).
    Returns (None, None) if the room is not tied to any project.
    """
    async with AsyncSessionLocal() as db:
        # First: check project_meetings (meetings created from the embed)
        pm = (await db.execute(
            select(ProjectMeeting).where(ProjectMeeting.room_name == room_name)
        )).scalar_one_or_none()

        if pm:
            project = (await db.execute(
                select(Project).where(Project.id == pm.project_id)
            )).scalar_one_or_none()
        else:
            # Fallback: room_name is the project's own room_name
            project = (await db.execute(
                select(Project).where(Project.room_name == room_name)
            )).scalar_one_or_none()

        if not project:
            return None, None

        owner = (await db.execute(
            select(User).where(User.id == project.owner_id)
        )).scalar_one_or_none()

        return str(project.id), (owner.plan if owner else None)


# ── Core MAU check ────────────────────────────────────────────────────────────

async def check_and_record_mau(
    project_id: str,
    browser_uid: str,
    plan: str | None,
) -> tuple[bool, str]:
    """
    Check whether browser_uid is allowed to join a meeting for this project
    this month. If allowed and not yet recorded, add them to project_mau.

    Returns:
        (True, "")                  — allowed
        (False, "<reason message>") — blocked
    """
    limit = PLAN_MAU_LIMITS.get(plan, 5)
    month = _current_month()
    project_uuid = _uuid.UUID(project_id)

    async with AsyncSessionLocal() as db:
        # Already counted this month → always allow (don't count twice)
        already = (await db.execute(
            select(ProjectMAU).where(
                ProjectMAU.project_id == project_uuid,
                ProjectMAU.user_id == browser_uid,
                ProjectMAU.month == month,
            )
        )).scalar_one_or_none()

        if already:
            return True, ""

        # New user — check current month count against plan limit
        if limit is not None:
            current_count: int = (await db.execute(
                select(func.count()).select_from(ProjectMAU).where(
                    ProjectMAU.project_id == project_uuid,
                    ProjectMAU.month == month,
                )
            )).scalar_one()

            if current_count >= limit:
                plan_label = plan or "basic"
                return False, (
                    f"MAU limit reached ({current_count}/{limit} on {plan_label} plan). "
                    "The account owner must upgrade to allow more participants this month."
                )

        # Record this new MAU entry
        entry = ProjectMAU(
            project_id=project_uuid,
            user_id=browser_uid,
            month=month,
            first_seen=datetime.now(timezone.utc),
        )
        db.add(entry)
        try:
            await db.commit()
        except IntegrityError:
            # Race condition: another request inserted the same user concurrently
            await db.rollback()
            # That means they were just recorded — allow them in
        return True, ""


# ── Stats helper (used by dashboard API) ─────────────────────────────────────

async def get_mau_stats(project_id: str, plan: str | None) -> dict:
    """Return current MAU usage for a project."""
    month = _current_month()
    project_uuid = _uuid.UUID(project_id)
    limit = PLAN_MAU_LIMITS.get(plan, 5)

    async with AsyncSessionLocal() as db:
        current: int = (await db.execute(
            select(func.count()).select_from(ProjectMAU).where(
                ProjectMAU.project_id == project_uuid,
                ProjectMAU.month == month,
            )
        )).scalar_one()

    return {
        "current": current,
        "limit": limit,
        "month": month,
        "plan": plan or "basic",
        "unlimited": limit is None,
    }
