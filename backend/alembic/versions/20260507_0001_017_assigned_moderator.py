"""Add assigned_moderator to reports; truncate for fresh start

Revision ID: 017
Revises: 016
Create Date: 2026-05-07

Changes:
  - Truncate all report data again (ensures clean slate on Railway)
  - Add assigned_moderator column: wallet address of the single moderator
    assigned to review a report at submission time
"""
import sqlalchemy as sa
from alembic import op

revision = '017'
down_revision = '016'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Fresh start — remove any lingering reports from old sessions
    op.execute(sa.text("TRUNCATE TABLE reports CASCADE"))

    # Add assigned_moderator column
    op.add_column('reports', sa.Column(
        'assigned_moderator', sa.String(42), nullable=True,
        comment='Wallet address of the moderator randomly assigned at submission'
    ))


def downgrade() -> None:
    op.drop_column('reports', 'assigned_moderator')
