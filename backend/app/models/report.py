"""
C.O.V.E.R.T - Report Database Models

SQLAlchemy models for reports, moderations, and audit logs
"""

import uuid
from datetime import datetime
from typing import Optional, List
from enum import Enum

from sqlalchemy import (
    Column,
    String,
    Integer,
    BigInteger,
    Boolean,
    Text,
    DateTime,
    Numeric,
    ForeignKey,
    Index,
    CheckConstraint,
    Enum as SQLEnum,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship, Mapped
from sqlalchemy.sql import func
from app.core.database import Base


# ===== Enums =====

class ReportStatus(str, Enum):
    """Report status values"""
    # ── New lifecycle statuses (v2) ──────────────────────────────────────
    PENDING_REVIEW = "pending_review"              # submitted, awaiting reviewer
    NEEDS_EVIDENCE = "needs_evidence"              # reviewer returned: needs more evidence
    REJECTED_BY_REVIEWER = "rejected_by_reviewer"  # reviewer flagged as spam/reject
    PENDING_MODERATION = "pending_moderation"      # reviewer passed; awaiting moderator
    APPEALED = "appealed"                          # reporter appealed reviewer decision
    VERIFIED = "verified"                          # moderator approved
    REJECTED = "rejected"                          # moderator rejected
    ARCHIVED = "archived"
    # ── Legacy statuses (backward compat for existing rows) ──────────────
    PENDING = "pending"
    UNDER_REVIEW = "under_review"
    DISPUTED = "disputed"


class ReportVisibility(str, Enum):
    """Report visibility options"""
    PRIVATE = "private"
    MODERATED = "moderated"
    PUBLIC = "public"


class RiskLevel(str, Enum):
    """AI-assessed risk levels"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ModerationAction(str, Enum):
    """Moderation action types"""
    REVIEW_STARTED = "review_started"
    REQUEST_INFO = "request_info"
    VERIFIED = "verified"
    REJECTED = "rejected"
    ESCALATED = "escalated"


class ModerationDecision(str, Enum):
    """Moderation decision types"""
    ACCEPT = "accept"
    REJECT = "reject"
    NEED_INFO = "need_info"
    ESCALATE = "escalate"


class LogEventType(str, Enum):
    """Audit log event types"""
    CREATED = "created"
    STATUS_CHANGED = "status_changed"
    ACCESSED = "accessed"
    MODIFIED = "modified"
    DELETED = "deleted"
    MODERATION_STARTED = "moderation_started"
    MODERATION_COMPLETED = "moderation_completed"
    DISPUTED = "disputed"
    RELEASED = "released"
    DMS_TRIGGERED = "dms_triggered"


# ===== Models =====

class Report(Base):
    """
    Primary table for storing encrypted whistleblower reports

    All sensitive content is stored encrypted on IPFS.
    This table only contains metadata and references.
    """
    __tablename__ = "reports"

    # Primary Key
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Blockchain Integration
    commitment_hash = Column(String(66), nullable=False, unique=True, index=True)
    transaction_hash = Column(String(66), index=True)
    block_number = Column(BigInteger)
    chain_id = Column(Integer, nullable=False)

    # IPFS Storage
    ipfs_cid = Column(String(100), nullable=False, unique=True, index=True)
    ipfs_gateway_url = Column(Text)

    # Encrypted Metadata (stored on IPFS, not here)
    encrypted_category = Column(String(500))
    encrypted_title = Column(String(1000))
    encrypted_summary = Column(Text)
    encrypted_file_hash = Column(String(100))

    # Report Metadata
    file_size = Column(BigInteger, nullable=False)
    file_type = Column(String(50))
    submission_timestamp = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now()
    )

    # Privacy Settings
    visibility = Column(
        SQLEnum(ReportVisibility, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ReportVisibility.MODERATED
    )
    anonymous = Column(Boolean, nullable=False, default=True)

    # Status Tracking
    status = Column(
        SQLEnum(ReportStatus, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=ReportStatus.PENDING_REVIEW,
        index=True
    )
    verification_score = Column(Numeric(3, 2))  # 0.00 - 1.00
    risk_level = Column(SQLEnum(RiskLevel, values_callable=lambda x: [e.value for e in x]))

    # Reporter Identity (Anonymous)
    reporter_nullifier = Column(String(66), index=True)
    reporter_commitment = Column(String(66))
    burner_address = Column(String(42))

    # Temporal Protection
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now()
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now(),
        onupdate=func.now()
    )
    last_accessed_at = Column(DateTime(timezone=True))

    # Evidence Key (AES-256 key stored as hex, for moderator access)
    # Populated for ALL reports after submission so moderators can always decrypt.
    # Key retrieval is gated by moderator role (or reporter ownership) in the API.
    evidence_key = Column(Text)

    # Reviewer tracking (kept for backward compat; no longer used in new flow)
    reviewer_address = Column(String(42))
    review_decision = Column(String(20))  # 'REVIEW_PASSED' | 'NEEDS_EVIDENCE' | 'REJECT_SPAM' | None
    final_label = Column(String(30))  # 'CORROBORATED' | 'NEEDS_EVIDENCE' | 'DISPUTED' | 'FALSE_OR_MANIPULATED' | None

    # Department routing — user-selected Bangalore govt department
    department = Column(String(200))

    # Re-appeal tracking
    appeal_round = Column(Integer, nullable=False, default=0)
    appeal_mod_1 = Column(String(42))        # First moderator assigned to re-appeal
    appeal_mod_2 = Column(String(42))        # Second moderator assigned to re-appeal
    appeal_decision_1 = Column(String(30))   # 'UPHOLD' | 'OVERTURN'
    appeal_decision_2 = Column(String(30))   # 'UPHOLD' | 'OVERTURN'
    original_moderator = Column(String(42))  # Moderator who made the original finalization

    # Scheduled Submission (delayed publishing for reporter safety)
    scheduled_for = Column(DateTime(timezone=True))
    chain_submitted = Column(Boolean, nullable=False, default=True)

    # Dead Man's Switch
    dms_enabled = Column(Boolean, default=False)
    dms_trigger_date = Column(DateTime(timezone=True))
    dms_released = Column(Boolean, default=False)

    # Soft Delete
    deleted_at = Column(DateTime(timezone=True))
    deletion_reason = Column(Text)

    # Relationships
    moderations = relationship(
        "Moderation",
        back_populates="report",
        cascade="all, delete-orphan"
    )
    logs = relationship(
        "ReportLog",
        back_populates="report",
        cascade="all, delete-orphan"
    )
    zkp_nullifier = relationship(
        "ZKPNullifier",
        back_populates="report",
        uselist=False
    )

    # Table constraints
    __table_args__ = (
        CheckConstraint(
            "verification_score >= 0.00 AND verification_score <= 1.00",
            name="valid_score"
        ),
        CheckConstraint(
            "commitment_hash ~ '^0x[a-fA-F0-9]{64}$'",
            name="commitment_format"
        ),
        CheckConstraint(
            "chain_id IN (137, 42161, 80001, 421613, 31337, 84532)",
            name="valid_chain"
        ),
        Index("idx_reports_status_active", status, postgresql_where=(deleted_at.is_(None))),
        Index("idx_reports_dms", dms_trigger_date, postgresql_where=(dms_enabled.is_(True) & dms_released.is_(False))),
    )

    def __repr__(self):
        return f"<Report {self.id} status={self.status}>"

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses"""
        return {
            "id": str(self.id),
            "commitment_hash": self.commitment_hash,
            "ipfs_cid": self.ipfs_cid,
            "ipfs_gateway_url": self.ipfs_gateway_url,
            "transaction_hash": self.transaction_hash,
            "block_number": self.block_number,
            "chain_id": self.chain_id,
            "status": self.status.value if self.status else None,
            "visibility": self.visibility.value if self.visibility else None,
            "verification_score": float(self.verification_score) if self.verification_score else None,
            "risk_level": self.risk_level.value if self.risk_level else None,
            "file_size": self.file_size,
            "submission_timestamp": self.submission_timestamp.isoformat() if self.submission_timestamp else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class ReportLog(Base):
    """
    Audit trail for all report-related events
    """
    __tablename__ = "report_logs"

    # Primary Key
    id = Column(BigInteger, primary_key=True, autoincrement=True)

    # Foreign Keys
    report_id = Column(
        UUID(as_uuid=True),
        ForeignKey("reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True
    )
    actor_id = Column(UUID(as_uuid=True))  # Could be moderator_id or null for system

    # Event Details
    event_type = Column(SQLEnum(LogEventType, values_callable=lambda x: [e.value for e in x]), nullable=False, index=True)
    event_data = Column(JSONB)

    # Change Tracking
    old_value = Column(Text)
    new_value = Column(Text)
    field_changed = Column(String(100))

    # Context (IP/UA intentionally NOT stored — reporter privacy)

    # Timestamp
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now(),
        index=True
    )

    # Relationships
    report = relationship("Report", back_populates="logs")

    def __repr__(self):
        return f"<ReportLog {self.id} event={self.event_type}>"

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses"""
        return {
            "id": self.id,
            "report_id": str(self.report_id),
            "actor_id": str(self.actor_id) if self.actor_id else None,
            "event_type": self.event_type.value if self.event_type else None,
            "event_data": self.event_data,
            "field_changed": self.field_changed,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Anchor(Base):
    """
    Daily Merkle root anchors for tamper-proof timestamping
    """
    __tablename__ = "anchors"

    # Primary Key
    id = Column(BigInteger, primary_key=True, autoincrement=True)

    # Blockchain Data
    merkle_root = Column(String(66), nullable=False, unique=True, index=True)
    transaction_hash = Column(String(66), nullable=False)
    block_number = Column(BigInteger, nullable=False)
    chain_id = Column(Integer, nullable=False)

    # Anchor Metadata
    anchor_date = Column(DateTime(timezone=True), nullable=False, unique=True, index=True)
    report_count = Column(Integer, nullable=False, default=0)

    # Merkle Tree Data
    merkle_tree = Column(JSONB)
    leaf_hashes = Column(ARRAY(Text))

    # Timestamps
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now()
    )
    anchored_at = Column(DateTime(timezone=True))

    def __repr__(self):
        return f"<Anchor {self.id} date={self.anchor_date}>"


class ZKPNullifier(Base):
    """
    Prevents double-reporting while maintaining anonymity
    """
    __tablename__ = "zkp_nullifiers"

    # Primary Key
    id = Column(BigInteger, primary_key=True, autoincrement=True)

    # ZKP Data
    nullifier = Column(String(66), nullable=False, unique=True, index=True)
    commitment = Column(String(66), nullable=False, index=True)

    # Usage Tracking
    first_used_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now()
    )
    last_used_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=func.now()
    )
    usage_count = Column(Integer, nullable=False, default=1)

    # Rate Limiting
    daily_report_count = Column(Integer, nullable=False, default=1)
    last_daily_reset = Column(DateTime(timezone=True), nullable=False, default=func.current_date())

    # Associated Report
    report_id = Column(
        UUID(as_uuid=True),
        ForeignKey("reports.id", ondelete="SET NULL")
    )

    # Relationships
    report = relationship("Report", back_populates="zkp_nullifier")

    def __repr__(self):
        return f"<ZKPNullifier {self.id}>"
