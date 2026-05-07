"""
C.O.V.E.R.T - Report Service
Business logic for report management
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from typing import Optional, List, Tuple
from datetime import datetime, timedelta
from uuid import UUID
import logging
import random

from app.models.report import Report, ReportStatus, ReportVisibility, ReportLog, LogEventType
from app.core.config import settings

logger = logging.getLogger(__name__)


class ReportService:
    """Service for managing reports"""

    def _pick_random_moderator(self) -> Optional[str]:
        """Pick a random moderator wallet from MODERATOR_ADDRESSES config."""
        raw = getattr(settings, "MODERATOR_ADDRESSES", "")
        mods = [m.strip().lower() for m in raw.split(",") if m.strip()]
        if not mods:
            return None
        return random.choice(mods)

    def _pick_appeal_moderators(self, exclude: Optional[str]) -> List[str]:
        """Pick 2 moderators for a re-appeal, excluding the original moderator."""
        raw = getattr(settings, "MODERATOR_ADDRESSES", "")
        mods = [m.strip().lower() for m in raw.split(",") if m.strip()]
        if exclude:
            mods = [m for m in mods if m != exclude.lower()]
        random.shuffle(mods)
        return mods[:2]

    async def create_report(
        self,
        db: AsyncSession,
        cid: str,
        cid_hash: str,
        tx_hash: Optional[str],
        category: str,
        visibility: int,
        size_bytes: int,
        reporter_id: str,
        title: Optional[str] = None,
        description: Optional[str] = None,
        delay_hours: Optional[int] = None,
        department: Optional[str] = None,
    ) -> Report:
        """Create a new report"""
        try:
            # Map visibility int to enum
            visibility_map = {
                0: ReportVisibility.PRIVATE,
                1: ReportVisibility.MODERATED,
                2: ReportVisibility.PUBLIC,
            }
            vis_enum = visibility_map.get(visibility, ReportVisibility.MODERATED)

            # Assign a random moderator to handle this report
            assigned_mod = self._pick_random_moderator()

            report = Report(
                # IPFS storage — model uses ipfs_cid, not cid
                ipfs_cid=cid,
                # Blockchain — model uses commitment_hash (keccak256 of CID)
                commitment_hash=cid_hash,
                # Transaction hash
                transaction_hash=tx_hash,
                # Metadata
                encrypted_category=category,
                encrypted_title=title,
                encrypted_summary=description,
                visibility=vis_enum,
                file_size=size_bytes,
                # Identify the reporter anonymously by wallet address / IP hash
                reporter_nullifier=reporter_id,
                # Timestamps
                submission_timestamp=datetime.utcnow(),
                # Scheduled submission delay
                scheduled_for=datetime.utcnow() + timedelta(hours=delay_hours) if delay_hours else None,
                chain_submitted=not bool(delay_hours),
                # Chain — default to local Anvil; can be overridden via env
                chain_id=settings.CHAIN_ID,
                # Skip reviewer step — go directly to moderation queue
                status=ReportStatus.PENDING_MODERATION,
                # User-selected Bangalore dept for routing
                department=department,
                # Randomly assigned moderator
                assigned_moderator=assigned_mod,
            )

            db.add(report)

            # Flush to DB so the UUID primary key is generated before we
            # reference report.id in the audit log FK.
            await db.flush()

            # Create audit log entry (now report.id is populated)
            log = ReportLog(
                report_id=report.id,
                event_type=LogEventType.CREATED,
                event_data={"category": category, "visibility": visibility},
            )
            db.add(log)

            await db.commit()
            await db.refresh(report)

            logger.info(f"Created report {report.id} with CID {cid[:20]}...")
            return report

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to create report: {e}")
            raise

    async def get_report_by_id(
        self,
        db: AsyncSession,
        report_id: str,
    ) -> Optional[Report]:
        """Get a report by ID"""
        try:
            result = await db.execute(
                select(Report).where(
                    and_(
                        Report.id == report_id,
                        Report.deleted_at.is_(None)
                    )
                )
            )
            return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Failed to get report {report_id}: {e}")
            return None

    async def get_user_reports(
        self,
        db: AsyncSession,
        reporter_id: str,
        status: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[Report], int]:
        """Get reports for a specific user with filtering"""
        try:
            # Build query
            query = select(Report).where(
                and_(
                    Report.reporter_nullifier == reporter_id,
                    Report.deleted_at.is_(None)
                )
            )

            # Apply filters
            if status:
                status_enum = ReportStatus(status)
                query = query.where(Report.status == status_enum)

            if category:
                query = query.where(Report.encrypted_category == category)

            # Get total count
            count_query = select(func.count()).select_from(query.subquery())
            count_result = await db.execute(count_query)
            total = count_result.scalar() or 0

            # Apply pagination and ordering
            query = query.order_by(Report.submission_timestamp.desc())
            query = query.limit(limit).offset(offset)

            result = await db.execute(query)
            reports = list(result.scalars().all())

            return reports, total

        except Exception as e:
            logger.error(f"Failed to get user reports: {e}")
            return [], 0

    async def get_all_reports(
        self,
        db: AsyncSession,
        status: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
        moderator_wallet: Optional[str] = None,
    ) -> Tuple[List[Report], int]:
        """Get reports assigned to a moderator (or all if no wallet given). For moderator access."""
        try:
            query = select(Report).where(Report.deleted_at.is_(None))

            # Filter to reports assigned to OR appealed to this moderator
            if moderator_wallet:
                w = moderator_wallet.lower()
                query = query.where(
                    or_(
                        Report.assigned_moderator == w,
                        Report.appeal_mod_1 == w,
                        Report.appeal_mod_2 == w,
                    )
                )

            if status:
                try:
                    status_enum = ReportStatus(status)
                    query = query.where(Report.status == status_enum)
                except ValueError:
                    pass

            if category:
                query = query.where(Report.encrypted_category == category)

            count_query = select(func.count()).select_from(query.subquery())
            count_result = await db.execute(count_query)
            total = count_result.scalar() or 0

            query = query.order_by(Report.submission_timestamp.desc())
            query = query.limit(limit).offset(offset)

            result = await db.execute(query)
            reports = list(result.scalars().all())

            return reports, total

        except Exception as e:
            logger.error(f"Failed to get all reports: {e}")
            return [], 0

    async def get_public_reports(
        self,
        db: AsyncSession,
        limit: int = 50,
        offset: int = 0,
        category: Optional[str] = None,
    ) -> Tuple[List[Report], int]:
        """Get all public-visibility reports, newest first. No auth required."""
        try:
            query = select(Report).where(
                and_(
                    or_(
                        Report.visibility == ReportVisibility.PUBLIC,
                        and_(
                            Report.visibility == ReportVisibility.MODERATED,
                            Report.status.in_([ReportStatus.VERIFIED, ReportStatus.REJECTED]),
                        ),
                    ),
                    Report.deleted_at.is_(None),
                )
            )

            if category:
                query = query.where(Report.encrypted_category == category)

            count_query = select(func.count()).select_from(query.subquery())
            count_result = await db.execute(count_query)
            total = count_result.scalar() or 0

            query = query.order_by(Report.submission_timestamp.desc())
            query = query.limit(limit).offset(offset)

            result = await db.execute(query)
            reports = list(result.scalars().all())

            return reports, total

        except Exception as e:
            logger.error(f"Failed to get public reports: {e}")
            return [], 0

    async def delete_report(
        self,
        db: AsyncSession,
        report_id: str,
    ) -> bool:
        """Soft delete a report"""
        try:
            report = await self.get_report_by_id(db, report_id)
            if not report:
                return False

            report.deleted_at = datetime.utcnow()

            # Create log entry
            log = ReportLog(
                report_id=report.id,
                event_type=LogEventType.DELETED,
            )
            db.add(log)

            await db.commit()

            logger.info(f"Deleted report {report_id}")
            return True

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to delete report {report_id}: {e}")
            return False

    async def update_blockchain_info(
        self,
        db: AsyncSession,
        report_id: str,
        tx_hash: str,
        block_number: Optional[int] = None,
    ) -> Optional[Report]:
        """Update report with blockchain transaction info"""
        try:
            report = await self.get_report_by_id(db, report_id)
            if not report:
                return None

            report.transaction_hash = tx_hash
            if block_number:
                report.block_number = block_number

            # Create audit log entry
            log = ReportLog(
                report_id=report.id,
                event_type=LogEventType.MODIFIED,
                event_data={"tx_hash": tx_hash, "block_number": block_number},
            )
            db.add(log)

            await db.commit()
            await db.refresh(report)

            logger.info(f"Updated blockchain info for report {report_id}")
            return report

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to update blockchain info: {e}")
            return None

    async def update_status(
        self,
        db: AsyncSession,
        report_id: str,
        status: ReportStatus,
        actor_id: Optional[str] = None,
    ) -> Optional[Report]:
        """Update report status"""
        try:
            report = await self.get_report_by_id(db, report_id)
            if not report:
                return None

            old_status = report.status
            report.status = status

            # Create log entry
            log = ReportLog(
                report_id=report.id,
                event_type=LogEventType.STATUS_CHANGED,
                event_data={"old_status": old_status.value, "new_status": status.value},
                actor_id=actor_id,
            )
            db.add(log)

            await db.commit()
            await db.refresh(report)

            logger.info(f"Updated report {report_id} status to {status.value}")
            return report

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to update status: {e}")
            return None

    async def update_verification_score(
        self,
        db: AsyncSession,
        report_id: str,
        score: float,
        risk_level: str,
    ) -> Optional[Report]:
        """Update AI verification score and risk level"""
        try:
            report = await self.get_report_by_id(db, report_id)
            if not report:
                return None

            report.verification_score = score
            report.risk_level = risk_level

            await db.commit()
            await db.refresh(report)

            logger.info(f"Updated verification score for report {report_id}: {score}")
            return report

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to update verification score: {e}")
            return None

    async def get_reports_for_moderation(
        self,
        db: AsyncSession,
        status: ReportStatus = ReportStatus.PENDING,
        category: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[Report], int]:
        """Get reports pending moderation"""
        try:
            query = select(Report).where(
                and_(
                    Report.status == status,
                    Report.visibility != ReportVisibility.PRIVATE,
                    Report.deleted_at.is_(None)
                )
            )

            if category:
                query = query.where(Report.encrypted_category == category)

            # Get total count
            count_query = select(func.count()).select_from(query.subquery())
            count_result = await db.execute(count_query)
            total = count_result.scalar() or 0

            # Order by oldest first
            query = query.order_by(Report.submission_timestamp.asc())
            query = query.limit(limit).offset(offset)

            result = await db.execute(query)
            reports = list(result.scalars().all())

            return reports, total

        except Exception as e:
            logger.error(f"Failed to get moderation queue: {e}")
            return [], 0

    async def get_report_stats(
        self,
        db: AsyncSession,
        reporter_id: Optional[str] = None,
    ) -> dict:
        """Get report statistics"""
        try:
            base_query = select(Report).where(Report.deleted_at.is_(None))

            if reporter_id:
                base_query = base_query.where(Report.reporter_nullifier == reporter_id)

            # Total
            total_result = await db.execute(
                select(func.count()).select_from(base_query.subquery())
            )
            total = total_result.scalar() or 0

            # By status
            stats = {"total": total}
            for status in ReportStatus:
                status_query = base_query.where(Report.status == status)
                result = await db.execute(
                    select(func.count()).select_from(status_query.subquery())
                )
                stats[status.value] = result.scalar() or 0

            return stats

        except Exception as e:
            logger.error(f"Failed to get report stats: {e}")
            return {"total": 0}


# Singleton instance
report_service = ReportService()
