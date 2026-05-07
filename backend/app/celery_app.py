"""
C.O.V.E.R.T - Celery Worker Configuration

Periodic tasks:
  - dms-watchdog: every 30 minutes — checks for triggered Dead Man's Switches
  - sync-reviewer-roles: every 6 hours — grants/revokes REVIEWER_ROLE on-chain
  - check-scheduled-reports: every 15 minutes — publishes delayed reports

Start with:
  celery -A app.celery_app worker --beat --loglevel=info
"""

import logging
from celery import Celery
from celery.schedules import crontab
from app.core.config import settings

logger = logging.getLogger(__name__)

# ── Celery app ───────────────────────────────────────────────────────────────
celery = Celery(
    "covert",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
)

# ── Beat schedule ────────────────────────────────────────────────────────────
celery.conf.beat_schedule = {
    "dms-watchdog": {
        "task": "app.celery_app.dms_watchdog_task",
        "schedule": 30 * 60,  # every 30 minutes
    },
    "check-scheduled-reports": {
        "task": "app.celery_app.check_scheduled_reports_task",
        "schedule": 15 * 60,  # every 15 minutes
    },
    "check-followups": {
        "task": "app.celery_app.check_followups_task",
        "schedule": crontab(hour=9, minute=0),  # daily at 9:00 AM UTC
    },
}


# ── Tasks ────────────────────────────────────────────────────────────────────

@celery.task(name="app.celery_app.dms_watchdog_task")
def dms_watchdog_task():
    """
    Check for DMS entries whose trigger date has passed and release them.

    Runs the watchdog service's manual_trigger_check in a sync context
    by creating a fresh async event loop (Celery workers are sync by default).
    """
    import asyncio
    from app.core.database import async_session_maker
    from app.services.dms import watchdog_service

    async def _run():
        async with async_session_maker() as db:
            result = await watchdog_service.manual_trigger_check(db)
            logger.info(f"[celery] DMS watchdog: {result}")
            return result

    try:
        return asyncio.get_event_loop().run_until_complete(_run())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_run())
        finally:
            loop.close()


@celery.task(name="app.celery_app.check_scheduled_reports_task")
def check_scheduled_reports_task():
    """
    Find reports where scheduled_for <= now and chain_submitted = false,
    then mark them as chain_submitted = true so they become visible.

    In a production setup this would also trigger the on-chain commit
    via the automation key. For now it just flips the flag.
    """
    import asyncio
    from datetime import datetime, timezone
    from sqlalchemy import select, and_
    from app.core.database import async_session_maker
    from app.models.report import Report

    async def _run():
        async with async_session_maker() as db:
            now = datetime.now(timezone.utc)
            result = await db.execute(
                select(Report).where(
                    and_(
                        Report.chain_submitted.is_(False),
                        Report.scheduled_for <= now,
                        Report.deleted_at.is_(None),
                    )
                )
            )
            reports = list(result.scalars().all())

            published = []
            for report in reports:
                report.chain_submitted = True
                published.append(str(report.id))

            if published:
                await db.commit()

            logger.info(f"[celery] check-scheduled-reports: published {len(published)} reports")
            return {"published": published, "count": len(published)}

    try:
        return asyncio.get_event_loop().run_until_complete(_run())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_run())
        finally:
            loop.close()


@celery.task(name="app.celery_app.check_followups_task")
def check_followups_task():
    """
    Send followup emails to departments that haven't responded.

    - 1st followup after FOLLOWUP_DAYS days (default 7)
    - 2nd followup after another FOLLOWUP_DAYS days
    - Never sends a 3rd reminder (stops at followup_count=2)
    """
    import asyncio
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import select, and_
    from app.core.database import async_session_maker
    from app.models.routing import ReportRouting, Department
    from app.services.email_service import send_followup_notification

    followup_days = settings.FOLLOWUP_DAYS

    async def _run():
        async with async_session_maker() as db:
            now = datetime.now(timezone.utc)
            cutoff = now - timedelta(days=followup_days)
            sent = 0

            # Query all PENDING routing entries that have been notified
            result = await db.execute(
                select(ReportRouting, Department)
                .join(Department, ReportRouting.department_id == Department.id)
                .where(
                    and_(
                        ReportRouting.status == "PENDING",
                        ReportRouting.notification_sent.is_(True),
                        ReportRouting.followup_count < 2,
                    )
                )
            )
            rows = result.all()

            for routing, dept in rows:
                should_send = False
                followup_number = 0

                if routing.followup_count == 0 and routing.routed_at and routing.routed_at < cutoff:
                    should_send = True
                    followup_number = 1
                elif routing.followup_count == 1 and routing.last_followup_at and routing.last_followup_at < cutoff:
                    should_send = True
                    followup_number = 2

                if should_send:
                    await send_followup_notification(
                        dept, str(routing.report_id), routing.response_token, followup_number
                    )
                    routing.followup_count = followup_number
                    routing.last_followup_at = now
                    sent += 1

            if sent:
                await db.commit()

            logger.info(f"[celery] check-followups: Sent {sent} followup emails in this run.")
            return {"sent": sent}

    try:
        return asyncio.get_event_loop().run_until_complete(_run())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_run())
        finally:
            loop.close()
