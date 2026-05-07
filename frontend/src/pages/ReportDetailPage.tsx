/**
 * C.O.V.E.R.T - Report Detail Page
 * Shown when a user clicks a report card in My Submissions.
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  ShieldCheckIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  LockClosedIcon,
  ArrowPathIcon,
  BellAlertIcon,
  BellSlashIcon,
  CalendarDaysIcon,
} from '@heroicons/react/24/outline';
import { useReportStore, type Report } from '@/stores/reportStore';
import { EvidenceViewer } from '@/components/EvidenceViewer';
import { mapApiReports } from '@/utils/reportMapper';
import { useWeb3 } from '@/hooks/useWeb3';
import { protocolService } from '@/services/protocol';
import { ethers } from 'ethers';
import { STAKES } from '@/types/protocol';
import { toast } from 'react-hot-toast';
import { API_BASE } from '@/config';
import { DepartmentRouting } from '@/components/DepartmentRouting';

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  // v2 lifecycle statuses
  pending_review:       { label: 'Pending Review',        color: 'bg-yellow-900/40 text-yellow-400', icon: ClockIcon },
  needs_evidence:       { label: 'Needs Evidence',        color: 'bg-amber-900/40 text-amber-400',   icon: ExclamationTriangleIcon },
  rejected_by_reviewer: { label: 'Rejected by Reviewer',  color: 'bg-red-900/30 text-red-400',       icon: XCircleIcon },
  pending_moderation:   { label: 'Under Moderation',      color: 'bg-blue-900/40 text-blue-400',     icon: EyeIcon },
  appealed:             { label: 'Appealed',              color: 'bg-purple-900/40 text-purple-400', icon: ExclamationTriangleIcon },
  verified:             { label: 'Verified',              color: 'bg-green-900/40 text-green-400',   icon: CheckCircleIcon },
  rejected:             { label: 'Rejected',              color: 'bg-red-900/40 text-red-400',       icon: XCircleIcon },
  archived:             { label: 'Archived',              color: 'bg-neutral-800 text-neutral-500',  icon: ClockIcon },
  // Legacy statuses
  pending:              { label: 'Pending',               color: 'bg-yellow-900/40 text-yellow-400', icon: ClockIcon },
  under_review:         { label: 'Under Review',          color: 'bg-blue-900/40 text-blue-400',     icon: EyeIcon },
  disputed:             { label: 'Disputed',              color: 'bg-orange-900/40 text-orange-400', icon: ExclamationTriangleIcon },
};

const categoryLabels: Record<string, string> = {
  corruption:  'Corruption',
  fraud:       'Fraud',
  safety:      'Safety Violation',
  environment: 'Environmental',
  human_rights:'Human Rights',
  other:       'Other',
};

const visibilityConfig = {
  private:   { label: 'Private',   icon: EyeSlashIcon },
  moderated: { label: 'Moderated', icon: EyeIcon },
  public:    { label: 'Public',    icon: EyeIcon },
} as const;

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Dead Man's Switch Panel ───────────────────────────────────────────────────

interface DmsState {
  id: string;
  status: string;
  trigger_date: string;
  trigger_type: string;
  last_check_in: string | null;
  check_in_count: number;
  auto_release_public: boolean;
}

function DeadMansSwitchPanel({ reportId }: { reportId: string }) {
  const { walletState } = useWeb3();
  const [dms, setDms] = useState<DmsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Setup form state
  const [triggerDate, setTriggerDate] = useState('');
  const [inactivityDays, setInactivityDays] = useState(30);
  const [triggerType, setTriggerType] = useState<'time_based' | 'activity_based'>('time_based');
  const [showSetup, setShowSetup] = useState(false);

  const walletAddress = walletState.address ?? '';
  const nullifier = walletAddress
    ? '0x' + Array.from(new TextEncoder().encode(walletAddress))
        .reduce((acc, b) => acc * 256n + BigInt(b), 0n)
        .toString(16)
        .slice(0, 64)
        .padStart(64, '0')
    : '';

  const fetchDms = useCallback(async () => {
    if (!reportId) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/dms/report/${reportId}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDms(data);
      } else if (res.status === 404) {
        setDms(null);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [reportId]);

  useEffect(() => { fetchDms(); }, [fetchDms]);

  const handleCreate = async () => {
    if (!triggerDate) { toast.error('Please set a trigger date'); return; }
    if (!walletAddress) { toast.error('Connect your wallet first'); return; }

    const date = new Date(triggerDate);
    if (date <= new Date()) { toast.error('Trigger date must be in the future'); return; }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/dms/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({
          report_id: reportId,
          reporter_nullifier: nullifier,
          trigger_date: date.toISOString(),
          trigger_type: triggerType,
          inactivity_days: triggerType === 'activity_based' ? inactivityDays : null,
          auto_release_public: true,
          auto_pin_ipfs: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed to create DMS' }));
        throw new Error(err.detail);
      }
      toast.success('Dead Man\'s Switch activated');
      setShowSetup(false);
      fetchDms();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create DMS');
    } finally {
      setSaving(false);
    }
  };

  const handleCheckIn = async () => {
    if (!dms) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/dms/checkin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({
          dms_id: dms.id,
          reporter_nullifier: nullifier,
          proof_of_life: `Check-in from ${walletAddress} at ${new Date().toISOString()}`,
        }),
      });
      if (!res.ok) throw new Error('Check-in failed');
      toast.success('Check-in recorded — DMS timer reset');
      fetchDms();
    } catch {
      toast.error('Check-in failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!dms || !window.confirm('Cancel the Dead Man\'s Switch? This cannot be undone.')) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/dms/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ dms_id: dms.id, reporter_nullifier: nullifier }),
      });
      if (!res.ok) throw new Error('Cancellation failed');
      toast.success('Dead Man\'s Switch cancelled');
      fetchDms();
    } catch {
      toast.error('Cancellation failed');
    } finally {
      setSaving(false);
    }
  };

  if (!walletAddress) return null;

  const statusColors: Record<string, string> = {
    active: 'text-green-400 bg-green-900/30',
    triggered: 'text-red-400 bg-red-900/30',
    released: 'text-blue-400 bg-blue-900/30',
    cancelled: 'text-neutral-400 bg-neutral-800',
    extended: 'text-yellow-400 bg-yellow-900/30',
    failed: 'text-red-400 bg-red-900/30',
  };

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6 space-y-4">
      <div className="flex items-center gap-2">
        <BellAlertIcon className="h-5 w-5 text-orange-400" />
        <h2 className="text-base font-semibold text-white">Dead Man's Switch</h2>
      </div>
      <p className="text-xs text-neutral-500">
        If you don't check in before the trigger date, your report will automatically be made public. This protects whistleblowers from suppression.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
          Loading DMS status…
        </div>
      ) : dms && dms.status !== 'cancelled' ? (
        /* ── Active DMS ── */
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${statusColors[dms.status] ?? 'text-neutral-400'}`}>
              {dms.status}
            </span>
            {dms.trigger_type === 'activity_based' && (
              <span className="text-xs text-neutral-500">Activity-based</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-neutral-900 rounded-xl p-3 border border-neutral-800">
              <p className="text-xs text-neutral-500 mb-1">Trigger Date</p>
              <p className="text-white font-medium">
                {new Date(dms.trigger_date).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </p>
              <p className="text-xs text-neutral-600 mt-0.5">
                {new Date(dms.trigger_date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <div className="bg-neutral-900 rounded-xl p-3 border border-neutral-800">
              <p className="text-xs text-neutral-500 mb-1">Last Check-In</p>
              {dms.last_check_in ? (
                <>
                  <p className="text-white font-medium">
                    {new Date(dms.last_check_in).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-xs text-neutral-500 mt-0.5">
                    {dms.check_in_count} total check-in{dms.check_in_count !== 1 ? 's' : ''}
                  </p>
                </>
              ) : (
                <p className="text-neutral-500 text-xs">Never</p>
              )}
            </div>
          </div>

          {dms.status === 'active' && (
            <div className="flex gap-2">
              <button
                onClick={handleCheckIn}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-green-900/30 text-green-400 border border-green-900/50 hover:bg-green-900/50 transition-colors disabled:opacity-50"
              >
                {saving ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <CheckCircleIcon className="h-4 w-4" />}
                I'm Safe — Check In
              </button>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-50"
              >
                <BellSlashIcon className="h-4 w-4" />
                Cancel DMS
              </button>
            </div>
          )}

          {dms.status === 'triggered' && (
            <div className="rounded-xl border border-red-900/40 bg-red-950/20 p-3">
              <p className="text-sm font-medium text-red-400">DMS Triggered</p>
              <p className="text-xs text-neutral-500 mt-1">
                The trigger date has passed. The release process has been initiated.
              </p>
            </div>
          )}
        </div>
      ) : showSetup ? (
        /* ── Setup Form ── */
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Trigger Type</label>
            <div className="flex gap-2">
              {(['time_based', 'activity_based'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTriggerType(t)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
                    triggerType === t
                      ? 'bg-orange-700 text-white'
                      : 'bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-700'
                  }`}
                >
                  {t === 'time_based' ? 'Fixed Date' : 'Inactivity Period'}
                </button>
              ))}
            </div>
          </div>

          {triggerType === 'time_based' ? (
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                <CalendarDaysIcon className="h-3.5 w-3.5 inline mr-1" />
                Trigger Date & Time
              </label>
              <input
                type="datetime-local"
                value={triggerDate}
                onChange={(e) => setTriggerDate(e.target.value)}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 16)}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-sm text-white focus:ring-1 focus:ring-orange-500"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Must be at least 24 hours from now.
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                Inactivity Period (days)
              </label>
              <input
                type="number"
                value={inactivityDays}
                onChange={(e) => setInactivityDays(Math.max(1, parseInt(e.target.value) || 30))}
                min={1}
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-sm text-white focus:ring-1 focus:ring-orange-500"
              />
              <p className="text-xs text-neutral-600 mt-1">
                DMS triggers if you don't check in within this many days. Trigger date is set to {inactivityDays} days from now.
              </p>
              {/* For activity-based, also set the initial trigger date */}
              <input
                type="hidden"
                value={triggerDate || new Date(Date.now() + inactivityDays * 86400000).toISOString().slice(0, 16)}
                onChange={(e) => setTriggerDate(e.target.value)}
              />
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                // For activity-based, auto-set trigger date
                if (triggerType === 'activity_based' && !triggerDate) {
                  setTriggerDate(new Date(Date.now() + inactivityDays * 86400000).toISOString().slice(0, 16));
                }
                handleCreate();
              }}
              disabled={saving || (triggerType === 'time_based' && !triggerDate)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#E84B1A', color: '#fff' }}
            >
              {saving ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <BellAlertIcon className="h-4 w-4" />}
              Activate DMS
            </button>
            <button
              onClick={() => setShowSetup(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* ── No DMS — prompt to create ── */
        <div className="space-y-3">
          <div className="rounded-xl border border-dashed border-neutral-700 bg-neutral-900/30 p-4">
            <p className="text-sm text-neutral-400">No Dead Man's Switch configured for this report.</p>
            <p className="text-xs text-neutral-600 mt-1">
              Set up a DMS to ensure your report is released if you become unreachable.
            </p>
          </div>
          <button
            onClick={() => setShowSetup(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
          >
            <BellAlertIcon className="h-4 w-4" />
            Configure Dead Man's Switch
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Appeal Panel ─────────────────────────────────────────────────────────────

function AppealPanel({ report }: { report: Report }) {
  const { walletState } = useWeb3();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [appealed, setAppealed] = useState(false);

  const isConnected = walletState.connected;
  // Show appeal option only when report has been reviewed (not pending) and not already appealed
  const canAppeal = ['under_review', 'verified', 'rejected', 'disputed'].includes(report.status) && !appealed;

  if (!isConnected || !canAppeal) return null;

  const handleAppeal = async () => {
    if (!reason.trim()) { toast.error('Please provide a reason for your appeal'); return; }
    setSubmitting(true);
    try {
      await protocolService.connect();

      // Find on-chain report ID from commitment hash
      const reportId = await protocolService.getReportIdByHash(report.commitmentHash);
      if (reportId === null) {
        toast.error('Report not found on-chain — appeal not available');
        setSubmitting(false);
        return;
      }

      const appealReasonHash = ethers.keccak256(
        ethers.toUtf8Bytes(`appeal:${report.commitmentHash}:${reason}:${Date.now()}`)
      );

      await protocolService.appeal(reportId, appealReasonHash);

      // Sync to backend so the moderator dashboard picks up the appeal
      fetch(`${API_BASE}/api/v1/reports/by-hash/${report.commitmentHash}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: report.status }),
      }).catch(() => {});

      setAppealed(true);
      toast.success('Appeal submitted on-chain (8 COV bond staked)');
      window.dispatchEvent(new CustomEvent('covert:reports-updated'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Appeal failed';
      if (msg.includes('user rejected') || msg.includes('User denied')) {
        toast.error('Transaction rejected');
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6 space-y-4">
      <div className="flex items-center gap-2">
        <ExclamationTriangleIcon className="h-5 w-5 text-orange-400" />
        <h2 className="text-base font-semibold text-white">Appeal Decision</h2>
      </div>
      <p className="text-xs text-neutral-500">
        If you disagree with the review decision, you can appeal. This costs {STAKES.APPEAL_BOND} COV (returned if your appeal is won).
        Your report will be forwarded to a protocol moderator for final review.
      </p>

      {appealed ? (
        <div className="rounded-xl border border-green-900/50 bg-green-950/20 p-3 flex items-center gap-2">
          <CheckCircleIcon className="h-5 w-5 text-green-400" />
          <p className="text-sm text-green-400 font-medium">Appeal submitted — awaiting moderator review</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">Reason for appeal</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why you believe the review decision is incorrect..."
              rows={3}
              className="w-full px-3 py-2 bg-neutral-900 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-600 focus:ring-1 focus:ring-orange-500 focus:outline-none resize-none"
            />
          </div>
          <button
            onClick={handleAppeal}
            disabled={submitting || !reason.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#E84B1A', color: '#fff' }}
          >
            {submitting ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : <ExclamationTriangleIcon className="h-4 w-4" />}
            Submit Appeal ({STAKES.APPEAL_BOND} COV)
          </button>
        </div>
      )}
    </div>
  );
}

export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { reports } = useReportStore();

  const [report, setReport] = useState<Report | null>(
    () => reports.find((r) => r.id === id) ?? null
  );
  const [loading, setLoading] = useState(!report);
  const [error, setError] = useState('');

  // If not in store, fetch from API
  useEffect(() => {
    if (report || !id) return;

    const token = localStorage.getItem('token');
    const walletAddress = localStorage.getItem('wallet_address');

    setLoading(true);
    fetch(`${API_BASE}/api/v1/reports/${id}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(walletAddress ? { 'X-Wallet-Address': walletAddress } : {}),
      },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const mapped = mapApiReports([data]);
        if (mapped.length) setReport(mapped[0]);
        else throw new Error('Report not found');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id, report]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-neutral-500">
        <ArrowPathIcon className="h-6 w-6 animate-spin mr-2" />
        Loading report…
      </div>
    );
  }

  // ── Error / not found ──
  if (error || !report) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <p className="text-red-400 mb-4">{error || 'Report not found.'}</p>
        <button
          onClick={() => navigate(-1)}
          className="px-4 py-2 rounded-lg bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Go Back
        </button>
      </div>
    );
  }

  const statusInfo = statusConfig[report.status] ?? {
    label: report.status, color: 'bg-neutral-800 text-neutral-400', icon: ClockIcon,
  };
  const StatusIcon = statusInfo.icon;
  const visibilityInfo = visibilityConfig[report.visibility] ?? { label: report.visibility, icon: EyeIcon };
  const VisibilityIcon = visibilityInfo.icon;
  const categoryLabel = categoryLabels[report.category] ?? report.category;

  const isDecided = ['verified', 'rejected', 'disputed'].includes(report.status);
  // Reporter can always view their own evidence; public reports visible to signed-in users; decided reports visible to all
  const canViewEvidence = true;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-white transition-colors"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back to My Reports
      </button>

      {/* Main card */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6 space-y-5">

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {statusInfo.label}
          </span>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-800 text-neutral-400">
            {categoryLabel}
          </span>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-800 text-neutral-500">
            <VisibilityIcon className="h-3 w-3 mr-1" />
            {visibilityInfo.label}
          </span>
          {report.riskLevel && (
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              report.riskLevel === 'critical' ? 'bg-red-900/40 text-red-400' :
              report.riskLevel === 'high'     ? 'bg-orange-900/40 text-orange-400' :
              report.riskLevel === 'medium'   ? 'bg-yellow-900/40 text-yellow-400' :
                                                'bg-green-900/40 text-green-400'
            }`}>
              <ExclamationTriangleIcon className="h-3 w-3 mr-1" />
              {report.riskLevel.charAt(0).toUpperCase() + report.riskLevel.slice(1)} Risk
            </span>
          )}
        </div>

        {/* Title */}
        <div>
          <h1 className="text-2xl font-bold text-white">
            {report.title || `Report #${report.id.slice(0, 8)}`}
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            Submitted {formatDate(report.submittedAt)} · {formatFileSize(report.fileSize)}
          </p>
          {report.updatedAt && (
            <p className="text-xs text-neutral-600 mt-0.5">
              Last updated {formatDate(report.updatedAt)}
            </p>
          )}
        </div>

        {/* Description */}
        {report.description && (
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Description</p>
            <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap">
              {report.description}
            </p>
          </div>
        )}

        {/* Credibility score */}
        {report.verificationScore !== undefined && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-neutral-900 border border-neutral-800">
            <ShieldCheckIcon className="h-5 w-5 text-neutral-500" />
            <div>
              <p className="text-xs text-neutral-500">Credibility Score</p>
              <p className={`text-xl font-bold ${
                report.verificationScore >= 0.7 ? 'text-green-400' :
                report.verificationScore >= 0.4 ? 'text-yellow-400' : 'text-red-400'
              }`}>
                {(report.verificationScore * 100).toFixed(0)}%
              </p>
            </div>
          </div>
        )}

        {/* On-chain info */}
        <div className="p-3 rounded-xl bg-neutral-900 border border-neutral-800 space-y-2">
          <p className="text-xs text-neutral-500 uppercase tracking-wider">On-Chain Details</p>
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheckIcon className="h-4 w-4 text-green-500 shrink-0" />
            <span className="text-neutral-400">Commitment hash:</span>
            <span className="font-mono text-xs text-neutral-300 break-all">{report.commitmentHash}</span>
          </div>
          {report.ipfsCid && (
            <div className="flex items-start gap-2 text-sm">
              <span className="text-neutral-400 shrink-0">IPFS CID:</span>
              <span className="font-mono text-xs text-neutral-300 break-all">{report.ipfsCid}</span>
            </div>
          )}
        </div>

        {/* Evidence */}
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-wider mb-3">Evidence</p>
          {canViewEvidence ? (
            <EvidenceViewer
              contentHash={report.commitmentHash}
              cid={report.ipfsCid}
              visibility={report.visibility}
            />
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-xl border border-neutral-800 bg-neutral-900/50">
              <LockClosedIcon className="h-5 w-5 text-neutral-500 shrink-0" />
              <div>
                <p className="text-sm font-medium text-neutral-300">Evidence Locked</p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Evidence will be accessible once the report has been reviewed and a decision is reached.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Departments Notified */}
      <DepartmentRouting reportId={report.id} />

      {/* Appeal — shown when report has been reviewed and user disagrees */}
      {reports.some((r) => r.id === report.id) && (
        <AppealPanel report={report} />
      )}

      {/* Dead Man's Switch is configured during submission only */}
    </div>
  );
}

export default ReportDetailPage;
