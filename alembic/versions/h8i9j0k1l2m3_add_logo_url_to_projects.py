"""add logo_url to projects

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
Create Date: 2026-03-31

"""
from alembic import op
import sqlalchemy as sa

revision = 'h8i9j0k1l2m3'
down_revision = 'g7h8i9j0k1l2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('logo_url', sa.String(1000), nullable=True))


def downgrade() -> None:
    op.drop_column('projects', 'logo_url')
