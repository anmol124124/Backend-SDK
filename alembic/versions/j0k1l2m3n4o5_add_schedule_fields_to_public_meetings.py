"""add scheduled_at and invitees to public_meetings

Revision ID: j0k1l2m3n4o5
Revises: h8i9j0k1l2m3
Branch Labels: None
Depends On: None

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "j0k1l2m3n4o5"
down_revision: Union[str, None] = "h8i9j0k1l2m3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "public_meetings",
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "public_meetings",
        sa.Column("invitees", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("public_meetings", "invitees")
    op.drop_column("public_meetings", "scheduled_at")
