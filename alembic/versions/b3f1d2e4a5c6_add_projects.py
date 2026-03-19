"""add projects

Revision ID: b3f1d2e4a5c6
Revises: e4bbcbaa6334
Create Date: 2026-03-18
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'b3f1d2e4a5c6'
down_revision = 'e4bbcbaa6334'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'projects',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('owner_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('room_name', sa.String(255), nullable=False),
        sa.Column('embed_token', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_unique_constraint('uq_projects_room_name', 'projects', ['room_name'])
    op.create_index('ix_projects_owner_id', 'projects', ['owner_id'])


def downgrade() -> None:
    op.drop_index('ix_projects_owner_id', table_name='projects')
    op.drop_constraint('uq_projects_room_name', 'projects', type_='unique')
    op.drop_table('projects')
