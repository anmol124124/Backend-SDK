"""add public_meeting_participants

Revision ID: q7r8s9t0u1v2
Revises: p6q7r8s9t0u1
Create Date: 2026-04-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'q7r8s9t0u1v2'
down_revision = 'p6q7r8s9t0u1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'public_meeting_participants',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('room_code', sa.String(12), sa.ForeignKey('public_meetings.room_code', ondelete='CASCADE'), nullable=False),
        sa.Column('display_name', sa.String(255), nullable=False),
        sa.Column('role', sa.String(20), nullable=False, server_default='guest'),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('left_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_public_meeting_participants_room_code', 'public_meeting_participants', ['room_code'])


def downgrade() -> None:
    op.drop_index('ix_public_meeting_participants_room_code', table_name='public_meeting_participants')
    op.drop_table('public_meeting_participants')
