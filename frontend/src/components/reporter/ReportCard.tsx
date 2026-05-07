/**
 * C.O.V.E.R.T - Report Card Component
 */

import { memo, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheckIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { Report, ReportStatus, ReportVisibility, ReportCategory } from '@/stores/reportStore';

interface ReportCardProps {
  report: Report;
  onClick?: () => void;
  compact?: boolean;
  onDelete?: (id: string) => void;
  onAppeal?: (report: Report) => void;
  onResubmit?: (report: Report) => void;
  onReAppeal?: (report: Report) => void;
}

const statusConfig: Record<ReportStatus, { label: string; color: string; icon: React.ElementType }> = {
  // Active lifecycle statuses
  pending_review: {
    label: 'Pending',
    color: 'bg-yellow-900/40 text-yellow-400',
    icon: ClockIcon,
  },
  needs_evidence: {
    label: 'Needs Evidence',
    color: 'bg-amber-900/40 text-amber-400',
    icon: ExclamationTriangleIcon,
  },
  rejected_by_reviewer: {
    label: 'Rejected',
    color: 'bg-red-900/30 text-red-400',
    icon: XCircleIcon,
  },
  pending_moderation: {
    label: 'Under Moderation',
    color: 'bg-blue-900/40 text-blue-400',
    icon: EyeIcon,
  },
  appealed: {
    label: 'Appealed',
    color: 'bg-purple-900/40 text-purple-400',
    icon: ExclamationTriangleIcon,
  },
  verified: {
    label: 'Verified',
    color: 'bg-green-900/40 text-green-400',
    icon: CheckCircleIcon,
  },
  rejected: {
    label: 'Rejected',
    color: 'bg-red-900/40 text-red-400',
    icon: XCircleIcon,
  },
  archived: {
    label: 'Archived',
    color: 'bg-neutral-800 text-neutral-500',
    icon: ClockIcon,
  },
  // Legacy statuses
  pending: {
    label: 'Pending',
    color: 'bg-yellow-900/40 text-yellow-400',
    icon: ClockIcon,
  },
  under_review: {
    label: 'Under Review',
    color: 'bg-blue-900/40 text-blue-400',
    icon: EyeIcon,
  },
  disputed: {
    label: 'Disputed',
    color: 'bg-orange-900/40 text-orange-400',
    icon: ExclamationTriangleIcon,
  },
};

const categoryLabels: Record<ReportCategory, string> = {
  corruption: 'Corruption',
  fraud: 'Fraud',
  safety: 'Safety Violation',
  environment: 'Environmental',
  human_rights: 'Human Rights',
  other: 'Other',
};

const decisionLabelConfig: Record<string, { label: string; color: string }> = {
  // Moderator final labels
  CORROBORATED: { label: 'Corroborated', color: 'bg-green-900/40 text-green-400 border-green-800/50' },
  DISPUTED: { label: 'Disputed', color: 'bg-orange-900/40 text-orange-400 border-orange-800/50' },
  NEEDS_EVIDENCE: { label: 'Needs Evidence', color: 'bg-amber-900/40 text-amber-400 border-amber-800/50' },
  FALSE_OR_MANIPULATED: { label: 'False / Manipulated', color: 'bg-red-900/40 text-red-400 border-red-800/50' },
};

const visibilityConfig: Record<ReportVisibility, { label: string; icon: React.ElementType }> = {
  private: { label: 'Private', icon: EyeSlashIcon },
  moderated: { label: 'Moderated', icon: EyeIcon },
  public: { label: 'Public', icon: EyeIcon },
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateHash(hash: string, length: number = 8): string {
  if (hash.length <= length * 2 + 3) return hash;
  return `${hash.slice(0, length)}...${hash.slice(-length)}`;
}

export const ReportCard = memo(function ReportCard({
  report,
  onClick,
  compact = false,
  onDelete,
  onAppeal,
  onResubmit,
  onReAppeal,
}: ReportCardProps) {
  const navigate = useNavigate();

  const formattedDate = useMemo(
    () => formatDate(report.submittedAt),
    [report.submittedAt]
  );

  const handleClick = useCallback(() => {
    if (onClick) {
      onClick();
    } else {
      navigate(`/report/${report.id}`);
    }
  }, [onClick, navigate, report.id]);

  const statusInfo = statusConfig[report.status] ?? {
    label: report.status ?? 'Unknown',
    color: 'bg-neutral-800 text-neutral-400',
    icon: ClockIcon,
  };
  const StatusIcon = statusInfo.icon;
  const visibilityInfo = visibilityConfig[report.visibility] ?? { label: report.visibility ?? 'Unknown', icon: EyeIcon };
  const VisibilityIcon = visibilityInfo.icon;
  const categoryLabel = categoryLabels[report.category] ?? report.category ?? 'Unknown';

  if (compact) {
    return (
      <div
        onClick={handleClick}
        className="flex items-center justify-between p-4 bg-neutral-950 border border-neutral-800 rounded-xl hover:border-neutral-600 transition-all cursor-pointer"
      >
        <div className="flex items-center space-x-4">
          <div className={`flex items-center px-2 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {statusInfo.label}
          </div>
          <span className="text-sm text-neutral-400">
            {categoryLabel}
          </span>
          <span className="text-sm text-neutral-500">
            {formattedDate}
          </span>
        </div>
        <ChevronRightIcon className="h-5 w-5 text-neutral-600" />
      </div>
    );
  }

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) onDelete(report.id);
  }, [onDelete, report.id]);

  return (
    <div
      onClick={handleClick}
      className="rounded-2xl border border-neutral-800 bg-neutral-950 hover:border-neutral-600 transition-all cursor-pointer p-6"
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex-1">
          {/* Status and Category Badges */}
          <div className="flex items-center space-x-2 mb-2">
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
            {/* Final decision label (moderator) or reviewer decision */}
            {(report.finalLabel || report.reviewDecisionLabel) && (() => {
              const key = report.finalLabel || report.reviewDecisionLabel || '';
              const cfg = decisionLabelConfig[key];
              if (!cfg) return null;
              return (
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
                  {cfg.label}
                </span>
              );
            })()}
          </div>

          {/* Report ID/Title */}
          <h3 className="text-lg font-semibold text-white mb-1">
            {report.title || `Report #${report.id.slice(0, 8)}`}
          </h3>

          {/* Submission Info */}
          <p className="text-sm text-neutral-500">
            Submitted {formattedDate} &bull; {formatFileSize(report.fileSize)}
          </p>
        </div>

        {/* Verification Score + Delete */}
        <div className="flex items-start gap-3 ml-4">
          {report.verificationScore !== undefined && (
            <div className="flex flex-col items-end">
              <span className="text-sm text-neutral-500">Credibility</span>
              <span className={`text-2xl font-bold ${report.verificationScore >= 0.7
                ? 'text-green-400'
                : report.verificationScore >= 0.4
                  ? 'text-yellow-400'
                  : 'text-red-400'
                }`}>
                {(report.verificationScore * 100).toFixed(0)}%
              </span>
            </div>
          )}
          {onDelete && (
            <button
              onClick={handleDeleteClick}
              className="p-1.5 rounded-lg border border-neutral-800 text-neutral-600 hover:border-neutral-600 hover:text-white transition-colors"
              title="Delete report"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Transaction Info */}
      <div className="flex items-center justify-between pt-4 border-t border-neutral-800">
        <div className="flex items-center text-sm text-neutral-500">
          <ShieldCheckIcon className="h-4 w-4 mr-1 text-green-500" />
          <span>On-chain verified</span>
          <span className="mx-2">&bull;</span>
          <span className="font-mono text-xs">
            {truncateHash(report.commitmentHash)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {onResubmit && (
            <button
              onClick={(e) => { e.stopPropagation(); onResubmit(report); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 text-neutral-300 border border-neutral-700 hover:border-neutral-500 hover:text-white transition-all"
            >
              Resubmit
            </button>
          )}
          {onAppeal && (
            <button
              onClick={(e) => { e.stopPropagation(); onAppeal(report); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-900/30 text-orange-400 border border-orange-800/50 hover:border-orange-600 hover:bg-orange-900/50 transition-all"
            >
              Appeal (8 COV)
            </button>
          )}
          {onReAppeal && (
            <button
              onClick={(e) => { e.stopPropagation(); onReAppeal(report); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-900/30 text-purple-400 border border-purple-800/50 hover:border-purple-600 hover:bg-purple-900/50 transition-all"
            >
              Re-appeal
            </button>
          )}
          {report.hasAppeal && !onReAppeal && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-purple-900/30 text-purple-400 border border-purple-800/50">
              Appealed
            </span>
          )}
          <ChevronRightIcon className="h-5 w-5 text-neutral-600" />
        </div>
      </div>

      {/* Risk Level Badge */}
      {report.riskLevel && (
        <div className="mt-3">
          <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${report.riskLevel === 'critical' ? 'bg-red-900/40 text-red-400' :
            report.riskLevel === 'high' ? 'bg-orange-900/40 text-orange-400' :
              report.riskLevel === 'medium' ? 'bg-yellow-900/40 text-yellow-400' :
                'bg-green-900/40 text-green-400'
            }`}>
            <ExclamationTriangleIcon className="h-3 w-3 mr-1" />
            {report.riskLevel.charAt(0).toUpperCase() + report.riskLevel.slice(1)} Risk
          </span>
        </div>
      )}
    </div>
  );
});

export default ReportCard;
