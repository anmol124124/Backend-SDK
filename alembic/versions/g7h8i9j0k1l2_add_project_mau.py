"""add project_mau table for MAU tracking

Revision ID: g7h8i9j0k1l2
Revises: f6a7b8c9d0e1
Create Date: 2026-03-30 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'g7h8i9j0k1l2'
down_revision: Union[str, None] = 'a2b3c4d5e6f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'project_mau',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('project_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.String(255), nullable=False),
        sa.Column('month', sa.String(7), nullable=False),
        sa.Column('first_seen', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    # Fast lookup: all MAU for a project in a given month
    op.create_index('ix_project_mau_project_month', 'project_mau', ['project_id', 'month'])
    # Unique: one row per user per project per month
    op.create_index(
        'ix_project_mau_unique_user',
        'project_mau',
        ['project_id', 'month', 'user_id'],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index('ix_project_mau_unique_user', table_name='project_mau')
    op.drop_index('ix_project_mau_project_month', table_name='project_mau')
    op.drop_table('project_mau')
