"""
C.O.V.E.R.T - Reports API Endpoints

Role model (v2 — no reviewers):
  • Reporters   — submit & own reports
  • Moderators  — see all reports, access all evidence, finalize decisions
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional, List
from datetime import datetime
from uuid import UUID
import logging

logger = logging.getLogger(__name__)

# keccak256 for CID hash verification (matches ethers.keccak256 on the frontend)
try:
    from eth_hash.auto import keccak as keccak256_fn
except ImportError:
    try:
        from Crypto.Hash import keccak

        def keccak256_fn(data: bytes) -> bytes:  # type: ignore
            h = keccak.new(digest_bits=256)
            h.update(data)
            return h.digest()
    except ImportError as exc:
        raise ImportError(
            "Missing keccak256 backend. Install eth-hash[pycryptodome]."
        ) from exc

from app.core.database import get_db
from app.models.report import Report, ReportStatus, ReportVisibility
from app.services.report_service import report_service
from app.services.reputation_service import reputation_service
from app.api.v1.auth import get_current_wallet
from app.api.v1.rbac import require_moderator_role
from app.core.config import settings
from pydantic import BaseModel as PydanticBaseModel

from app.schemas.report import (
    ReportCreate,
    ReportResponse,
    ReportListResponse,
    ReportListItem,
    ReportCommit,
    ReportStatusUpdate,
)


class EvidenceKeyStore(PydanticBaseModel):
    """Body for storing an evidence AES key."""
    key_hex: str  # 64-char hex string (32-byte AES-256 key)


class FinalizeBody(PydanticBaseModel):
    """Body for finalizing a report — updates status and applies reputation changes."""
    status: str                              # 'verified' | 'rejected' | 'disputed' | 'under_review'
    final_label: Optional[str] = None       # 'CORROBORATED' | 'NEEDS_EVIDENCE' | 'DISPUTED' | 'FALSE_OR_MANIPULATED'
    reporter: Optional[str] = None          # reporter wallet address
    appeal_outcome: Optional[str] = None    # 'APPEAL_WON' | 'APPEAL_LOST' | 'APPEAL_ABUSIVE' | None
    supporters: Optional[List[str]] = None  # wallet addresses that supported
    challengers: Optional[List[str]] = None # wallet addresses that challenged
    malicious_wallets: Optional[List[str]] = None  # wallets marked malicious by moderator
    review_decision: Optional[str] = None   # kept for compat
    moderator_address: Optional[str] = None # wallet of the finalising moderator


class ReAppealBody(PydanticBaseModel):
    """Body for filing a re-appeal on a rejected/needs-evidence report."""
    reason: Optional[str] = None


class AppealDecideBody(PydanticBaseModel):
    """Body for a second-round appeal moderator decision."""
    decision: str  # 'UPHOLD' | 'OVERTURN'


router = APIRouter(prefix="/reports", tags=["reports"])


# Import limiter lazily to avoid circular import (it's set on app.state in main.py)
def _get_limiter():
    from app.main import limiter
    return limiter


@router.post("", response_model=ReportResponse, status_code=201)
async def submit_report(
    report_data: ReportCreate,
    request: Request,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """
    Submit a new encrypted report. Reports go directly to the moderation queue.
    Rate limited to RATE_LIMIT_SUBMISSIONS per hour (default: 10).
    """
    identifier = wallet

    if report_data.tx_hash and (not report_data.tx_hash.startswith("0x") or len(report_data.tx_hash) != 66):
        raise HTTPException(status_code=400, detail="Invalid transaction hash format")

    # Verify CID hash matches (frontend uses ethers.keccak256)
    cid_bytes = report_data.cid.encode('utf-8')
    computed_hash_bytes = keccak256_fn(cid_bytes)
    computed_hash_hex = computed_hash_bytes.hex()
    cid_hash_clean = report_data.cid_hash.lower().replace("0x", "")
    if computed_hash_hex != cid_hash_clean:
        raise HTTPException(status_code=400, detail="CID hash mismatch")

    # Check for duplicate CID
    existing = await db.execute(
        select(Report).where(Report.ipfs_cid == report_data.cid)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Report already submitted")

    try:
        report = await report_service.create_report(
            db=db,
            cid=report_data.cid,
            cid_hash=report_data.cid_hash,
            tx_hash=report_data.tx_hash,
            category=report_data.category,
            visibility=report_data.visibility,
            size_bytes=report_data.size_bytes,
            reporter_id=identifier,
            title=report_data.title,
            description=report_data.description,
            delay_hours=report_data.delay_hours,
            department=report_data.department,
        )

        return ReportResponse(
            id=str(report.id),
            cid=report.ipfs_cid,
            cid_hash=report.commitment_hash,
            tx_hash=report.transaction_hash,
            category=report.encrypted_category,
            title=report.encrypted_title,
            description=report.encrypted_summary,
            status=report.status.value,
            visibility=report.visibility.value if hasattr(report.visibility, 'value') else str(report.visibility),
            size_bytes=report.file_size,
            submitted_at=report.submission_timestamp,
            scheduled_for=report.scheduled_for,
            department=report.department,
            message="Report submitted successfully"
        )

    except Exception as e:
        logger.error(f"Report submission failed: {e}")
        raise HTTPException(status_code=500, detail="Report submission failed")


@router.get("", response_model=ReportListResponse)
async def list_reports(
    request: Request,
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """List the authenticated user's own submitted reports."""
    identifier = wallet

    reports, total = await report_service.get_user_reports(
        db=db,
        reporter_id=identifier,
        status=status,
        category=category,
        limit=limit,
        offset=offset,
    )

    items = [
        ReportListItem(
            id=str(r.id),
            cid=r.ipfs_cid,
            cid_hash=r.commitment_hash,
            tx_hash=r.transaction_hash,
            category=r.encrypted_category,
            title=r.encrypted_title,
            description=r.encrypted_summary,
            status=r.status.value,
            visibility=r.visibility.value if hasattr(r.visibility, 'value') else str(r.visibility),
            size_bytes=r.file_size,
            verification_score=float(r.verification_score) if r.verification_score else None,
            risk_level=r.risk_level.value if r.risk_level and hasattr(r.risk_level, 'value') else r.risk_level,
            submitted_at=r.submission_timestamp,
            reviewed_at=None,
            review_decision=r.review_decision,
            final_label=getattr(r, 'final_label', None),
            department=r.department,
            appeal_round=r.appeal_round or 0,
        )
        for r in reports
    ]

    return ReportListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


# ── Static/non-parameterised routes MUST come before /{report_id} ──────────────

@router.get("/public", response_model=ReportListResponse)
async def list_public_reports(
    category: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """
    List public-visibility reports for logged-in users.
    Authentication required — public reports are only shown to wallet holders.
    Private reports are never returned here.
    """
    reports, total = await report_service.get_public_reports(
        db=db,
        limit=limit,
        offset=offset,
        category=category,
    )

    items = [
        ReportListItem(
            id=str(r.id),
            cid=r.ipfs_cid,
            cid_hash=r.commitment_hash,
            tx_hash=r.transaction_hash or "0x" + "0" * 64,
            category=r.encrypted_category,
            title=r.encrypted_title,
            description=r.encrypted_summary,
            status=r.status.value,
            visibility=r.visibility.value if hasattr(r.visibility, 'value') else str(r.visibility),
            size_bytes=r.file_size,
            verification_score=float(r.verification_score) if r.verification_score else None,
            risk_level=r.risk_level.value if r.risk_level and hasattr(r.risk_level, 'value') else r.risk_level,
            submitted_at=r.submission_timestamp,
            reviewed_at=None,
            review_decision=r.review_decision,
            final_label=getattr(r, 'final_label', None),
            department=r.department,
            appeal_round=r.appeal_round or 0,
        )
        for r in reports
    ]

    return ReportListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/all", response_model=ReportListResponse)
async def list_all_reports(
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    wallet: str = Depends(require_moderator_role),
    db: AsyncSession = Depends(get_db),
):
    """
    List ALL reports (all visibilities, all reporters).
    Requires MODERATOR_ROLE. Used by the moderator dashboard.
    """
    reports, total = await report_service.get_all_reports(
        db=db,
        status=status,
        category=category,
        limit=limit,
        offset=offset,
        moderator_wallet=wallet,
    )

    items = [
        ReportListItem(
            id=str(r.id),
            cid=r.ipfs_cid,
            cid_hash=r.commitment_hash,
            tx_hash=r.transaction_hash or "0x" + "0" * 64,
            category=r.encrypted_category,
            title=r.encrypted_title,
            description=r.encrypted_summary,
            status=r.status.value,
            visibility=r.visibility.value if hasattr(r.visibility, 'value') else str(r.visibility),
            size_bytes=r.file_size,
            verification_score=float(r.verification_score) if r.verification_score else None,
            risk_level=r.risk_level.value if r.risk_level and hasattr(r.risk_level, 'value') else r.risk_level,
            submitted_at=r.submission_timestamp,
            reviewed_at=None,
            review_decision=r.review_decision,
            final_label=getattr(r, 'final_label', None),
            reporter=r.reporter_nullifier,
            department=r.department,
            appeal_round=r.appeal_round or 0,
            assigned_moderator=r.assigned_moderator,
        )
        for r in reports
    ]

    return ReportListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/by-hash/{cid_hash}", response_model=ReportResponse)
async def get_report_by_cid_hash(
    cid_hash: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Fetch report metadata by CID hash.
    No ownership check — accessible to any caller (used by moderator dashboard).
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(
        select(Report).where(Report.commitment_hash == normalized)
    )
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    return ReportResponse(
        id=str(report.id),
        cid=report.ipfs_cid,
        cid_hash=report.commitment_hash,
        tx_hash=report.transaction_hash or "0x" + "0" * 64,
        category=report.encrypted_category,
        title=report.encrypted_title,
        description=report.encrypted_summary,
        status=report.status.value,
        visibility=report.visibility.value if hasattr(report.visibility, 'value') else str(report.visibility),
        size_bytes=report.file_size,
        verification_score=float(report.verification_score) if report.verification_score else None,
        risk_level=report.risk_level.value if report.risk_level and hasattr(report.risk_level, 'value') else report.risk_level,
        submitted_at=report.submission_timestamp,
        reviewed_at=None,
        department=report.department,
    )


@router.patch("/by-hash/{cid_hash}/status")
async def update_report_status_by_hash(
    cid_hash: str,
    update: ReportStatusUpdate,
    wallet: str = Depends(require_moderator_role),
    db: AsyncSession = Depends(get_db),
):
    """
    Sync on-chain decision to backend DB status. Requires MODERATOR_ROLE.
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(
        select(Report).where(Report.commitment_hash == normalized)
    )
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    try:
        new_status = ReportStatus(update.status)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{update.status}'. Valid values: {[s.value for s in ReportStatus]}"
        )

    report.status = new_status
    if update.reviewer_address:
        report.reviewer_address = update.reviewer_address.lower()
    if update.review_decision:
        report.review_decision = update.review_decision
    await db.commit()

    return {"id": str(report.id), "status": report.status.value}


@router.post("/by-hash/{cid_hash}/finalize")
async def finalize_report(
    cid_hash: str,
    body: FinalizeBody,
    wallet: str = Depends(require_moderator_role),
    db: AsyncSession = Depends(get_db),
):
    """
    Called by the moderator after finalizing a report.
    Updates status, applies reputation changes, routes to selected department.
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(
        select(Report).where(Report.commitment_hash == normalized)
    )
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    try:
        new_status = ReportStatus(body.status)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{body.status}'. Valid values: {[s.value for s in ReportStatus]}"
        )

    report.status = new_status
    if body.final_label:
        report.final_label = body.final_label
    if body.review_decision:
        report.review_decision = body.review_decision

    # Record the moderator who made this decision (for re-appeal assignment)
    moderator = body.moderator_address or wallet
    if not report.original_moderator:
        report.original_moderator = moderator.lower()

    await db.commit()

    # Apply reputation changes
    if body.final_label and body.reporter:
        await reputation_service.apply_finalization_rep_changes(
            db,
            reporter=body.reporter,
            final_label=body.final_label,
            appeal_outcome=body.appeal_outcome,
            supporters=body.supporters or [],
            challengers=body.challengers or [],
            malicious_set=set(body.malicious_wallets or []),
        )
        await db.commit()

    # ── Route corroborated reports to the selected department ──────────────
    if body.final_label == 'CORROBORATED':
        import asyncio
        from app.services.routing_service import route_report_to_department
        report_text = f"{report.encrypted_title or ''} {report.encrypted_summary or ''}"
        selected_dept = report.department  # may be None → falls back to text classifier
        asyncio.create_task(
            route_report_to_department(str(report.id), report_text, db, selected_dept)
        )

    return {"id": str(report.id), "status": report.status.value}


@router.post("/by-hash/{cid_hash}/re-appeal")
async def re_appeal_report(
    cid_hash: str,
    body: ReAppealBody,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """
    Reporter files a re-appeal on a rejected or needs-evidence report.

    The report status is set to 'appealed' and appeal_round is incremented.
    The system will assign two different moderators (not the original moderator)
    to review the appeal independently.

    Penalisation logic (applied when both moderators have decided):
      - Both UPHOLD original decision → reporter −5 rep + strike
      - Either OVERTURN             → original moderator −5 rep + strike
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(select(Report).where(Report.commitment_hash == normalized))
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if (report.reporter_nullifier or "").lower() != wallet.lower():
        raise HTTPException(status_code=403, detail="Only the reporter may appeal this report")

    allowed = {ReportStatus.REJECTED, ReportStatus.NEEDS_EVIDENCE, ReportStatus.REJECTED_BY_REVIEWER}
    if report.status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Re-appeal not allowed for status '{report.status.value}'."
        )

    report.status = ReportStatus.APPEALED
    report.appeal_round = (report.appeal_round or 0) + 1
    # Assign 2 different moderators (not the original) for this appeal round
    appeal_mods = report_service._pick_appeal_moderators(report.original_moderator)
    report.appeal_mod_1 = appeal_mods[0] if len(appeal_mods) > 0 else None
    report.appeal_mod_2 = appeal_mods[1] if len(appeal_mods) > 1 else None
    # Reset appeal decisions for the new round
    report.appeal_decision_1 = None
    report.appeal_decision_2 = None
    await db.commit()

    return {
        "id": str(report.id),
        "status": report.status.value,
        "appeal_round": report.appeal_round,
        "message": "Re-appeal filed. Two moderators will independently review your case.",
    }


@router.post("/by-hash/{cid_hash}/appeal-decide")
async def appeal_decide(
    cid_hash: str,
    body: AppealDecideBody,
    wallet: str = Depends(require_moderator_role),
    db: AsyncSession = Depends(get_db),
):
    """
    A moderator records their decision on a re-appeal.

    The moderator must NOT be the original moderator. Slot 1 is filled first;
    once both slots are filled the system resolves and applies penalties:
      - Both UPHOLD  → reporter penalised (−5 rep + strike)
      - Any OVERTURN → original moderator penalised (−5 rep + strike)
    """
    if body.decision not in ("UPHOLD", "OVERTURN"):
        raise HTTPException(status_code=400, detail="decision must be 'UPHOLD' or 'OVERTURN'")

    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(select(Report).where(Report.commitment_hash == normalized))
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if report.status != ReportStatus.APPEALED:
        raise HTTPException(status_code=400, detail="Report is not in 'appealed' state")

    mod = wallet.lower()

    # Block original moderator from deciding on their own appeal
    if report.original_moderator and mod == report.original_moderator.lower():
        raise HTTPException(
            status_code=403,
            detail="The original moderator cannot decide on a re-appeal of their own decision."
        )

    # Check if this moderator is one of the two pre-assigned appeal moderators
    assigned_mods = []
    if report.appeal_mod_1:
        assigned_mods.append(report.appeal_mod_1.lower())
    if report.appeal_mod_2:
        assigned_mods.append(report.appeal_mod_2.lower())

    if assigned_mods and mod not in assigned_mods:
        raise HTTPException(
            status_code=403,
            detail="You are not assigned to decide on this appeal."
        )

    # Record decision in the correct slot
    if report.appeal_mod_1 and mod == report.appeal_mod_1.lower():
        report.appeal_decision_1 = body.decision
    elif report.appeal_mod_2 and mod == report.appeal_mod_2.lower():
        report.appeal_decision_2 = body.decision
    else:
        # Fallback: fill first available slot (shouldn't normally reach here)
        if not report.appeal_decision_1:
            report.appeal_mod_1 = mod
            report.appeal_decision_1 = body.decision
        elif not report.appeal_decision_2:
            report.appeal_mod_2 = mod
            report.appeal_decision_2 = body.decision
        else:
            raise HTTPException(status_code=400, detail="Both appeal slots are already filled.")

    await db.commit()

    # ── Resolve when both slots are filled ──────────────────────────────────
    if report.appeal_decision_1 and report.appeal_decision_2:
        both_uphold = (
            report.appeal_decision_1 == "UPHOLD"
            and report.appeal_decision_2 == "UPHOLD"
        )
        if both_uphold:
            # Reporter loses appeal — penalise reporter
            if report.reporter_nullifier:
                await reputation_service.issue_strike(db, report.reporter_nullifier)
            report.status = ReportStatus.REJECTED  # original decision stands
            msg = "Appeal resolved: both moderators upheld the original decision. Reporter penalised."
        else:
            # Original moderator was wrong — penalise them
            if report.original_moderator:
                await reputation_service.issue_strike(db, report.original_moderator)
            report.status = ReportStatus.VERIFIED  # overturn → corroborated
            msg = "Appeal resolved: decision overturned. Original moderator penalised."

        await db.commit()
        return {"id": str(report.id), "status": report.status.value, "resolved": True, "message": msg}

    return {
        "id": str(report.id),
        "status": report.status.value,
        "resolved": False,
        "message": "Decision recorded. Waiting for the second moderator.",
    }


@router.post("/by-hash/{cid_hash}/resubmit")
async def resubmit_report(
    cid_hash: str,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """Allow the reporter to resubmit a report returned for more evidence."""
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(select(Report).where(Report.commitment_hash == normalized))
    report = result.scalar_one_or_none()

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if (report.reporter_nullifier or "").lower() != wallet.lower():
        raise HTTPException(status_code=403, detail="Only the reporter may resubmit this report")

    allowed_statuses = {ReportStatus.NEEDS_EVIDENCE, ReportStatus.REJECTED_BY_REVIEWER}
    if report.status not in allowed_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Resubmit not allowed for status '{report.status.value}'."
        )

    report.status = ReportStatus.PENDING_MODERATION
    report.review_decision = None
    report.reviewer_address = None
    await db.commit()

    return {"id": str(report.id), "status": report.status.value, "message": "Report resubmitted for moderation"}


@router.post("/by-hash/{cid_hash}/evidence-key", status_code=200)
async def store_evidence_key(
    cid_hash: str,
    data: EvidenceKeyStore,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """
    Store the AES-256 evidence key for a report (called by the reporter after submission).

    The key is stored for ALL reports (including private) so moderators can always
    decrypt the evidence. Only the original reporter may upload the key.
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(select(Report).where(Report.commitment_hash == normalized))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if (report.reporter_nullifier or "").lower() != wallet.lower():
        raise HTTPException(status_code=403, detail="Only the reporter can store the evidence key")

    if len(data.key_hex) != 64 or not all(c in "0123456789abcdefABCDEF" for c in data.key_hex):
        raise HTTPException(status_code=400, detail="key_hex must be a 64-character hex string")

    report.evidence_key = data.key_hex.lower()
    await db.commit()
    return {"stored": True}


@router.get("/by-hash/{cid_hash}/evidence-key")
async def get_evidence_key(
    cid_hash: str,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """
    Return the AES-256 evidence key for a report.

    Accessible to:
      • The original reporter (ownership check)
      • Any authenticated moderator (MODERATOR_ROLE on-chain)

    Returns 404 if no key has been stored yet.
    """
    normalized = cid_hash.lower() if cid_hash.startswith("0x") else f"0x{cid_hash.lower()}"
    result = await db.execute(select(Report).where(Report.commitment_hash == normalized))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    is_reporter = (report.reporter_nullifier or "").lower() == wallet.lower()

    # Public reports: any authenticated user can view evidence
    vis = report.visibility.value if hasattr(report.visibility, 'value') else str(report.visibility)
    is_public = vis == 'public'

    # Check moderator role (lazy — don't raise if check fails, just deny)
    is_moderator = False
    if not is_reporter and not is_public:
        try:
            from app.services.blockchain_service import blockchain_service
            if not blockchain_service.w3:
                await blockchain_service.initialize()
            is_moderator = await blockchain_service.has_moderator_role(wallet)
        except Exception:
            # In dev/debug mode without contracts, allow any authenticated wallet
            if settings.DEBUG:
                is_moderator = True

    if not is_reporter and not is_public and not is_moderator:
        raise HTTPException(status_code=403, detail="Access denied — moderator role or report ownership required")

    if not report.evidence_key:
        raise HTTPException(status_code=404, detail="No evidence key available for this report")

    return {
        "key_hex": report.evidence_key,
        "visibility": report.visibility.value if hasattr(report.visibility, 'value') else str(report.visibility),
    }


# ── Parameterised routes (must follow all static routes above) ─────────────────

@router.get("/{report_id}", response_model=ReportResponse)
async def get_report(
    report_id: str,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """Get report details by ID. Ownership required."""
    report = await report_service.get_report_by_id(db, report_id)

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if report.reporter_nullifier != wallet:
        raise HTTPException(status_code=403, detail="Access denied")

    return ReportResponse(
        id=str(report.id),
        cid=report.ipfs_cid,
        cid_hash=report.commitment_hash,
        tx_hash=report.transaction_hash,
        category=report.encrypted_category,
        title=report.encrypted_title,
        description=report.encrypted_summary,
        status=report.status.value,
        visibility=report.visibility.value if hasattr(report.visibility, 'value') else str(report.visibility),
        size_bytes=report.file_size,
        verification_score=float(report.verification_score) if report.verification_score else None,
        risk_level=report.risk_level.value if report.risk_level and hasattr(report.risk_level, 'value') else report.risk_level,
        submitted_at=report.submission_timestamp,
        reviewed_at=None,
        department=report.department,
    )


@router.delete("/{report_id}")
async def delete_report(
    report_id: str,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """Mark a report as deleted (soft delete). Ownership required."""
    report = await report_service.get_report_by_id(db, report_id)

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if report.reporter_nullifier != wallet:
        raise HTTPException(status_code=403, detail="Access denied")

    success = await report_service.delete_report(db, report_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete report")

    return {"message": "Report deleted successfully"}


@router.post("/{report_id}/commit", response_model=ReportResponse)
async def commit_to_blockchain(
    report_id: str,
    commit_data: ReportCommit,
    wallet: str = Depends(get_current_wallet),
    db: AsyncSession = Depends(get_db),
):
    """Update report with blockchain commitment transaction hash."""
    report = await report_service.get_report_by_id(db, report_id)

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    if report.reporter_nullifier != wallet:
        raise HTTPException(status_code=403, detail="Access denied")

    updated = await report_service.update_blockchain_info(
        db=db,
        report_id=report_id,
        tx_hash=commit_data.tx_hash,
        block_number=commit_data.block_number,
    )

    return ReportResponse(
        id=str(updated.id),
        cid=updated.ipfs_cid,
        cid_hash=updated.commitment_hash,
        tx_hash=updated.transaction_hash,
        category=updated.encrypted_category,
        status=updated.status.value,
        visibility=updated.visibility.value if hasattr(updated.visibility, 'value') else str(updated.visibility),
        size_bytes=updated.file_size,
        submitted_at=updated.submission_timestamp,
        department=updated.department,
        message="Blockchain commitment recorded"
    )


@router.get("/{report_id}/status")
async def get_report_status(
    report_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Get the current status of a report (public)."""
    report = await report_service.get_report_by_id(db, report_id)

    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    return {
        "id": str(report.id),
        "status": report.status.value,
        "verification_score": float(report.verification_score) if report.verification_score else None,
        "risk_level": report.risk_level.value if report.risk_level and hasattr(report.risk_level, 'value') else report.risk_level,
        "reviewed_at": None,
        "final_label": report.final_label,
        "appeal_round": report.appeal_round or 0,
        "department": report.department,
    }
