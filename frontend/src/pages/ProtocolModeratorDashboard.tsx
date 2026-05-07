/**
 * C.O.V.E.R.T - Protocol Moderator Dashboard (Full Feature Build)
 *
 * Tabs:
 *   Queue        – priority-sorted report queue with sort/filter controls
 *   Appeals      – dedicated view for reports with active appeals
 *   Flagged      – wallets with active strikes (from backend)
 *   Reviewers    – high-rep reviewer candidates (from backend)
 *   Log          – finalized reports (audit log)
 *
 * Per-report features:
 *   • Real supporter / challenger address lists (from chain, lazy-loaded on expand)
 *   • Actor deep-dive slide-over (click any wallet → rep / tier / strikes)
 *   • Rep impact preview (live update as label / appeal / malicious set changes)
 *   • Moderator notes (saved to backend)
 *   • Confirm-before-finalize modal (settlement + rep effects summary)
 *   • Batch finalization (checkbox-select multiple pending reports)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    ScaleIcon, FlagIcon, ExclamationTriangleIcon, CheckCircleIcon,
    UserGroupIcon, ArrowPathIcon, ChevronDownIcon, ShieldCheckIcon,
    FireIcon, XMarkIcon, DocumentTextIcon, ChartBarIcon,
    MagnifyingGlassIcon, ClockIcon, AdjustmentsHorizontalIcon,
    CheckBadgeIcon, BoltIcon,
} from '@heroicons/react/24/outline';
import { useWeb3 } from '@/hooks/useWeb3';
import { useRoleAccess } from '@/hooks/useRoleAccess';
import { EvidenceViewer } from '@/components/EvidenceViewer';
import {
    FinalLabel, ReviewerDecision, AppealOutcome,
    FINAL_LABEL_NAMES, FINAL_LABEL_COLORS,
    REVIEWER_DECISION_NAMES, APPEAL_OUTCOME_NAMES, STAKES,
} from '@/types/protocol';
import toast from 'react-hot-toast';
import { protocolService } from '@/services/protocol';
import { formatEther } from 'ethers';
import { API_BASE } from '@/config';

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = 'queue' | 'appeals' | 'flagged' | 'log';
type SortKey = 'oldest' | 'newest' | 'most_cov' | 'most_disputes';
type FilterKey = 'pending' | 'appealed' | 'all' | 'finalized';

interface ModerableReport {
    id: number;
    reporter: string;
    visibility: 'PUBLIC' | 'PRIVATE';
    contentHash: string;
    finalLabel: FinalLabel;
    reviewDecision: ReviewerDecision;
    createdAt: number;
    reviewedAt: number;
    supportCount: number;
    challengeCount: number;
    supporters: string[];
    challengers: string[];
    hasAppeal: boolean;
    appealReasonHash: string;
    stake: number;
    appealBond: number;
    lockedReportStake: bigint;
    /** Original DB status — only set when reports come from DB fallback, not blockchain */
    dbStatus?: string;
}

interface WalletRepData {
    reputation_score: number;
    tier: string;
    total_reviews: number;
    accuracy_rate: number;
    is_active: boolean;
}

interface FlaggedUser {
    wallet_address: string;
    reputation_score: number;
    tier: string;
    strikes: number;
    last_strike_at: string | null;
    last_slash_at: string | null;
}

interface ReviewerCandidate {
    wallet_address: string;
    reputation_score: number;
    tier: string;
    account_age_days: number;
    active_strikes: number;
    slash_ok: boolean;
}

// ── Rep impact constants (spec §4) ─────────────────────────────────────────────

const REPORTER_DELTA: Record<number, number> = {
    [FinalLabel.CORROBORATED]: 8,
    [FinalLabel.NEEDS_EVIDENCE]: 0,
    [FinalLabel.DISPUTED]: -2,
    [FinalLabel.FALSE_OR_MANIPULATED]: -10,
};
const SUPPORTER_DELTA: Record<number, number> = {
    [FinalLabel.CORROBORATED]: 1,
    [FinalLabel.FALSE_OR_MANIPULATED]: -2,
};
const CHALLENGER_DELTA: Record<number, number> = {
    [FinalLabel.FALSE_OR_MANIPULATED]: 2,
    [FinalLabel.DISPUTED]: 2,
    [FinalLabel.NEEDS_EVIDENCE]: 1,
    [FinalLabel.CORROBORATED]: -2,
};
const APPEAL_DELTA: Record<number, number> = {
    [AppealOutcome.APPEAL_WON]: 2,
    [AppealOutcome.APPEAL_LOST]: 0,
    [AppealOutcome.APPEAL_ABUSIVE]: -5,
};

function reporterRepDelta(label: FinalLabel, appeal: AppealOutcome, isMalicious: boolean): number {
    let d = REPORTER_DELTA[label] ?? 0;
    if (label === FinalLabel.FALSE_OR_MANIPULATED) d -= 5; // slash penalty
    if (appeal !== AppealOutcome.NONE) d += APPEAL_DELTA[appeal] ?? 0;
    if (isMalicious) d -= 5; // malicious penalty
    return d;
}
function supporterRepDelta(label: FinalLabel, isMalicious: boolean): number {
    let d = SUPPORTER_DELTA[label] ?? 0;
    if (label === FinalLabel.FALSE_OR_MANIPULATED) d -= 5; // slash
    if (isMalicious) d -= 5;
    return d;
}
function challengerRepDelta(label: FinalLabel, isMalicious: boolean): number {
    let d = CHALLENGER_DELTA[label] ?? 0;
    if (isMalicious) d -= 5;
    return d;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function truncAddr(addr: string): string {
    if (addr.length <= 13) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatTimeAgo(timestamp: number): string {
    const s = Math.floor(Date.now() / 1000 - timestamp);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function totalCovAtRisk(r: ModerableReport): number {
    return r.stake + r.supportCount * STAKES.SUPPORT + r.challengeCount * STAKES.CHALLENGE + r.appealBond;
}

function deltaColor(d: number): string {
    if (d > 0) return 'text-white';
    if (d < 0) return 'text-neutral-400';
    return 'text-neutral-500';
}

function DeltaBadge({ delta }: { delta: number }) {
    return (
        <span className={`text-xs font-bold tabular-nums ${deltaColor(delta)}`}>
            {delta > 0 ? `+${delta}` : delta}
        </span>
    );
}

const TIER_LABELS: Record<string, string> = {
    tier_0: 'Tier 0', tier_1: 'Tier 1', tier_2: 'Tier 2', tier_3: 'Tier 3', user: '—',
};

// ── Actor Deep-Dive slide-over ─────────────────────────────────────────────────

function ActorDeepDivePanel({ wallet, onClose }: { wallet: string; onClose: () => void }) {
    const [data, setData] = useState<WalletRepData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/v1/reputation/wallet/${wallet}`);
                if (!res.ok) throw new Error();
                const json = await res.json();
                if (!cancelled) setData(json);
            } catch { /* ignore */ } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [wallet]);

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            <div className="fixed inset-0 bg-black/60" onClick={onClose} />
            <div className="relative w-72 h-full bg-neutral-950 shadow-2xl border-l border-neutral-800 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
                    <h3 className="font-semibold text-white text-sm">Wallet Profile</h3>
                    <button onClick={onClose} className="text-neutral-500 hover:text-white">
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    <code className="text-xs text-neutral-500 break-all block bg-neutral-900 px-2 py-1 rounded border border-neutral-800">
                        {wallet}
                    </code>
                    {loading ? (
                        <div className="space-y-2 animate-pulse">
                            {[1, 2, 3].map(i => <div key={i} className="h-12 bg-neutral-900 rounded-lg" />)}
                        </div>
                    ) : data ? (
                        <div className="space-y-3">
                            <div className="bg-neutral-900 rounded-lg p-3 flex items-center justify-between border border-neutral-800">
                                <div>
                                    <p className="text-xs text-neutral-500 mb-0.5">Reputation</p>
                                    <p className="text-2xl font-bold text-white">{data.reputation_score}</p>
                                </div>
                                <ChartBarIcon className="w-8 h-8 text-neutral-700" />
                            </div>
                            <div className="bg-neutral-900 rounded-lg p-3 border border-neutral-800">
                                <p className="text-xs text-neutral-500 mb-0.5">Tier</p>
                                <p className="font-semibold text-white">
                                    {TIER_LABELS[data.tier] ?? data.tier}
                                </p>
                            </div>
                            {data.total_reviews > 0 && (
                                <div className="bg-neutral-900 rounded-lg p-3 border border-neutral-800">
                                    <p className="text-xs text-neutral-500 mb-0.5">Reviews</p>
                                    <p className="font-semibold text-white">
                                        {data.total_reviews} ({data.accuracy_rate.toFixed(1)}% accurate)
                                    </p>
                                </div>
                            )}
                            <div className="bg-neutral-900 rounded-lg p-3 flex items-center justify-between border border-neutral-800">
                                <div>
                                    <p className="text-xs text-neutral-500 mb-0.5">Status</p>
                                    <p className={`text-sm font-medium ${data.is_active ? 'text-white' : 'text-neutral-500'}`}>
                                        {data.is_active ? 'Active' : 'Not registered'}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <p className="text-neutral-500 text-sm text-center py-4">Could not load wallet data.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Rep Impact Preview ─────────────────────────────────────────────────────────

function RepImpactPreview({
    report, label, appeal, maliciousSet,
}: {
    report: ModerableReport;
    label: FinalLabel;
    appeal: AppealOutcome;
    maliciousSet: Set<string>;
}) {
    const rDelta = reporterRepDelta(label, appeal, maliciousSet.has(report.reporter));
    const sDelta = (addr: string) => supporterRepDelta(label, maliciousSet.has(addr));
    const cDelta = (addr: string) => challengerRepDelta(label, maliciousSet.has(addr));

    return (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950">
            <div className="px-4 py-2 border-b border-neutral-800 flex items-center gap-2">
                <ChartBarIcon className="w-4 h-4 text-neutral-500" />
                <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                    Rep Impact Preview
                </span>
            </div>
            <div className="divide-y divide-neutral-800/50">
                {/* Reporter */}
                <div className="px-4 py-2 flex items-center justify-between">
                    <div>
                        <p className="text-xs text-neutral-500">Reporter</p>
                        <p className="text-xs font-mono text-neutral-300">{truncAddr(report.reporter)}</p>
                    </div>
                    <DeltaBadge delta={rDelta} />
                </div>
                {/* Supporters */}
                {report.supporters.length > 0 ? report.supporters.map(addr => (
                    <div key={addr} className="px-4 py-2 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-neutral-600">Supporter</p>
                            <p className="text-xs font-mono text-neutral-400">{truncAddr(addr)}</p>
                        </div>
                        <DeltaBadge delta={sDelta(addr)} />
                    </div>
                )) : report.supportCount > 0 ? (
                    <div className="px-4 py-2 flex items-center justify-between">
                        <p className="text-xs text-neutral-500">{report.supportCount} supporter(s)</p>
                        <DeltaBadge delta={sDelta('')} />
                    </div>
                ) : null}
                {/* Challengers */}
                {report.challengers.length > 0 ? report.challengers.map(addr => (
                    <div key={addr} className="px-4 py-2 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-neutral-600">Challenger</p>
                            <p className="text-xs font-mono text-neutral-400">{truncAddr(addr)}</p>
                        </div>
                        <DeltaBadge delta={cDelta(addr)} />
                    </div>
                )) : report.challengeCount > 0 ? (
                    <div className="px-4 py-2 flex items-center justify-between">
                        <p className="text-xs text-neutral-500">{report.challengeCount} challenger(s)</p>
                        <DeltaBadge delta={cDelta('')} />
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// ── Moderator Notes ────────────────────────────────────────────────────────────

function ModeratorNotesField({ reportId, moderatorAddress }: { reportId: number; moderatorAddress: string }) {
    const [content, setContent] = useState('');
    const [saved, setSaved] = useState(true);
    const [saving, setSaving] = useState(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/v1/moderation/notes/${reportId}`);
                if (!res.ok) return;
                const notes: { moderator_address: string; content: string }[] = await res.json();
                const mine = notes.find(n => n.moderator_address.toLowerCase() === moderatorAddress.toLowerCase());
                if (mine) { setContent(mine.content); setSaved(true); }
            } catch { /* ignore */ }
        })();
    }, [reportId, moderatorAddress]);

    const handleChange = (val: string) => {
        setContent(val);
        setSaved(false);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => handleSave(val), 2000);
    };

    const handleSave = async (text?: string) => {
        const toSave = text ?? content;
        setSaving(true);
        try {
            await fetch(`${API_BASE}/api/v1/moderation/notes/${reportId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(moderatorAddress ? { 'X-Wallet-Address': moderatorAddress } : {}),
                },
                body: JSON.stringify({ moderator_address: moderatorAddress, content: toSave }),
            });
            setSaved(true);
        } catch { /* ignore */ } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-neutral-400 flex items-center gap-1">
                    <DocumentTextIcon className="w-3.5 h-3.5" />
                    Your Notes
                </p>
                <span className="text-xs text-neutral-500">
                    {saving ? 'Saving…' : saved ? 'Saved' : 'Unsaved'}
                </span>
            </div>
            <textarea
                value={content}
                onChange={e => handleChange(e.target.value)}
                placeholder="Add private notes for this report…"
                rows={3}
                className="w-full text-sm border border-neutral-800 rounded-lg px-3 py-2 resize-none bg-neutral-900 text-neutral-300 placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-600"
            />
        </div>
    );
}

// ── Confirm Finalize Modal ─────────────────────────────────────────────────────

function ConfirmFinalizeModal({
    report, label, appeal, maliciousSet, processing, onConfirm, onClose,
}: {
    report: ModerableReport;
    label: FinalLabel;
    appeal: AppealOutcome;
    maliciousSet: Set<string>;
    processing: boolean;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const isSlash = label === FinalLabel.FALSE_OR_MANIPULATED;
    const rDelta = reporterRepDelta(label, appeal, maliciousSet.has(report.reporter));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="fixed inset-0 bg-black/60" onClick={onClose} />
            <div className="relative bg-neutral-950 rounded-2xl shadow-2xl border border-neutral-800 w-full max-w-lg mx-4 overflow-hidden">
                <div className="border-b border-neutral-800 px-6 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-white">
                            <ShieldCheckIcon className="w-5 h-5 text-neutral-400" />
                            <h2 className="font-bold">Confirm Finalization</h2>
                        </div>
                        <button onClick={onClose} className="text-neutral-500 hover:text-white">
                            <XMarkIcon className="w-5 h-5" />
                        </button>
                    </div>
                    <p className="text-neutral-500 text-sm mt-1">
                        Report #{report.id} · {FINAL_LABEL_NAMES[label]}
                        {appeal !== AppealOutcome.NONE && ` · ${APPEAL_OUTCOME_NAMES[appeal]}`}
                    </p>
                </div>

                <div className="p-6 space-y-4">
                    {/* COV Settlement */}
                    <div>
                        <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                            COV Settlement
                        </p>
                        <div className="space-y-1.5 text-sm">
                            <div className="flex justify-between">
                                <span className="text-neutral-400">Reporter stake ({report.stake} COV)</span>
                                <span className="font-medium" style={{ color: isSlash ? '#E84B1A' : '#ffffff' }}>
                                    {isSlash ? 'SLASHED → treasury' : 'RETURNED'}
                                </span>
                            </div>
                            {report.supportCount > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-neutral-400">
                                        {report.supportCount} supporter(s) ({report.supportCount * STAKES.SUPPORT} COV)
                                    </span>
                                    <span className="font-medium" style={{ color: isSlash ? '#E84B1A' : '#ffffff' }}>
                                        {isSlash ? 'SLASHED' : 'RETURNED'}
                                    </span>
                                </div>
                            )}
                            {report.challengeCount > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-neutral-400">
                                        {report.challengeCount} challenger(s) ({report.challengeCount * STAKES.CHALLENGE} COV)
                                    </span>
                                    <span className="text-neutral-400 font-medium">
                                        {maliciousSet.size > 0
                                            ? `${maliciousSet.size} malicious → SLASHED, rest RETURNED`
                                            : 'RETURNED'}
                                    </span>
                                </div>
                            )}
                            {report.hasAppeal && (
                                <div className="flex justify-between">
                                    <span className="text-neutral-400">Appeal bond ({report.appealBond} COV)</span>
                                    <span className="font-medium text-neutral-300">
                                        {appeal === AppealOutcome.APPEAL_WON && 'RETURNED'}
                                        {appeal === AppealOutcome.APPEAL_LOST && '4 RETURNED / 4 SLASHED'}
                                        {appeal === AppealOutcome.APPEAL_ABUSIVE && 'ALL SLASHED'}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Rep Impact */}
                    <RepImpactPreview report={report} label={label} appeal={appeal} maliciousSet={maliciousSet} />

                    {/* Malicious set warning */}
                    {maliciousSet.size > 0 && (
                        <div className="rounded-lg border px-4 py-3 flex items-center gap-2" style={{ backgroundColor: '#E84B1A22', borderColor: '#E84B1A55' }}>
                            <FireIcon className="w-4 h-4 shrink-0" style={{ color: '#E84B1A' }} />
                            <p className="text-sm text-neutral-300">
                                {maliciousSet.size} actor(s) will be marked malicious on-chain (−5 Rep + strike each)
                            </p>
                        </div>
                    )}

                    <p className="text-xs text-neutral-500">
                        This action is irreversible. Reporter's rep will change by{' '}
                        <span className={`font-bold ${deltaColor(rDelta)}`}>{rDelta > 0 ? `+${rDelta}` : rDelta}</span>.
                    </p>
                </div>

                <div className="px-6 pb-6 flex gap-3">
                    <button
                        onClick={onClose}
                        disabled={processing}
                        className="flex-1 px-4 py-2.5 border border-neutral-700 text-neutral-300 rounded-lg text-sm font-medium hover:border-neutral-500 hover:text-white transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={processing}
                        className="flex-1 px-4 py-2.5 bg-white hover:bg-neutral-200 text-black rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {processing ? (
                            <><ArrowPathIcon className="w-4 h-4 animate-spin" /> Finalizing…</>
                        ) : (
                            <><ShieldCheckIcon className="w-4 h-4" /> Confirm & Finalize</>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Report Card ────────────────────────────────────────────────────────────────

function ReportCard({
    report, selected, batchSelected, onSelect, onToggleBatch,
    finalLabel, setFinalLabel, appealOutcome, setAppealOutcome,
    maliciousActors, toggleMalicious, onOpenConfirm,
    onDeepDive, moderatorAddress, processingId,
    loadingActors,
}: {
    report: ModerableReport;
    selected: boolean;
    batchSelected: boolean;
    onSelect: (r: ModerableReport) => void;
    onToggleBatch: (id: number) => void;
    finalLabel: FinalLabel;
    setFinalLabel: (l: FinalLabel) => void;
    appealOutcome: AppealOutcome;
    setAppealOutcome: (o: AppealOutcome) => void;
    maliciousActors: Set<string>;
    toggleMalicious: (addr: string) => void;
    onOpenConfirm: () => void;
    onDeepDive: (addr: string) => void;
    moderatorAddress: string;
    processingId: number | null;
    loadingActors: boolean;
}) {
    const isPending = report.finalLabel === FinalLabel.UNREVIEWED;
    const covAtRisk = totalCovAtRisk(report);

    // Fetch plaintext report content from backend when card is expanded
    const [reportContent, setReportContent] = useState<{ title?: string; description?: string; cid?: string; size_bytes?: number; visibility?: string } | null>(null);
    const [contentLoading, setContentLoading] = useState(false);
    useEffect(() => {
        if (!selected || !report.contentHash) return;
        let cancelled = false;
        setContentLoading(true);
        fetch(`${API_BASE}/api/v1/reports/by-hash/${report.contentHash}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (cancelled) return;
                setReportContent(data ?? null);
                setContentLoading(false);
            })
            .catch(() => { if (!cancelled) setContentLoading(false); });
        return () => { cancelled = true; };
    }, [selected, report.contentHash]);

    return (
        <div className={`rounded-2xl border transition-all overflow-hidden ${
            selected
                ? 'border-neutral-600 shadow-[0_0_30px_rgba(255,255,255,0.03)] bg-neutral-950'
                : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600'
        }`}>
            {/* Header row */}
            <div className="flex items-start gap-3 p-4">
                {/* Batch checkbox — only for pending */}
                {isPending && (
                    <input
                        type="checkbox"
                        checked={batchSelected}
                        onChange={() => onToggleBatch(report.id)}
                        onClick={e => e.stopPropagation()}
                        className="mt-1 w-4 h-4 rounded shrink-0 bg-neutral-900 border-neutral-700"
                    />
                )}
                <button className="flex-1 text-left" onClick={() => onSelect(report)}>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-bold text-white">Report #{report.id}</span>
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${FINAL_LABEL_COLORS[report.finalLabel]}`}>
                                {FINAL_LABEL_NAMES[report.finalLabel]}
                            </span>
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-800 text-neutral-400">
                                {report.visibility}
                            </span>
                            {report.reviewDecision !== ReviewerDecision.NONE && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-800 text-neutral-300">
                                    {REVIEWER_DECISION_NAMES[report.reviewDecision]}
                                </span>
                            )}
                            {report.hasAppeal && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium animate-pulse text-white" style={{ backgroundColor: '#E84B1A33', border: '1px solid #E84B1A66' }}>
                                    APPEAL
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-neutral-400 font-medium">{covAtRisk} COV at risk</span>
                            <span className="text-neutral-300 text-sm font-semibold">{report.supportCount} sup</span>
                            <span className="text-neutral-400 text-sm font-semibold">{report.challengeCount} chl</span>
                            <ChevronDownIcon className={`w-4 h-4 text-neutral-500 transition-transform ${selected ? 'rotate-180' : ''}`} />
                        </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-neutral-500 mt-1.5 flex-wrap">
                        <span>Reporter: {truncAddr(report.reporter)}</span>
                        <span>•</span>
                        <span>{formatTimeAgo(report.createdAt)}</span>
                        {report.reviewedAt > 0 && (
                            <><span>•</span><span>Reviewed {formatTimeAgo(report.reviewedAt)}</span></>
                        )}
                    </div>
                </button>
            </div>

            {/* Expanded panel */}
            {selected && (
                <div className="border-t border-neutral-800 bg-neutral-900/50 p-5 space-y-5">
                    {/* Report content: title + description */}
                    {contentLoading ? (
                        <div className="animate-pulse space-y-3">
                            <div className="h-5 bg-neutral-800 rounded w-2/3" />
                            <div className="h-24 bg-neutral-800 rounded" />
                        </div>
                    ) : reportContent ? (
                        <div className="space-y-4">
                            {reportContent.title && (
                                <div>
                                    <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Title</p>
                                    <p className="text-base font-semibold text-white leading-snug">{reportContent.title}</p>
                                </div>
                            )}
                            {reportContent.description && (
                                <div>
                                    <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Description</p>
                                    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 max-h-60 overflow-y-auto">
                                        <p className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">{reportContent.description}</p>
                                    </div>
                                </div>
                            )}
                            {reportContent.size_bytes != null && (
                                <p className="text-xs text-neutral-500">
                                    Evidence bundle: {reportContent.size_bytes < 1024 * 1024
                                        ? `${(reportContent.size_bytes / 1024).toFixed(1)} KB`
                                        : `${(reportContent.size_bytes / (1024 * 1024)).toFixed(1)} MB`}
                                </p>
                            )}

                            {/* Evidence files — fetches AES key from backend and decrypts in-browser.
                                Moderators pass 'public' so the viewer never shows the "Private Report"
                                lock screen — the backend gates access by moderator role instead. */}
                            {reportContent.cid && (
                                <EvidenceViewer
                                    contentHash={report.contentHash}
                                    cid={reportContent.cid}
                                    visibility="public"
                                />
                            )}
                        </div>
                    ) : null}

                    {/* Content hash */}
                    <div>
                        <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">Content Hash</p>
                        <code className="text-xs text-neutral-400 bg-neutral-900 px-2 py-1 rounded border border-neutral-800 font-mono break-all">
                            {report.contentHash}
                        </code>
                    </div>

                    {/* Evidence + finalization actions for PENDING; evidence-only for finalized */}
                    {isPending ? (
                        <>
                            {/* Actor lists with deep-dive chips */}
                            {loadingActors ? (
                                <div className="animate-pulse h-8 bg-neutral-800 rounded" />
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* Supporters */}
                                    <div>
                                        <p className="text-xs font-medium text-neutral-300 mb-2 flex items-center gap-1">
                                            <CheckCircleIcon className="w-3.5 h-3.5 text-neutral-400" />
                                            Supporters ({report.supportCount})
                                        </p>
                                        {report.supporters.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5">
                                                {report.supporters.map(addr => (
                                                    <button
                                                        key={addr}
                                                        onClick={() => onDeepDive(addr)}
                                                        className="px-2 py-1 rounded-md text-xs font-mono bg-neutral-800 text-neutral-300 border border-neutral-700 hover:border-neutral-500 transition-colors"
                                                        title="Click to view wallet profile"
                                                    >
                                                        {truncAddr(addr)}
                                                    </button>
                                                ))}
                                            </div>
                                        ) : report.supportCount > 0 ? (
                                            <p className="text-xs text-neutral-500">Loaded on expand…</p>
                                        ) : (
                                            <p className="text-xs text-neutral-500">None</p>
                                        )}
                                    </div>

                                    {/* Challengers with malicious toggle */}
                                    <div>
                                        <p className="text-xs font-medium text-neutral-400 mb-2 flex items-center gap-1">
                                            <FireIcon className="w-3.5 h-3.5 text-neutral-500" />
                                            Challengers ({report.challengeCount})
                                        </p>
                                        {report.challengers.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5">
                                                {report.challengers.map(addr => (
                                                    <div key={addr} className="flex items-center gap-0.5">
                                                        <button
                                                            onClick={() => onDeepDive(addr)}
                                                            className={`px-2 py-1 rounded-l-md text-xs font-mono border transition-colors ${
                                                                maliciousActors.has(addr)
                                                                    ? 'text-white border-neutral-500'
                                                                    : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:border-neutral-500'
                                                            }`}
                                                            style={maliciousActors.has(addr) ? { backgroundColor: '#E84B1A' } : {}}
                                                            title="Click to view wallet profile"
                                                        >
                                                            {truncAddr(addr)}
                                                        </button>
                                                        <button
                                                            onClick={() => toggleMalicious(addr)}
                                                            className={`px-1.5 py-1 rounded-r-md text-xs border-y border-r transition-colors ${
                                                                maliciousActors.has(addr)
                                                                    ? 'text-white border-neutral-500'
                                                                    : 'bg-neutral-800 text-neutral-400 border-neutral-700 hover:border-neutral-500'
                                                            }`}
                                                            style={maliciousActors.has(addr) ? { backgroundColor: '#c43b15' } : {}}
                                                            title={maliciousActors.has(addr) ? 'Un-flag' : 'Mark malicious'}
                                                        >
                                                            flag
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : report.challengeCount > 0 ? (
                                            <p className="text-xs text-neutral-500">Loaded on expand…</p>
                                        ) : (
                                            <p className="text-xs text-neutral-500">None</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Stake info */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                {[
                                    { label: 'Report Stake', val: `${report.stake} COV`, cls: 'text-white' },
                                    { label: 'Support', val: `${report.supportCount * STAKES.SUPPORT} COV`, cls: 'text-neutral-300' },
                                    { label: 'Challenge', val: `${report.challengeCount * STAKES.CHALLENGE} COV`, cls: 'text-neutral-400' },
                                    { label: 'Appeal Bond', val: report.hasAppeal ? `${report.appealBond} COV` : '—', cls: 'text-neutral-300' },
                                ].map(({ label, val, cls }) => (
                                    <div key={label} className="bg-neutral-900 rounded-lg border border-neutral-800 p-2.5">
                                        <p className="text-xs text-neutral-500">{label}</p>
                                        <p className={`text-base font-bold ${cls}`}>{val}</p>
                                    </div>
                                ))}
                            </div>

                            {/* Final Label */}
                            <div>
                                <p className="text-sm font-medium text-neutral-300 mb-2">Final Label</p>
                                <div className="flex flex-wrap gap-2">
                                    {[FinalLabel.CORROBORATED, FinalLabel.NEEDS_EVIDENCE, FinalLabel.DISPUTED, FinalLabel.FALSE_OR_MANIPULATED].map(lbl => (
                                        <button
                                            key={lbl}
                                            onClick={() => setFinalLabel(lbl)}
                                            className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                                                finalLabel === lbl
                                                    ? 'bg-orange-700 text-white border-orange-600 ring-2 ring-orange-600'
                                                    : 'bg-neutral-900 text-neutral-400 border-neutral-700 hover:border-neutral-500'
                                            }`}
                                        >
                                            {FINAL_LABEL_NAMES[lbl]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Appeal Outcome */}
                            {report.hasAppeal && (
                                <div>
                                    <p className="text-sm font-medium text-neutral-300 mb-2">Appeal Outcome</p>
                                    <div className="flex flex-wrap gap-2">
                                        {[AppealOutcome.APPEAL_WON, AppealOutcome.APPEAL_LOST, AppealOutcome.APPEAL_ABUSIVE].map(oc => (
                                            <button
                                                key={oc}
                                                onClick={() => setAppealOutcome(oc)}
                                                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                                                    appealOutcome === oc
                                                        ? 'bg-orange-700 text-white border-orange-600 ring-2 ring-orange-600'
                                                        : 'bg-neutral-900 text-neutral-400 border-neutral-700 hover:border-orange-700'
                                                }`}
                                            >
                                                {APPEAL_OUTCOME_NAMES[oc]}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Rep impact preview */}
                            <RepImpactPreview report={report} label={finalLabel} appeal={appealOutcome} maliciousSet={maliciousActors} />

                            {/* Moderator notes */}
                            <ModeratorNotesField reportId={report.id} moderatorAddress={moderatorAddress} />

                            {/* Finalize button → opens confirm modal */}
                            <button
                                onClick={onOpenConfirm}
                                disabled={processingId !== null}
                                className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all disabled:opacity-50 hover:opacity-90"
                                style={{ backgroundColor: '#E84B1A', color: '#fff' }}
                            >
                                <ShieldCheckIcon className="w-5 h-5" />
                                Review & Finalize Report #{report.id}
                            </button>
                        </>
                    ) : (
                        <div className="space-y-4">
                            <div className="bg-neutral-900 rounded-lg border border-neutral-700 p-4 flex items-center gap-2">
                                <CheckCircleIcon className="w-5 h-5 text-neutral-400" />
                                <span className="font-medium text-neutral-200">
                                    Finalized as "{FINAL_LABEL_NAMES[report.finalLabel]}"
                                </span>
                            </div>
                            {/* Evidence still accessible post-finalization */}
                            {reportContent?.cid && (
                                <EvidenceViewer
                                    contentHash={report.contentHash}
                                    cid={reportContent.cid}
                                    visibility="public"
                                />
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Flagged Users Tab ──────────────────────────────────────────────────────────

function FlaggedTab({ onDeepDive }: { onDeepDive: (addr: string) => void }) {
    const [users, setUsers] = useState<FlaggedUser[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/v1/reputation/flagged`);
                if (!res.ok) throw new Error();
                setUsers(await res.json());
            } catch { /* ignore */ } finally {
                setLoading(false);
            }
        })();
    }, []);

    if (loading) return (
        <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="animate-pulse h-16 bg-neutral-900 rounded-lg" />)}
        </div>
    );

    if (users.length === 0) return (
        <div className="text-center py-16 rounded-2xl border border-neutral-800 bg-neutral-950">
            <CheckCircleIcon className="w-12 h-12 text-neutral-700 mx-auto mb-3" />
            <p className="text-neutral-500 font-medium">No flagged wallets in the last 30 days</p>
        </div>
    );

    return (
        <div className="space-y-2">
            {users.map(u => (
                <div key={u.wallet_address} className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 flex items-center justify-between hover:border-neutral-600 transition-all">
                    <div>
                        <button
                            onClick={() => onDeepDive(u.wallet_address)}
                            className="font-mono text-sm text-neutral-300 hover:text-white hover:underline"
                        >
                            {truncAddr(u.wallet_address)}
                        </button>
                        <div className="flex items-center gap-3 mt-1 text-xs text-neutral-500">
                            <span>{TIER_LABELS[u.tier] ?? u.tier}</span>
                            <span>•</span>
                            <span>Rep {u.reputation_score}</span>
                            {u.last_strike_at && (
                                <><span>•</span><span>Last strike {new Date(u.last_strike_at).toLocaleDateString()}</span></>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 bg-neutral-800 text-neutral-300 rounded-full text-xs font-bold border border-neutral-700" style={u.strikes >= 3 ? { color: '#E84B1A' } : {}}>
                            {u.strikes} strike{u.strikes !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── Reviewer Candidates Tab ────────────────────────────────────────────────────

function ReviewersTab({ onDeepDive }: { onDeepDive: (addr: string) => void }) {
    const [reviewers, setReviewers] = useState<ReviewerCandidate[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/v1/reputation/reviewer-candidates`);
                if (!res.ok) throw new Error();
                setReviewers(await res.json());
            } catch { /* ignore */ } finally {
                setLoading(false);
            }
        })();
    }, []);

    if (loading) return (
        <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="animate-pulse h-16 bg-neutral-900 rounded-lg" />)}
        </div>
    );

    if (reviewers.length === 0) return (
        <div className="text-center py-16 rounded-2xl border border-neutral-800 bg-neutral-950">
            <MagnifyingGlassIcon className="w-12 h-12 text-neutral-700 mx-auto mb-3" />
            <p className="text-neutral-500 font-medium">No users with Rep ≥ 80 yet</p>
        </div>
    );

    return (
        <div className="overflow-hidden rounded-2xl border border-neutral-800">
            <table className="w-full text-sm">
                <thead className="bg-neutral-900 border-b border-neutral-800">
                    <tr>
                        {['Wallet', 'Rep', 'Tier', 'Age (days)', 'Strikes', 'No Slash'].map(h => (
                            <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800 bg-neutral-950">
                    {reviewers.map(r => (
                        <tr key={r.wallet_address} className="hover:bg-neutral-900">
                            <td className="px-4 py-3">
                                <button
                                    onClick={() => onDeepDive(r.wallet_address)}
                                    className="font-mono text-xs text-neutral-300 hover:text-white hover:underline"
                                >
                                    {truncAddr(r.wallet_address)}
                                </button>
                            </td>
                            <td className="px-4 py-3 font-bold text-white">{r.reputation_score}</td>
                            <td className="px-4 py-3 text-neutral-400">{TIER_LABELS[r.tier] ?? r.tier}</td>
                            <td className="px-4 py-3 text-neutral-400">{r.account_age_days}</td>
                            <td className="px-4 py-3">
                                <span className={r.active_strikes > 0 ? 'text-neutral-300 font-medium' : 'text-neutral-500'}>
                                    {r.active_strikes}
                                </span>
                            </td>
                            <td className="px-4 py-3">
                                <span className={r.slash_ok ? 'text-neutral-300' : 'text-neutral-500'}>
                                    {r.slash_ok ? 'Yes' : 'No'}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export function ProtocolModeratorDashboard() {
    const { walletState } = useWeb3();
    const isConnected = walletState.connected;
    const moderatorAddress = walletState.address ?? '';
    useRoleAccess();

    // ── Data state ──
    const [reports, setReports] = useState<ModerableReport[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingActors, setLoadingActors] = useState(false);
    // True only when reports came from CovertProtocol on-chain; false for DB fallback.
    // On-chain actions (finalizeReport) are blocked when false.
    const [fromBlockchain, setFromBlockchain] = useState(false);

    // ── UI state ──
    const [activeTab, setActiveTab] = useState<Tab>('queue');
    const [sortKey, setSortKey] = useState<SortKey>('oldest');
    const [filterKey, setFilterKey] = useState<FilterKey>('pending');

    // ── Report action state ──
    const [selectedReport, setSelectedReport] = useState<ModerableReport | null>(null);
    const [finalLabel, setFinalLabel] = useState<FinalLabel>(FinalLabel.CORROBORATED);
    const [appealOutcome, setAppealOutcome] = useState<AppealOutcome>(AppealOutcome.NONE);
    const [maliciousActors, setMaliciousActors] = useState<Set<string>>(new Set());
    const [processingId, setProcessingId] = useState<number | null>(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);

    // ── Batch state ──
    const [batchSelected, setBatchSelected] = useState<Set<number>>(new Set());
    const [batchLabel, setBatchLabel] = useState<FinalLabel>(FinalLabel.FALSE_OR_MANIPULATED);
    const [batchProcessing, setBatchProcessing] = useState(false);

    // ── Deep-dive state ──
    const [deepDiveWallet, setDeepDiveWallet] = useState<string | null>(null);

    // ── Fetch reports ──
    const fetchReports = useCallback(async () => {
        if (!isConnected) return;
        setLoading(true);
        try {
            let usedBlockchain = false;

            // Try blockchain first
            try {
                await protocolService.connect();
                const count = await protocolService.getReportCount();
                const rawReports = await protocolService.getReportsInRange(0, count);

                if (rawReports.length > 0) {
                    // Fetch DB records to cross-reference — only show reports that
                    // exist in the DB (post-wipe). Old on-chain-only reports are hidden.
                    let dbHashSet = new Set<string>();
                    // Default true: if DB check fails for any reason, show nothing
                    // (never fall back to showing unverified blockchain-only reports)
                    let dbFetched = true;
                    try {
                        const _token = localStorage.getItem('token');
                        const _addr = localStorage.getItem('wallet_address');
                        const dbRes = await fetch(`${API_BASE}/api/v1/reports/all?limit=500`, {
                            cache: 'no-store',
                            headers: {
                                ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
                                ...(_addr ? { 'X-Wallet-Address': _addr } : {}),
                            },
                        });
                        if (dbRes.ok) {
                            const dbData = await dbRes.json();
                            dbHashSet = new Set(
                                (dbData.items || []).map((r: { cid_hash?: string }) =>
                                    (r.cid_hash || '').toLowerCase()
                                )
                            );
                        }
                    } catch {
                        // DB unreachable — dbFetched=true + empty set = show nothing
                        toast.error('Could not reach the database. Queue may appear empty — please refresh.');
                    }

                    // Filter blockchain reports to those that exist in DB.
                    // If dbFetched is true but set is empty, DB has been wiped → show nothing.
                    // Only skip filtering if the DB fetch itself failed.
                    const knownReports = dbFetched
                        ? rawReports.filter((r) => dbHashSet.has((r.contentHash || '').toLowerCase()))
                        : rawReports;

                    const enriched = await Promise.all(knownReports.map(async (r) => {
                        const [sc, cc] = await Promise.all([
                            protocolService.getSupporterCount(r.id),
                            protocolService.getChallengerCount(r.id),
                        ]);
                        return {
                            ...r,
                            visibility: r.visibility === 0 ? 'PUBLIC' : 'PRIVATE' as 'PUBLIC' | 'PRIVATE',
                            supportCount: sc,
                            challengeCount: cc,
                            supporters: [],
                            challengers: [],
                            stake: r.visibility === 0 ? STAKES.REPORT_PUBLIC : STAKES.REPORT_PRIVATE,
                            appealBond: r.hasAppeal ? STAKES.APPEAL_BOND : 0,
                        } as ModerableReport;
                    }));
                    setReports(enriched);
                    setFromBlockchain(true);
                    usedBlockchain = true;
                }
            } catch {
                // Blockchain unavailable — fall through to DB fetch
            }

            if (!usedBlockchain) {
                setFromBlockchain(false);
                // Fall back to backend DB — shows all reports from all wallets
                const _token = localStorage.getItem('token');
                const res = await fetch(`${API_BASE}/api/v1/reports/all?limit=100`, {
                    cache: 'no-store',
                    headers: {
                        ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
                        ...(moderatorAddress ? { 'X-Wallet-Address': moderatorAddress } : {}),
                    },
                });
                if (res.ok) {
                    const data = await res.json();
                    const DB_REVIEW_DECISION: Record<string, ReviewerDecision> = {
                        'REVIEW_PASSED': ReviewerDecision.REVIEW_PASSED,
                        'NEEDS_EVIDENCE': ReviewerDecision.NEEDS_EVIDENCE,
                        'REJECT_SPAM': ReviewerDecision.REJECT_SPAM,
                    };
                    // Map DB status → FinalLabel for display purposes
                    const DB_STATUS_TO_FINAL_LABEL: Record<string, FinalLabel> = {
                        'verified': FinalLabel.CORROBORATED,
                        'rejected': FinalLabel.FALSE_OR_MANIPULATED,
                        'disputed': FinalLabel.DISPUTED,
                    };
                    // Infer reviewDecision from DB status when review_decision field is absent
                    const STATUS_TO_REVIEW_DECISION: Record<string, ReviewerDecision> = {
                        'pending_moderation': ReviewerDecision.REVIEW_PASSED,
                        'appealed': ReviewerDecision.REVIEW_PASSED,
                        'under_review': ReviewerDecision.REVIEW_PASSED,
                        'needs_evidence': ReviewerDecision.NEEDS_EVIDENCE,
                        'rejected_by_reviewer': ReviewerDecision.REJECT_SPAM,
                    };
                    const dbReports: ModerableReport[] = (data.items || []).map(
                        (r: { reporter?: string; visibility: string; cid_hash?: string; submitted_at?: string; status?: string; review_decision?: string }, idx: number) => ({
                            id: idx + 1,
                            reporter: r.reporter || '0x0000000000000000000000000000000000000000',
                            visibility: r.visibility === 'public' ? 'PUBLIC' : 'PRIVATE' as 'PUBLIC' | 'PRIVATE',
                            contentHash: r.cid_hash || '',
                            finalLabel: (r.status && DB_STATUS_TO_FINAL_LABEL[r.status]) ?? FinalLabel.UNREVIEWED,
                            reviewDecision: (r.review_decision && DB_REVIEW_DECISION[r.review_decision])
                                ?? (r.status && STATUS_TO_REVIEW_DECISION[r.status])
                                ?? ReviewerDecision.NONE,
                            createdAt: r.submitted_at ? new Date(r.submitted_at).getTime() / 1000 : Date.now() / 1000,
                            reviewedAt: 0,
                            supportCount: 0,
                            challengeCount: 0,
                            supporters: [],
                            challengers: [],
                            hasAppeal: r.status === 'appealed',
                            appealReasonHash: '',
                            stake: r.visibility === 'public' ? STAKES.REPORT_PUBLIC : STAKES.REPORT_PRIVATE,
                            appealBond: r.status === 'appealed' ? STAKES.APPEAL_BOND : 0,
                            lockedReportStake: 0n,
                            dbStatus: r.status,
                        })
                    );
                    setReports(dbReports);
                } else {
                    toast.error('Failed to load reports');
                }
            }
        } catch (err) {
            console.error(err);
            setFromBlockchain(false);
            toast.error('Failed to load reports from chain');
        } finally {
            setLoading(false);
        }
    }, [isConnected]);

    useEffect(() => {
        if (isConnected) fetchReports();
        else { setReports([]); setSelectedReport(null); }
    }, [isConnected, fetchReports]);

    // Re-fetch when a reviewer or another moderator dispatches a decision event
    useEffect(() => {
        window.addEventListener('covert:reports-updated', fetchReports);
        return () => window.removeEventListener('covert:reports-updated', fetchReports);
    }, [fetchReports]);

    // ── Select / expand report (lazy-loads actor lists) ──
    const handleSelectReport = async (report: ModerableReport) => {
        if (selectedReport?.id === report.id) {
            setSelectedReport(null);
            return;
        }
        setSelectedReport(report);
        setFinalLabel(FinalLabel.CORROBORATED);
        setAppealOutcome(report.hasAppeal ? AppealOutcome.APPEAL_WON : AppealOutcome.NONE);
        setMaliciousActors(new Set());

        if (report.supporters.length === 0 || report.challengers.length === 0) {
            setLoadingActors(true);
            try {
                const [supporters, challengers] = await Promise.all([
                    protocolService.getSupporters(report.id),
                    protocolService.getChallengers(report.id),
                ]);
                setSelectedReport(prev =>
                    prev?.id === report.id ? { ...prev, supporters, challengers } : prev
                );
                setReports(prev =>
                    prev.map(r => r.id === report.id ? { ...r, supporters, challengers } : r)
                );
            } catch { /* ignore */ } finally {
                setLoadingActors(false);
            }
        }
    };

    const toggleMalicious = (addr: string) => {
        setMaliciousActors(prev => {
            const next = new Set(prev);
            next.has(addr) ? next.delete(addr) : next.add(addr);
            return next;
        });
    };

    // Maps on-chain FinalLabel to the backend DB ReportStatus string
    const FINAL_LABEL_TO_STATUS: Record<number, string> = {
        [FinalLabel.CORROBORATED]: 'verified',
        [FinalLabel.NEEDS_EVIDENCE]: 'needs_evidence',
        [FinalLabel.DISPUTED]: 'pending_moderation',
        [FinalLabel.FALSE_OR_MANIPULATED]: 'rejected',
    };

    // ── Label / outcome → backend string maps ──
    const FINAL_LABEL_KEY: Record<FinalLabel, string> = {
        [FinalLabel.UNREVIEWED]:          'UNREVIEWED',
        [FinalLabel.NEEDS_EVIDENCE]:      'NEEDS_EVIDENCE',
        [FinalLabel.CORROBORATED]:        'CORROBORATED',
        [FinalLabel.DISPUTED]:            'DISPUTED',
        [FinalLabel.FALSE_OR_MANIPULATED]:'FALSE_OR_MANIPULATED',
    };
    const APPEAL_OUTCOME_KEY: Record<AppealOutcome, string | null> = {
        [AppealOutcome.NONE]:          null,
        [AppealOutcome.APPEAL_WON]:    'APPEAL_WON',
        [AppealOutcome.APPEAL_LOST]:   'APPEAL_LOST',
        [AppealOutcome.APPEAL_ABUSIVE]:'APPEAL_ABUSIVE',
    };

    // Calls the backend finalize endpoint (status update + reputation changes).
    // Works in both on-chain and DB-only mode.
    const syncFinalizeToBackend = (
        contentHash: string,
        label: FinalLabel,
        outcome: AppealOutcome,
        reporter: string,
        supporters: string[],
        challengers: string[],
        reviewDecision?: ReviewerDecision,
    ) => {
        // Map ReviewerDecision enum to string key for the backend
        const REVIEW_DECISION_KEY: Record<number, string> = {
            [ReviewerDecision.NONE]: 'NONE',
            [ReviewerDecision.NEEDS_EVIDENCE]: 'NEEDS_EVIDENCE',
            [ReviewerDecision.REVIEW_PASSED]: 'REVIEW_PASSED',
            [ReviewerDecision.REJECT_SPAM]: 'REJECT_SPAM',
        };

        const token = localStorage.getItem('token');
        fetch(`${API_BASE}/api/v1/reports/by-hash/${contentHash}/finalize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                ...(moderatorAddress ? { 'X-Wallet-Address': moderatorAddress } : {}),
            },
            body: JSON.stringify({
                status: FINAL_LABEL_TO_STATUS[label] ?? 'under_review',
                final_label: FINAL_LABEL_KEY[label],
                reporter,
                appeal_outcome: APPEAL_OUTCOME_KEY[outcome],
                supporters,
                challengers,
                malicious_wallets: Array.from(maliciousActors),
                review_decision: reviewDecision !== undefined ? REVIEW_DECISION_KEY[reviewDecision] : null,
                moderator_address: moderatorAddress,
            }),
        }).catch(() => { /* non-critical — on-chain action already succeeded */ });
    };

    // ── Finalize ──
    const handleFinalize = async () => {
        if (!selectedReport) return;
        setProcessingId(selectedReport.id);
        setShowConfirmModal(false);
        try {
            // On-chain finalization only when reports originate from the blockchain
            if (fromBlockchain) {
                await protocolService.connect();
                for (const actor of maliciousActors) {
                    await protocolService.markMalicious(selectedReport.id, actor, true);
                }
                await protocolService.finalizeReport(selectedReport.id, finalLabel, appealOutcome);
            }

            // Always update local state so the report moves to the Audit Log
            setReports(prev =>
                prev.map(r => r.id === selectedReport.id ? { ...r, finalLabel } : r)
            );

            // Always sync to DB + apply reputation changes
            if (selectedReport.contentHash) {
                syncFinalizeToBackend(
                    selectedReport.contentHash,
                    finalLabel,
                    appealOutcome,
                    selectedReport.reporter,
                    selectedReport.supporters,
                    selectedReport.challengers,
                    selectedReport.reviewDecision,
                );
            }

            toast.success(`Report #${selectedReport.id} finalized as "${FINAL_LABEL_NAMES[finalLabel]}"`);
            window.dispatchEvent(new CustomEvent('covert:reports-updated'));
            window.dispatchEvent(new CustomEvent('covert:rep-refresh'));
            setSelectedReport(null);
        } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            const missingRole = raw.toLowerCase().includes('missing role')
                || raw.toLowerCase().includes('accesscontrol')
                || raw.toLowerCase().includes('not have role');
            if (missingRole) {
                toast.error('Your wallet does not have MODERATOR_ROLE. Contact the protocol administrator.');
            } else if (raw.toLowerCase().includes('user rejected') || raw.toLowerCase().includes('user denied')) {
                toast.error('Transaction rejected');
            } else {
                toast.error(`Finalization failed: ${raw.slice(0, 120)}`);
            }
            console.error(err);
        } finally {
            setProcessingId(null);
        }
    };

    // ── Batch finalize ──
    const handleBatchFinalize = async () => {
        if (batchSelected.size === 0) return;
        setBatchProcessing(true);
        let succeeded = 0;
        try {
            if (fromBlockchain) {
                await protocolService.connect();
            }
            for (const id of batchSelected) {
                try {
                    if (fromBlockchain) {
                        await protocolService.finalizeReport(id, batchLabel, AppealOutcome.NONE);
                    }
                    setReports(prev => prev.map(r => r.id === id ? { ...r, finalLabel: batchLabel } : r));
                    const reportForSync = reports.find(r => r.id === id);
                    if (reportForSync?.contentHash) {
                        syncFinalizeToBackend(
                            reportForSync.contentHash,
                            batchLabel,
                            AppealOutcome.NONE,
                            reportForSync.reporter,
                            reportForSync.supporters,
                            reportForSync.challengers,
                            reportForSync.reviewDecision,
                        );
                    }
                    succeeded++;
                } catch { /* skip individual failures */ }
            }
            toast.success(`Batch: ${succeeded}/${batchSelected.size} reports finalized`);
            window.dispatchEvent(new CustomEvent('covert:reports-updated'));
            window.dispatchEvent(new CustomEvent('covert:rep-refresh'));
            setBatchSelected(new Set());
        } catch (err) {
            toast.error('Batch finalization failed');
        } finally {
            setBatchProcessing(false);
        }
    };

    // ── Sort + filter ──
    const sortedFiltered = (() => {
        // Exclude own reports — moderators cannot moderate their own submissions
        let list = reports.filter(r =>
            !moderatorAddress || r.reporter.toLowerCase() !== moderatorAddress.toLowerCase()
        );

        // Filter
        if (filterKey === 'pending') {
            if (!fromBlockchain) {
                // DB fallback: show all un-finalized reports awaiting moderator action
                const pendingDbStatuses = new Set([
                    'pending_moderation', 'pending_review', 'pending',
                    'under_review', 'needs_evidence', 'rejected_by_reviewer',
                ]);
                list = list.filter(r => r.dbStatus && pendingDbStatuses.has(r.dbStatus));
            } else {
                list = list.filter(r => r.finalLabel === FinalLabel.UNREVIEWED);
            }
        }
        else if (filterKey === 'finalized') list = list.filter(r => r.finalLabel !== FinalLabel.UNREVIEWED);
        else if (filterKey === 'appealed') {
            if (!fromBlockchain) {
                list = list.filter(r => r.dbStatus === 'appealed');
            } else {
                list = list.filter(r => r.hasAppeal && r.finalLabel === FinalLabel.UNREVIEWED);
            }
        }

        // Sort
        if (sortKey === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt);
        else if (sortKey === 'newest') list.sort((a, b) => b.createdAt - a.createdAt);
        else if (sortKey === 'most_cov') list.sort((a, b) => totalCovAtRisk(b) - totalCovAtRisk(a));
        else if (sortKey === 'most_disputes') list.sort((a, b) => b.challengeCount - a.challengeCount);

        return list;
    })();

    // Exclude own submissions from all queue computations
    const reviewableReports = reports.filter(r =>
        !moderatorAddress || r.reporter.toLowerCase() !== moderatorAddress.toLowerCase()
    );
    const appealsQueue = reviewableReports.filter(r => r.hasAppeal && r.finalLabel === FinalLabel.UNREVIEWED);
    const PENDING_DB_STATUSES = new Set([
        'pending_moderation', 'pending_review', 'pending',
        'under_review', 'needs_evidence', 'rejected_by_reviewer',
    ]);
    const pendingCount = fromBlockchain
        ? reviewableReports.filter(r => r.finalLabel === FinalLabel.UNREVIEWED).length
        : reviewableReports.filter(r => r.dbStatus && PENDING_DB_STATUSES.has(r.dbStatus)).length;
    const appealCount = appealsQueue.length;
    const finalizedCount = reviewableReports.filter(r => r.finalLabel !== FinalLabel.UNREVIEWED).length;
    const totalCov = reviewableReports.reduce((sum, r) => sum + (r.finalLabel === FinalLabel.UNREVIEWED ? totalCovAtRisk(r) : 0), 0);

    const TABS: { key: Tab; label: string; badge?: number }[] = [
        { key: 'queue', label: 'Queue', badge: pendingCount },
        { key: 'appeals', label: 'Appeals', badge: appealCount },
        { key: 'flagged', label: 'Flagged Users' },
        { key: 'log', label: 'Audit Log', badge: finalizedCount },
    ];

    if (!isConnected) return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
            <ScaleIcon className="h-16 w-16 text-neutral-700 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h2>
            <p className="text-neutral-500 max-w-md">
                Connect your wallet to access the Moderator Dashboard.
            </p>
        </div>
    );

    return (
        <div className="space-y-5">
            {/* Action bar */}
            <div className="flex items-center justify-end">
                <button
                    onClick={fetchReports}
                    className="flex items-center gap-2 px-4 py-2 border border-neutral-700 hover:border-neutral-500 rounded-lg text-sm font-medium text-neutral-300 hover:text-white transition-colors"
                >
                    <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                    { label: 'Pending', val: pendingCount, Icon: FlagIcon },
                    { label: 'Active Appeals', val: appealCount, Icon: ExclamationTriangleIcon },
                    { label: 'COV At Risk', val: `${totalCov}`, Icon: ScaleIcon },
                    { label: 'Finalized', val: finalizedCount, Icon: CheckCircleIcon },
                ].map(({ label, val, Icon }) => (
                    <div key={label} className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4 hover:border-neutral-600 transition-all duration-500">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-xs text-neutral-500 font-medium">{label}</p>
                                <p className="text-2xl font-bold text-white mt-0.5">{val}</p>
                            </div>
                            <div className="p-2.5 bg-neutral-900 rounded-full">
                                <Icon className="h-5 w-5 text-neutral-400" />
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Two-column layout: vertical sidebar tabs + content */}
            <div className="flex gap-5 items-start">

            {/* Left: vertical tab sidebar */}
            <div className="w-44 flex-shrink-0">
                <nav className="bg-neutral-900 rounded-xl p-2 flex flex-col gap-1 sticky top-4">
                    {TABS.map(({ key, label, badge }) => (
                        <button
                            key={key}
                            onClick={() => setActiveTab(key)}
                            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-between ${
                                activeTab === key
                                    ? 'bg-neutral-800 text-white'
                                    : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50'
                            }`}
                        >
                            <span>{label}</span>
                            {badge !== undefined && badge > 0 && (
                                <span className="text-xs px-1.5 py-0.5 rounded-full font-bold bg-neutral-700 text-neutral-300">
                                    {badge}
                                </span>
                            )}
                        </button>
                    ))}
                </nav>
            </div>

            {/* Right: tab content */}
            <div className="flex-1 min-w-0">

            {/* ── Queue Tab ── */}
            {activeTab === 'queue' && (
                <div className="space-y-4">
                    {/* Sort + Filter bar */}
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <AdjustmentsHorizontalIcon className="w-4 h-4 text-neutral-500" />
                            <span className="text-xs text-neutral-500 font-medium">Filter:</span>
                            {(['pending', 'appealed', 'all', 'finalized'] as FilterKey[]).map(fk => (
                                <button
                                    key={fk}
                                    onClick={() => setFilterKey(fk)}
                                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
                                        filterKey === fk
                                            ? 'bg-orange-700 text-white border-orange-600'
                                            : 'bg-transparent text-neutral-400 border-neutral-700 hover:border-neutral-500'
                                    }`}
                                >
                                    {fk === 'pending' ? 'Pending' :
                                     fk === 'appealed' ? 'Appealed' :
                                     fk === 'finalized' ? 'Finalized' : 'All'}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-1.5 ml-auto">
                            <ClockIcon className="w-4 h-4 text-neutral-500" />
                            <span className="text-xs text-neutral-500 font-medium">Sort:</span>
                            {(['oldest', 'newest', 'most_cov', 'most_disputes'] as SortKey[]).map(sk => (
                                <button
                                    key={sk}
                                    onClick={() => setSortKey(sk)}
                                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
                                        sortKey === sk
                                            ? 'bg-orange-700 text-white border-orange-600'
                                            : 'bg-transparent text-neutral-400 border-neutral-700 hover:border-neutral-500'
                                    }`}
                                >
                                    {sk === 'oldest' ? 'Oldest' :
                                     sk === 'newest' ? 'Newest' :
                                     sk === 'most_cov' ? 'Most COV' : 'Most Disputed'}
                                </button>
                            ))}
                        </div>
                    </div>

                    {loading ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map(i => <div key={i} className="animate-pulse bg-neutral-900 rounded-lg h-24" />)}
                        </div>
                    ) : sortedFiltered.length === 0 ? (
                        <div className="text-center py-16 rounded-2xl border border-neutral-800 bg-neutral-950">
                            <ScaleIcon className="h-12 w-12 text-neutral-700 mx-auto mb-3" />
                            <p className="text-neutral-500 font-medium">No reports match this filter</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {sortedFiltered.map(report => (
                                <ReportCard
                                    key={report.id}
                                    report={report}
                                    selected={selectedReport?.id === report.id}
                                    batchSelected={batchSelected.has(report.id)}
                                    onSelect={handleSelectReport}
                                    onToggleBatch={id => setBatchSelected(prev => {
                                        const next = new Set(prev);
                                        next.has(id) ? next.delete(id) : next.add(id);
                                        return next;
                                    })}
                                    finalLabel={finalLabel}
                                    setFinalLabel={setFinalLabel}
                                    appealOutcome={appealOutcome}
                                    setAppealOutcome={setAppealOutcome}
                                    maliciousActors={maliciousActors}
                                    toggleMalicious={toggleMalicious}
                                    onOpenConfirm={() => setShowConfirmModal(true)}
                                    onDeepDive={setDeepDiveWallet}
                                    moderatorAddress={moderatorAddress}
                                    processingId={processingId}
                                    loadingActors={loadingActors && selectedReport?.id === report.id}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Appeals Tab ── */}
            {activeTab === 'appeals' && (
                <div className="space-y-3">
                    {loading ? (
                        <div className="animate-pulse h-24 bg-neutral-900 rounded-lg" />
                    ) : appealsQueue.length === 0 ? (
                        <div className="text-center py-16 rounded-2xl border border-neutral-800 bg-neutral-950">
                            <CheckCircleIcon className="h-12 w-12 text-neutral-700 mx-auto mb-3" />
                            <p className="text-neutral-500 font-medium">No active appeals</p>
                        </div>
                    ) : appealsQueue.map(report => (
                        <ReportCard
                            key={report.id}
                            report={report}
                            selected={selectedReport?.id === report.id}
                            batchSelected={batchSelected.has(report.id)}
                            onSelect={handleSelectReport}
                            onToggleBatch={id => setBatchSelected(prev => {
                                const next = new Set(prev);
                                next.has(id) ? next.delete(id) : next.add(id);
                                return next;
                            })}
                            finalLabel={finalLabel}
                            setFinalLabel={setFinalLabel}
                            appealOutcome={appealOutcome}
                            setAppealOutcome={setAppealOutcome}
                            maliciousActors={maliciousActors}
                            toggleMalicious={toggleMalicious}
                            onOpenConfirm={() => setShowConfirmModal(true)}
                            onDeepDive={setDeepDiveWallet}
                            moderatorAddress={moderatorAddress}
                            processingId={processingId}
                            loadingActors={loadingActors && selectedReport?.id === report.id}
                        />
                    ))}
                </div>
            )}

            {/* ── Flagged Tab ── */}
            {activeTab === 'flagged' && <FlaggedTab onDeepDive={setDeepDiveWallet} />}

            {/* ── Audit Log Tab ── */}
            {activeTab === 'log' && (
                <div className="space-y-2">
                    {reviewableReports.filter(r => r.finalLabel !== FinalLabel.UNREVIEWED).length === 0 ? (
                        <div className="text-center py-16 rounded-2xl border border-neutral-800 bg-neutral-950">
                            <DocumentTextIcon className="h-12 w-12 text-neutral-700 mx-auto mb-3" />
                            <p className="text-neutral-500 font-medium">No finalized reports yet</p>
                        </div>
                    ) : reviewableReports.filter(r => r.finalLabel !== FinalLabel.UNREVIEWED).map(r => (
                        <ReportCard
                            key={r.id}
                            report={r}
                            selected={selectedReport?.id === r.id}
                            batchSelected={false}
                            onSelect={handleSelectReport}
                            onToggleBatch={() => {}}
                            finalLabel={finalLabel}
                            setFinalLabel={setFinalLabel}
                            appealOutcome={appealOutcome}
                            setAppealOutcome={setAppealOutcome}
                            maliciousActors={maliciousActors}
                            toggleMalicious={toggleMalicious}
                            onOpenConfirm={() => {}}
                            onDeepDive={setDeepDiveWallet}
                            moderatorAddress={moderatorAddress}
                            processingId={processingId}
                            loadingActors={loadingActors && selectedReport?.id === r.id}
                        />
                    ))}
                </div>
            )}

            </div> {/* end right content */}
            </div> {/* end two-column layout */}

            {/* ── Batch Finalize Bottom Bar ── */}
            {batchSelected.size > 0 && (
                <div className="fixed bottom-0 left-0 right-0 bg-neutral-950 border-t border-neutral-800 shadow-xl px-6 py-4 flex items-center justify-between gap-4 z-40">
                    <p className="text-sm font-medium text-neutral-300">
                        {batchSelected.size} report{batchSelected.size !== 1 ? 's' : ''} selected
                    </p>
                    <div className="flex items-center gap-3">
                        <select
                            value={batchLabel}
                            onChange={e => setBatchLabel(Number(e.target.value) as FinalLabel)}
                            className="text-sm border border-neutral-700 rounded-lg px-3 py-2 bg-neutral-900 text-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-600"
                        >
                            {[FinalLabel.CORROBORATED, FinalLabel.NEEDS_EVIDENCE, FinalLabel.DISPUTED, FinalLabel.FALSE_OR_MANIPULATED].map(lbl => (
                                <option key={lbl} value={lbl}>{FINAL_LABEL_NAMES[lbl]}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => setBatchSelected(new Set())}
                            className="px-4 py-2 border border-neutral-700 rounded-lg text-sm text-neutral-400 hover:text-white hover:border-neutral-500 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleBatchFinalize}
                            disabled={batchProcessing}
                            className="px-5 py-2 bg-white hover:bg-neutral-200 text-black rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
                        >
                            {batchProcessing ? <ArrowPathIcon className="w-4 h-4 animate-spin" /> : <ShieldCheckIcon className="w-4 h-4" />}
                            Batch Finalize
                        </button>
                    </div>
                </div>
            )}

            {/* ── Actor Deep-Dive Panel ── */}
            {deepDiveWallet && (
                <ActorDeepDivePanel wallet={deepDiveWallet} onClose={() => setDeepDiveWallet(null)} />
            )}

            {/* ── Confirm Finalize Modal ── */}
            {showConfirmModal && selectedReport && (
                <ConfirmFinalizeModal
                    report={selectedReport}
                    label={finalLabel}
                    appeal={appealOutcome}
                    maliciousSet={maliciousActors}
                    processing={processingId !== null}
                    onConfirm={handleFinalize}
                    onClose={() => setShowConfirmModal(false)}
                />
            )}

            {/* Guidelines */}
            <div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
                <div className="flex items-start gap-3">
                    <ExclamationTriangleIcon className="h-5 w-5 text-neutral-500 mt-0.5 shrink-0" />
                    <div className="text-sm text-neutral-400 space-y-1">
                        <p className="font-semibold text-white">Settlement Rules</p>
                        <ul className="list-disc pl-4 space-y-0.5">
                            <li><strong className="text-neutral-300">FALSE_OR_MANIPULATED:</strong> reporter + supporter stakes slashed, −10 / −2 Rep + slash penalty −5 each</li>
                            <li><strong className="text-neutral-300">CORROBORATED:</strong> all stakes returned, reporter +8 Rep, supporters +1 Rep</li>
                            <li><strong className="text-neutral-300">Malicious flag:</strong> stake slashed + additional −5 Rep + strike issued</li>
                            <li><strong className="text-neutral-300">Appeal Abusive:</strong> full bond slashed, −5 Rep + strike</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ProtocolModeratorDashboard;
