"""add public_meetings table

Revision ID: f1a2b3c4d5e6
Revises: c4d5e6f7a8b9
Create Date: 2026-03-20 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "public_meetings",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("room_code", sa.String(11), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_public_meetings_room_code", "public_meetings", ["room_code"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_public_meetings_room_code", table_name="public_meetings")
    op.drop_table("public_meetings")
