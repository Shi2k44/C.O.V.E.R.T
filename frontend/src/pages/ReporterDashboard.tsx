/**
 * C.O.V.E.R.T - Reporter Dashboard Page
 *
 * Shown to all regular (non-reviewer, non-moderator) users.
 * Displays a live public-reports feed visible to every connected wallet.
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  DocumentPlusIcon,
  ClipboardDocumentListIcon,
  ArrowPathIcon,
  GlobeAltIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LockClosedIcon,
  HandThumbUpIcon,
  HandThumbDownIcon,
} from '@heroicons/react/24/outline';
import { mapApiReports } from '@/utils/reportMapper';
import { useWeb3 } from '@/hooks/useWeb3';
import { DashboardWelcome } from '@/components/DashboardWelcome';
import { EvidenceViewer } from '@/components/EvidenceViewer';
import { protocolService } from '@/services/protocol';
import { ethers } from 'ethers';
import { toast } from 'react-hot-toast';
import { useCovBalanceStore } from '@/stores/covBalanceStore';
import { STAKES } from '@/types/protocol';
import type { Report } from '@/stores/reportStore';
import { API_BASE } from '@/config';

// ─── Public feed item (expandable) ────────────────────────────────────────────

function PublicReportCard({ report, isConnected }: { report: Report; isConnected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [actioning, setActioning] = useState<'support' | 'challenge' | null>(null);
  // Local optimistic counts (initialise from report if we add those fields later)
  const [localSupports, setLocalSupports] = useState(0);
  const [localChallenges, setLocalChallenges] = useState(0);
  const [hasActed, setHasActed] = useState<'support' | 'challenge' | null>(null);

  const categoryLabel: Record<string, string> = {
    corruption: 'Corruption',
    fraud: 'Fraud',
    safety: 'Safety Violation',
    environment: 'Environmental',
    human_rights: 'Human Rights',
    other: 'Other',
  };

  const statusColor: Record<string, string> = {
    // v2 lifecycle statuses
    pending_review: 'text-yellow-400',
    needs_evidence: 'text-amber-400',
    rejected_by_reviewer: 'text-red-400',
    pending_moderation: 'text-blue-400',
    appealed: 'text-purple-400',
    verified: 'text-green-400',
    rejected: 'text-red-400',
    archived: 'text-neutral-500',
    // Legacy statuses
    pending: 'text-neutral-400',
    under_review: 'text-neutral-300',
    disputed: 'text-neutral-400',
  };

  const decisionLabelConfig: Record<string, { label: string; color: string }> = {
    CORROBORATED: { label: 'Corroborated', color: 'text-green-400 bg-green-900/30' },
    DISPUTED: { label: 'Disputed', color: 'text-orange-400 bg-orange-900/30' },
    NEEDS_EVIDENCE: { label: 'Needs Evidence', color: 'text-amber-400 bg-amber-900/30' },
    FALSE_OR_MANIPULATED: { label: 'False / Manipulated', color: 'text-red-400 bg-red-900/30' },
    REVIEW_PASSED: { label: 'Review Passed', color: 'text-blue-400 bg-blue-900/30' },
    REJECT_SPAM: { label: 'Rejected (Spam)', color: 'text-red-400 bg-red-900/30' },
  };

  // Evidence is always viewable — the EvidenceViewer handles auth/access checks internally
  const showEvidence = true;
  const hasEvidence = !!(report.commitmentHash && report.ipfsCid);

  const handleAction = useCallback(async (action: 'support' | 'challenge') => {
    if (!isConnected) { toast.error('Connect your wallet first'); return; }
    if (hasActed) { toast.error(`You already ${hasActed}ed this report`); return; }

    const requiredCov = action === 'support' ? STAKES.SUPPORT : STAKES.CHALLENGE;

    setActioning(action);
    try {
      await protocolService.connect();

      // Check COV balance before attempting the transaction
      const signerAddr = await protocolService.getSignerAddress();
      if (signerAddr) {
        const userState = await protocolService.getUserState(signerAddr);
        const covBalance = parseFloat(userState.covBalance);
        useCovBalanceStore.getState().setBalance(signerAddr, covBalance);

        if (covBalance < requiredCov) {
          toast.error(
            `Insufficient COV credits. You need ${requiredCov} COV to ${action} but your balance is ${covBalance.toFixed(2)} COV.`
          );
          return;
        }
      }

      // Find the on-chain report ID from the commitment hash
      const reportId = await protocolService.getReportIdByHash(report.commitmentHash);
      if (reportId === null) {
        toast.error('Report not found on-chain — cannot stake');
        return;
      }

      const reasonHash = ethers.keccak256(
        ethers.toUtf8Bytes(`${action}:${report.commitmentHash}:${Date.now()}`)
      );
      if (action === 'support') {
        await protocolService.supportReport(reportId, reasonHash);
        setLocalSupports(s => s + 1);
        toast.success('Support staked on-chain (1 COV)');
      } else {
        await protocolService.challengeReport(reportId, reasonHash);
        setLocalChallenges(c => c + 1);
        toast.success('Challenge staked on-chain (3 COV)');
      }
      setHasActed(action);

      // Sync updated balance after successful stake
      if (signerAddr) {
        const updated = await protocolService.getUserState(signerAddr);
        useCovBalanceStore.getState().setBalance(signerAddr, parseFloat(updated.covBalance));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      if (msg.includes('user rejected') || msg.includes('User denied')) {
        toast.error('Transaction rejected');
      } else if (msg.includes('0x43fb9453') || msg.toLowerCase().includes('insufficientcredits')) {
        toast.error('Insufficient COV credits for this action.');
      } else {
        toast.error(`Failed to ${action}: ${msg}`);
      }
    } finally {
      setActioning(null);
    }
  }, [isConnected, hasActed, report.commitmentHash]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950 overflow-hidden">
      {/* Clickable header row */}
      <div
        className="p-4 cursor-pointer hover:bg-neutral-900/50 transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">
              {report.title || `Report #${report.id.slice(0, 8)}`}
            </p>
            {report.description && !expanded && (
              <p className="text-xs text-neutral-500 mt-0.5 line-clamp-2 leading-relaxed">
                {report.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            {/* Support / Challenge counts */}
            {(localSupports > 0 || localChallenges > 0) && (
              <>
                <span className="flex items-center gap-0.5 text-xs text-neutral-300">
                  <HandThumbUpIcon className="h-3.5 w-3.5" />
                  {localSupports}
                </span>
                <span className="flex items-center gap-0.5 text-xs text-red-400">
                  <HandThumbDownIcon className="h-3.5 w-3.5" />
                  {localChallenges}
                </span>
              </>
            )}
            {/* Decision label badge */}
            {(report.finalLabel || report.reviewDecisionLabel) && (() => {
              const key = report.finalLabel || report.reviewDecisionLabel || '';
              const cfg = decisionLabelConfig[key];
              if (!cfg) return null;
              return (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${cfg.color}`}>
                  {cfg.label}
                </span>
              );
            })()}
            <span className={`text-xs font-medium capitalize ${statusColor[report.status] ?? 'text-neutral-400'}`}>
              {report.status.replace(/_/g, ' ')}
            </span>
            {expanded
              ? <ChevronUpIcon className="h-4 w-4 text-neutral-500" />
              : <ChevronDownIcon className="h-4 w-4 text-neutral-500" />
            }
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-600 mt-1.5">
          <span>{categoryLabel[report.category] ?? report.category}</span>
          <span>·</span>
          <span>{new Date(report.submittedAt).toLocaleDateString()}</span>
          {report.fileSize > 0 && (
            <>
              <span>·</span>
              <span>
                {report.fileSize < 1024 * 1024
                  ? `${(report.fileSize / 1024).toFixed(1)} KB`
                  : `${(report.fileSize / (1024 * 1024)).toFixed(1)} MB`}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-neutral-800/60 pt-3 space-y-3">
          {/* Full description */}
          {report.description && (
            <p className="text-sm text-neutral-300 leading-relaxed">{report.description}</p>
          )}

          {/* IPFS CID */}
          {report.ipfsCid && (
            <div className="flex items-start gap-2">
              <span className="text-xs text-neutral-600 mt-0.5 shrink-0">IPFS:</span>
              <code className="text-xs font-mono text-neutral-500 break-all">{report.ipfsCid}</code>
            </div>
          )}

          {/* Evidence viewer — visible if public, or after decision for private/moderated */}
          {hasEvidence && showEvidence && (
            <EvidenceViewer
              contentHash={report.commitmentHash}
              cid={report.ipfsCid}
              visibility={report.visibility}
            />
          )}

          {/* Locked message when decision not yet reached */}
          {hasEvidence && !showEvidence && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3 flex items-center gap-3">
              <LockClosedIcon className="h-4 w-4 text-neutral-500 shrink-0" />
              <p className="text-xs text-neutral-500">
                Evidence will be visible once reviewers and moderators have reached a decision.
              </p>
            </div>
          )}

          {/* Support / Challenge — only for logged-in users */}
          {isConnected && (
            <div className="flex items-center gap-2 pt-1 border-t border-neutral-800/50">
              <p className="text-xs text-neutral-600 mr-1">Community:</p>
              <button
                onClick={(e) => { e.stopPropagation(); handleAction('support'); }}
                disabled={!!actioning || hasActed === 'challenge'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40 ${
                  hasActed === 'support'
                    ? 'bg-green-900/40 text-green-400 border border-green-900/50'
                    : 'bg-neutral-800 text-neutral-300 border border-neutral-700 hover:border-green-700 hover:text-green-400'
                }`}
              >
                {actioning === 'support'
                  ? <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                  : <HandThumbUpIcon className="h-3.5 w-3.5" />
                }
                Support{localSupports > 0 ? ` (${localSupports})` : ''} · 1 COV
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleAction('challenge'); }}
                disabled={!!actioning || hasActed === 'support'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40 ${
                  hasActed === 'challenge'
                    ? 'bg-red-900/40 text-red-400 border border-red-900/50'
                    : 'bg-neutral-800 text-neutral-300 border border-neutral-700 hover:border-red-700 hover:text-red-400'
                }`}
              >
                {actioning === 'challenge'
                  ? <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                  : <HandThumbDownIcon className="h-3.5 w-3.5" />
                }
                Challenge{localChallenges > 0 ? ` (${localChallenges})` : ''} · 3 COV
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export function ReporterDashboard() {
  const { walletState } = useWeb3();

  const [publicReports, setPublicReports] = useState<Report[]>([]);
  const [publicLoading, setPublicLoading] = useState(true);
  const [publicTotal, setPublicTotal] = useState(0);

  const isConnected = walletState.connected;

  // ── Fetch public report feed (logged-in users only) ──
  const fetchPublic = useCallback(async () => {
    if (!walletState.connected) return;
    setPublicLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE}/api/v1/reports/public?limit=20`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setPublicReports(mapApiReports(data.items || []));
        setPublicTotal(data.total ?? 0);
      }
    } catch {
      // ignore
    } finally {
      setPublicLoading(false);
    }
  }, [walletState.connected]);

  useEffect(() => {
    fetchPublic();
  }, [fetchPublic]);

  // When wallet disconnects, clear the feed
  useEffect(() => {
    if (!isConnected) {
      setPublicReports([]);
      setPublicTotal(0);
      setPublicLoading(false);
    }
  }, [isConnected]);

  // Re-fetch public feed when a reviewer or moderator records a decision
  useEffect(() => {
    window.addEventListener('covert:reports-updated', fetchPublic);
    return () => window.removeEventListener('covert:reports-updated', fetchPublic);
  }, [fetchPublic]);

  // Poll public feed every 30s for cross-browser updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') fetchPublic();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchPublic]);

  const visibleReports = publicReports;

  return (
    <div className="space-y-8">
      <DashboardWelcome role="user" walletAddress={walletState.address ?? ''} />

      {/* Quick Actions */}
      <div className="flex gap-3">
        <Link
          to="/submit"
          className="inline-flex items-center px-5 py-2.5 rounded-full font-medium transition-all duration-300 hover:opacity-90"
          style={{ backgroundColor: '#E84B1A', color: '#fff' }}
        >
          <DocumentPlusIcon className="h-5 w-5 mr-2" />
          Submit New Report
        </Link>
        <Link
          to="/my-reports"
          className="inline-flex items-center px-5 py-2.5 border border-neutral-700 text-neutral-300 rounded-full font-medium hover:border-neutral-500 hover:text-white transition-all duration-300"
        >
          <ClipboardDocumentListIcon className="h-5 w-5 mr-2" />
          My Reports
        </Link>
      </div>

      {/* Public Reports Feed — visible to all users */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-950">
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GlobeAltIcon className="h-5 w-5 text-neutral-400" />
            <h2 className="text-base font-semibold text-white">Public Reports</h2>
            {publicTotal > 0 && (
              <span className="text-xs text-neutral-500 ml-1">({publicTotal} total)</span>
            )}
          </div>
          <button
            onClick={fetchPublic}
            disabled={publicLoading}
            className="p-1.5 rounded-lg border border-neutral-800 text-neutral-500 hover:text-white hover:border-neutral-600 transition-colors disabled:opacity-40"
          >
            <ArrowPathIcon className={`h-4 w-4 ${publicLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="p-4">
          {!isConnected ? (
            <div className="text-center py-10">
              <LockClosedIcon className="h-10 w-10 text-neutral-700 mx-auto mb-3" />
              <p className="text-neutral-400 text-sm font-medium">Connect your wallet to view public reports</p>
              <p className="text-xs text-neutral-600 mt-1">
                Public reports are visible to all registered wallet holders.
              </p>
            </div>
          ) : publicLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="animate-pulse bg-neutral-900 rounded-xl h-16" />
              ))}
            </div>
          ) : visibleReports.length > 0 ? (
            <div className="space-y-3">
              {visibleReports.map((report) => (
                <PublicReportCard key={report.id} report={report} isConnected={isConnected} />
              ))}
            </div>
          ) : (
            <div className="text-center py-10">
              <GlobeAltIcon className="h-10 w-10 text-neutral-700 mx-auto mb-3" />
              <p className="text-neutral-500 text-sm">No public reports yet</p>
              <p className="text-xs text-neutral-600 mt-1">
                Reports submitted with <span className="text-neutral-400">Public</span> visibility appear here.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ReporterDashboard;
