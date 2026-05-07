"""
C.O.V.E.R.T - Report Pydantic Schemas
"""

from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
from datetime import datetime


class ReportCreate(BaseModel):
    """Schema for creating a new report"""
    cid: str = Field(..., min_length=46, max_length=100, description="IPFS CID")
    cid_hash: str = Field(..., min_length=64, max_length=66, description="SHA256 hash of CID")
    tx_hash: Optional[str] = Field(None, min_length=66, max_length=66, description="Blockchain transaction hash (set after on-chain commit)")
    category: str = Field(..., description="Report category")
    visibility: int = Field(..., ge=0, le=2, description="0=private, 1=moderated, 2=public")
    size_bytes: int = Field(..., gt=0, description="Size of encrypted data")
    title: Optional[str] = Field(None, max_length=500, description="Report title (plaintext for moderator display)")
    description: Optional[str] = Field(None, max_length=10000, description="Report description (plaintext for moderator display)")
    delay_hours: Optional[int] = Field(None, ge=0, le=72, description="Delay before blockchain submission (0/6/24/72 hours)")
    department: Optional[str] = Field(None, max_length=200, description="User-selected Bangalore govt department for routing")

    @field_validator("cid")
    @classmethod
    def validate_cid(cls, v: str) -> str:
        # Accept CIDv0 (Qm...) and all CIDv1 variants (bafy..., bafk..., bafr..., etc.)
        if not (v.startswith("Qm") or v.startswith("baf")):
            raise ValueError("Invalid IPFS CID format (expected CIDv0 Qm... or CIDv1 baf...)")
        return v

    @field_validator("tx_hash")
    @classmethod
    def validate_tx_hash(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.startswith("0x"):
            raise ValueError("Transaction hash must start with 0x")
        return v


class ReportCommit(BaseModel):
    """Schema for blockchain commitment update"""
    tx_hash: str = Field(..., min_length=66, max_length=66)
    block_number: Optional[int] = None


class ReportResponse(BaseModel):
    """Schema for report response"""
    id: str
    cid: str
    cid_hash: Optional[str] = None
    tx_hash: Optional[str] = None
    category: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    status: str
    visibility: str  # "private" | "moderated" | "public"
    size_bytes: Optional[int] = None
    verification_score: Optional[float] = None
    risk_level: Optional[str] = None
    submitted_at: datetime
    reviewed_at: Optional[datetime] = None
    scheduled_for: Optional[datetime] = None
    message: Optional[str] = None
    department: Optional[str] = None

    model_config = {"from_attributes": True}


class ReportListItem(BaseModel):
    """Schema for report list item"""
    id: str
    cid: str
    cid_hash: Optional[str] = None
    tx_hash: Optional[str] = None
    category: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    status: str
    visibility: str  # "private" | "moderated" | "public"
    size_bytes: Optional[int] = None
    verification_score: Optional[float] = None
    risk_level: Optional[str] = None
    submitted_at: datetime
    reviewed_at: Optional[datetime] = None
    # Only populated in the /all endpoint (moderator access)
    reporter: Optional[str] = None
    review_decision: Optional[str] = None
    final_label: Optional[str] = None  # 'CORROBORATED' | 'NEEDS_EVIDENCE' | 'DISPUTED' | 'FALSE_OR_MANIPULATED'
    department: Optional[str] = None
    appeal_round: Optional[int] = 0
    assigned_moderator: Optional[str] = None

    model_config = {"from_attributes": True}


class ReportListResponse(BaseModel):
    """Schema for paginated report list response"""
    items: List[ReportListItem]
    total: int
    limit: int
    offset: int


class ReportStatusUpdate(BaseModel):
    """Schema for status update"""
    status: str = Field(..., description="New status value")
    reason: Optional[str] = None
    reviewer_address: Optional[str] = Field(None, description="Wallet address of the reviewer setting this decision")
    review_decision: Optional[str] = Field(None, description="Reviewer's decision: REVIEW_PASSED | NEEDS_EVIDENCE | REJECT_SPAM")
