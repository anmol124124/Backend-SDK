"""add project_domains

Revision ID: c4d5e6f7a8b9
Revises: b3f1d2e4a5c6
Create Date: 2026-03-18
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'c4d5e6f7a8b9'
down_revision = 'b3f1d2e4a5c6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'project_domains',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            'project_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('projects.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('domain', sa.String(255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_project_domains_project_id', 'project_domains', ['project_id'])


def downgrade() -> None:
    op.drop_index('ix_project_domains_project_id', table_name='project_domains')
    op.drop_table('project_domains')
