"""Add department, appeal tracking, and re-appeal fields to reports; clear stale data

Revision ID: 015
Revises: 014
Create Date: 2026-05-06

Changes:
  - Add `department` (selected Bangalore dept) to reports
  - Add `appeal_round`, `appeal_mod_1`, `appeal_mod_2`, `appeal_decision_1`, `appeal_decision_2`
  - Truncate all report-related data (fresh start as requested)
"""
import sqlalchemy as sa
from alembic import op

revision = '015'
down_revision = '014'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Truncate stale report data (fresh start) ──────────────────────────
    # CASCADE clears dependent tables (report_logs, zkp_nullifiers, report_routing,
    # moderation_notes, moderations) automatically.
    op.execute(sa.text("TRUNCATE TABLE reports CASCADE"))
    op.execute(sa.text("TRUNCATE TABLE user_reputation CASCADE"))

    # ── 2. Add new columns ───────────────────────────────────────────────────
    op.add_column('reports', sa.Column(
        'department', sa.String(200), nullable=True,
        comment='User-selected Bangalore govt department for routing'
    ))
    op.add_column('reports', sa.Column(
        'appeal_round', sa.Integer(), nullable=False, server_default='0',
        comment='How many re-appeals have been filed (0 = never appealed)'
    ))
    op.add_column('reports', sa.Column(
        'appeal_mod_1', sa.String(42), nullable=True,
        comment='First moderator assigned to review the re-appeal'
    ))
    op.add_column('reports', sa.Column(
        'appeal_mod_2', sa.String(42), nullable=True,
        comment='Second moderator assigned to review the re-appeal'
    ))
    op.add_column('reports', sa.Column(
        'appeal_decision_1', sa.String(30), nullable=True,
        comment='Decision by appeal_mod_1: UPHOLD | OVERTURN'
    ))
    op.add_column('reports', sa.Column(
        'appeal_decision_2', sa.String(30), nullable=True,
        comment='Decision by appeal_mod_2: UPHOLD | OVERTURN'
    ))
    op.add_column('reports', sa.Column(
        'original_moderator', sa.String(42), nullable=True,
        comment='Wallet of moderator who made the original finalization decision'
    ))


def downgrade() -> None:
    op.drop_column('reports', 'original_moderator')
    op.drop_column('reports', 'appeal_decision_2')
    op.drop_column('reports', 'appeal_decision_1')
    op.drop_column('reports', 'appeal_mod_2')
    op.drop_column('reports', 'appeal_mod_1')
    op.drop_column('reports', 'appeal_round')
    op.drop_column('reports', 'department')
