"""Clear moderators table for fresh start

Revision ID: 016
Revises: 015
Create Date: 2026-05-06

Changes:
  - Truncate moderators table (stale testnet moderator records)
"""
import sqlalchemy as sa
from alembic import op

revision = '016'
down_revision = '015'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Clear legacy moderator records so fresh role grants take effect cleanly.
    # The moderators table stores off-chain role cache entries; on-chain roles
    # are the source of truth (CovertProtocol + CovertBadges).
    op.execute(sa.text("TRUNCATE TABLE moderators CASCADE"))


def downgrade() -> None:
    pass
