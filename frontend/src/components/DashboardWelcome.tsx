/**
 * C.O.V.E.R.T - Dashboard Welcome / Onboarding Panel
 *
 * Shown once per wallet address per role on first dashboard visit.
 * Dismissed state persisted in localStorage keyed by address + role.
 */

import { useState, useEffect } from 'react';
import {
  XMarkIcon,
  DocumentPlusIcon,
  ShieldCheckIcon,
  CurrencyDollarIcon,
  StarIcon,
  ChevronRightIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import { PlatformRole, ROLE_LABELS } from '@/config/roles';

interface Props {
  role: PlatformRole;
  walletAddress?: string;
}

interface InfoCard {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const ROLE_CONTENT: Record<PlatformRole, { headline: string; subline: string; cards: InfoCard[] }> = {
  user: {
    headline: 'Welcome, Reporter',
    subline: 'You are connected as a Reporter. Here is what you can do on C.O.V.E.R.T.',
    cards: [
      {
        icon: <DocumentPlusIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Submit Reports',
        description:
          'Use "Submit Report" to upload encrypted evidence. Your identity stays private via zero-knowledge proofs — only the content is verified on-chain.',
      },
      {
        icon: <EyeIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Track Your Submissions',
        description:
          'Visit "My Reports" to see the live status of every report: Pending → Under Review → Verified or Rejected.',
      },
      {
        icon: <CurrencyDollarIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'COV Tokens',
        description:
          'You receive 30 COV tokens on sign-up. Tokens are staked when you submit a report and unlocked after the review cycle completes. Verified reports earn bonus tokens.',
      },
      {
        icon: <StarIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Reputation Score',
        description:
          'Your reputation grows with each verified report. Higher scores unlock reviewer privileges and increase your credibility weighting in future submissions.',
      },
    ],
  },
  moderator: {
    headline: 'Welcome, Protocol Moderator',
    subline: 'You hold a Moderator Badge. You issue the final verdict on reports.',
    cards: [
      {
        icon: <ShieldCheckIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Final Moderation',
        description:
          'After at least 1 reviewer has assessed a report, it enters your queue. You apply the final label: Verified, Rejected, or Escalated. At least 2 moderators must agree before a decision is recorded on-chain.',
      },
      {
        icon: <DocumentPlusIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Submit Your Own Reports',
        description:
          'Moderators can submit reports too. Your own reports are excluded from your moderation queue and handled by other moderators.',
      },
      {
        icon: <CurrencyDollarIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'COV Token Rewards',
        description:
          'Finalizing a report earns COV tokens. Decisions that match the on-chain consensus earn a quality bonus. Tokens accumulate in your wallet and can be staked for governance.',
      },
      {
        icon: <StarIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />,
        title: 'Consensus Requirement',
        description:
          'A minimum of 2 distinct moderators must finalize a report before the on-chain decision is written. This prevents single-point bias and ensures protocol integrity.',
      },
    ],
  },
};

function getStorageKey(address: string, role: PlatformRole) {
  return `covert_welcome_dismissed_${address.toLowerCase()}_${role}`;
}

export function DashboardWelcome({ role, walletAddress }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!walletAddress) return;
    const key = getStorageKey(walletAddress, role);
    const dismissed = localStorage.getItem(key);
    if (!dismissed) setVisible(true);
  }, [walletAddress, role]);

  function dismiss() {
    if (walletAddress) {
      localStorage.setItem(getStorageKey(walletAddress, role), '1');
    }
    setVisible(false);
  }

  if (!visible) return null;

  const content = ROLE_CONTENT[role];
  const roleLabel = ROLE_LABELS[role];

  return (
    <div
      className="rounded-2xl border bg-neutral-950 p-6 mb-2"
      style={{ borderColor: 'rgba(232,75,26,0.35)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: 'rgba(232,75,26,0.15)' }}
          >
            <ShieldCheckIcon className="h-5 w-5" style={{ color: '#E84B1A' }} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">{content.headline}</h2>
            <p className="text-sm text-neutral-400">{content.subline}</p>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-neutral-800 transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Role badge */}
      <div className="mb-5">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
          style={{
            backgroundColor: 'rgba(232,75,26,0.15)',
            color: '#E84B1A',
            border: '1px solid rgba(232,75,26,0.3)',
          }}
        >
          <ChevronRightIcon className="h-3 w-3" />
          Your role: {roleLabel}
        </span>
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
        {content.cards.map((card) => (
          <div
            key={card.title}
            className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4"
          >
            <div className="flex items-center gap-2 mb-2">
              {card.icon}
              <span className="text-sm font-semibold text-white">{card.title}</span>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">{card.description}</p>
          </div>
        ))}
      </div>

      {/* Dismiss */}
      <div className="flex justify-end">
        <button
          onClick={dismiss}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium text-white transition-all"
          style={{ backgroundColor: '#E84B1A' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#ff5c28'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#E84B1A'; }}
        >
          Got it, let's go
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default DashboardWelcome;
