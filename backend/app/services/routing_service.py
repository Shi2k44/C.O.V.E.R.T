"""
C.O.V.E.R.T - Report Routing Service

Automatically routes verified reports to the appropriate Bangalore
civic department based on keyword classification.
"""

import asyncio
import logging
import uuid
from typing import List, Optional

from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.routing import Department, ReportRouting
from app.services.classifier_service import classify_report, is_bangalore

logger = logging.getLogger(__name__)


async def route_report_to_department(
    report_id: str,
    report_text: str,
    db: AsyncSession,
    selected_department: Optional[str] = None,
) -> List[str]:
    """
    Route a corroborated report to the correct Bangalore department.

    If `selected_department` is set (user chose a dept at submission time),
    look that department up by name and route directly.
    Otherwise fall back to the keyword classifier.
    """
    if selected_department:
        # Find by name (case-insensitive)
        dept_result = await db.execute(
            select(Department).where(
                Department.is_active.is_(True),
                func.lower(Department.name) == selected_department.strip().lower(),
            )
        )
        dept = dept_result.scalar_one_or_none()
        if dept:
            token = uuid.uuid4()
            routing = ReportRouting(
                report_id=report_id,
                department_id=dept.id,
                response_token=token,
            )
            db.add(routing)
            await db.commit()
            asyncio.create_task(_send_notification(dept, report_id, token, db))
            logger.info(f"[routing] Report {report_id}: routed to selected dept '{dept.name}'")
            return [dept.name]
        # Selected dept not found in DB — fall through to text classifier

    return await route_report(report_id, report_text, db)


async def route_report(
    report_id: str,
    report_text: str,
    db: AsyncSession,
) -> List[str]:
    """
    Classify the report, match to Bangalore departments, create routing
    rows, and fire off notification emails asynchronously.

    Returns a list of matched department names (empty if nothing matched).
    """
    # 1. Classify
    result = classify_report(report_text)
    category = result["category"]

    # 2. Check location
    if not is_bangalore(report_text):
        logger.info(f"[routing] Report {report_id}: Not Bangalore, skipping")
        return []

    # 3. Category unclear
    if category == "other":
        logger.info(f"[routing] Report {report_id}: Category unclear, skipping")
        return []

    # 4. Find matching departments
    dept_result = await db.execute(
        select(Department).where(
            and_(
                Department.is_active.is_(True),
                Department.categories.any(category),
            )
        )
    )
    departments = list(dept_result.scalars().all())

    if not departments:
        logger.info(f"[routing] Report {report_id}: No departments for category '{category}'")
        return []

    # 5. Create routing rows
    matched_names = []
    for dept in departments:
        token = uuid.uuid4()
        routing = ReportRouting(
            report_id=report_id,
            department_id=dept.id,
            response_token=token,
        )
        db.add(routing)
        matched_names.append(dept.name)

    await db.commit()

    # 6. Fire notifications asynchronously (best-effort)
    for dept in departments:
        # Re-query to get the routing row with its token
        row_result = await db.execute(
            select(ReportRouting).where(
                and_(
                    ReportRouting.report_id == report_id,
                    ReportRouting.department_id == dept.id,
                )
            )
        )
        routing_row = row_result.scalar_one_or_none()
        if routing_row:
            asyncio.create_task(
                _send_notification(dept, report_id, routing_row.response_token, db)
            )

    logger.info(
        f"[routing] Report {report_id}: routed to {len(matched_names)} departments "
        f"({', '.join(matched_names)})"
    )
    return matched_names


async def _send_notification(dept, report_id, token, db):
    """Wrapper that imports email_service lazily to avoid circular imports."""
    try:
        from app.services.email_service import send_department_notification
        await send_department_notification(dept, report_id, token)

        # Mark notification as sent
        from sqlalchemy import update
        from datetime import datetime, timezone
        await db.execute(
            update(ReportRouting)
            .where(
                and_(
                    ReportRouting.report_id == report_id,
                    ReportRouting.department_id == dept.id,
                )
            )
            .values(
                notification_sent=True,
                notification_sent_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()
    except Exception as e:
        logger.error(f"[routing] Failed to notify {dept.name} for report {report_id}: {e}")


async def get_report_routing(
    report_id: str,
    db: AsyncSession,
) -> List[dict]:
    """
    Return all routing entries for a report.

    Includes department info but NEVER exposes response_token.
    """
    result = await db.execute(
        select(ReportRouting, Department)
        .join(Department, ReportRouting.department_id == Department.id)
        .where(ReportRouting.report_id == report_id)
        .order_by(ReportRouting.routed_at.asc())
    )

    entries = []
    for routing, dept in result.all():
        entries.append({
            "dept_name": dept.name,
            "short_name": dept.short_name,
            "status": routing.status,
            "department_response": routing.department_response,
            "responded_at": routing.responded_at.isoformat() if routing.responded_at else None,
            "routed_at": routing.routed_at.isoformat() if routing.routed_at else None,
            "notification_sent": routing.notification_sent,
        })

    return entries
