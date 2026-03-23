"""add meeting settings to public_meetings

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-03-23 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("public_meetings", sa.Column("require_approval",             sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("public_meetings", sa.Column("allow_participants_see_others", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("public_meetings", sa.Column("allow_participant_admit",       sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("public_meetings", sa.Column("allow_chat",                   sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("public_meetings", sa.Column("allow_screen_share",           sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("public_meetings", sa.Column("allow_unmute_self",            sa.Boolean(), nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("public_meetings", "require_approval")
    op.drop_column("public_meetings", "allow_participants_see_others")
    op.drop_column("public_meetings", "allow_participant_admit")
    op.drop_column("public_meetings", "allow_chat")
    op.drop_column("public_meetings", "allow_screen_share")
    op.drop_column("public_meetings", "allow_unmute_self")
