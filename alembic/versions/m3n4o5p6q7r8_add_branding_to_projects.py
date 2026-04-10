"""add branding fields to projects

Revision ID: m3n4o5p6q7r8
Revises: l2m3n4o5p6q7
Create Date: 2026-04-10 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = 'm3n4o5p6q7r8'
down_revision = 'l2m3n4o5p6q7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('primary_color',   sa.String(20),   nullable=True, server_default=None))
    op.add_column('projects', sa.Column('button_label',    sa.String(100),  nullable=True, server_default=None))
    op.add_column('projects', sa.Column('welcome_message', sa.String(500),  nullable=True, server_default=None))


def downgrade() -> None:
    op.drop_column('projects', 'welcome_message')
    op.drop_column('projects', 'button_label')
    op.drop_column('projects', 'primary_color')
