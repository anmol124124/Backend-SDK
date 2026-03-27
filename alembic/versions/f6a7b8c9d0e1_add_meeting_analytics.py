"""add meeting analytics: ended_at + project_meeting_participants

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-03-27 00:00:00.000000

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('project_meetings',
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        'project_meeting_participants',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('room_name', sa.String(length=255), nullable=False),
        sa.Column('user_id', sa.String(length=255), nullable=False),
        sa.Column('display_name', sa.String(length=255), nullable=False),
        sa.Column('role', sa.String(length=50), nullable=False),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('left_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_project_meeting_participants_room_name',
                    'project_meeting_participants', ['room_name'])


def downgrade() -> None:
    op.drop_index('ix_project_meeting_participants_room_name',
                  table_name='project_meeting_participants')
    op.drop_table('project_meeting_participants')
    op.drop_column('project_meetings', 'ended_at')
