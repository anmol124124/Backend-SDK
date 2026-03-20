"""fix room_code length to 12

Revision ID: a1b2c3d4e5f6
Revises: f1a2b3c4d5e6
Create Date: 2026-03-20 00:01:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "public_meetings",
        "room_code",
        existing_type=sa.String(11),
        type_=sa.String(12),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "public_meetings",
        "room_code",
        existing_type=sa.String(12),
        type_=sa.String(11),
        existing_nullable=False,
    )
