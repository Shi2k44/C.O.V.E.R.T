/**
 * C.O.V.E.R.T - ProfileButton Component
 *
 * Shows role, COV balance, reputation score, and badge next to the wallet button.
 */

import { useState } from 'react';
import {
  UserCircleIcon,
  ShieldCheckIcon,
  StarIcon,
  LockClosedIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { useRoleAccess } from '@/hooks/useRoleAccess';
import { BadgeType } from '@/types/protocol';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatCov(raw: string): string {
  const n = parseFloat(raw);
  if (isNaN(n)) return '0';
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
}

type RoleLabel = 'Moderator' | 'User';

const ROLE_CONFIG: Record<RoleLabel, { color: string; bg: string; ringColor: string; Icon: React.ElementType }> = {
  Moderator: {
    color: 'text-purple-400',
    bg: 'bg-purple-900/30',
    ringColor: 'ring-purple-700',
    Icon: ShieldCheckIcon,
  },
  User: {
    color: 'text-neutral-400',
    bg: 'bg-neutral-800',
    ringColor: 'ring-neutral-600',
    Icon: UserCircleIcon,
  },
};

const TIER_CONFIG: Record<string, { label: string; color: string }> = {
  tier_3: { label: 'Tier 3', color: 'text-purple-400'  },
  tier_2: { label: 'Tier 2', color: 'text-blue-400'    },
  tier_1: { label: 'Tier 1', color: 'text-green-400'   },
  tier_0: { label: 'Tier 0', color: 'text-neutral-500' },
  user:   { label: '—',      color: 'text-neutral-500' },
};

function BadgeLabel({ badges }: { badges: { type: BadgeType; active: boolean }[] }) {
  const activeBadges = badges.filter((b) => b.active);
  const roleBadge =
    activeBadges.find((b) => b.type === BadgeType.MODERATOR_BADGE);
  const highestTier = activeBadges
    .filter((b) => b.type <= BadgeType.TIER_3_POWER)
    .sort((a, b) => b.type - a.type)[0];
  const displayed = roleBadge ?? highestTier;
  if (!displayed) return <span className="text-neutral-500 text-xs">No badge</span>;

  const BADGE_NAMES: Record<BadgeType, string> = {
    [BadgeType.TIER_0_NEW]:      'New Member',
    [BadgeType.TIER_1_REGULAR]:  'Regular',
    [BadgeType.TIER_2_TRUSTED]:  'Trusted',
    [BadgeType.TIER_3_POWER]:    'Power User',
    [BadgeType.REVIEWER_BADGE]:  'Reviewer Badge',
    [BadgeType.MODERATOR_BADGE]: 'Moderator Badge',
  };
  const BADGE_COLORS: Record<BadgeType, string> = {
    [BadgeType.TIER_0_NEW]:      'text-neutral-500',
    [BadgeType.TIER_1_REGULAR]:  'text-green-400',
    [BadgeType.TIER_2_TRUSTED]:  'text-blue-400',
    [BadgeType.TIER_3_POWER]:    'text-orange-400',
    [BadgeType.REVIEWER_BADGE]:  'text-blue-400',
    [BadgeType.MODERATOR_BADGE]: 'text-purple-400',
  };

  return (
    <span className={`text-xs font-medium flex items-center gap-1 ${BADGE_COLORS[displayed.type]}`}>
      <StarIcon className="w-3 h-3" />
      {BADGE_NAMES[displayed.type]}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function ProfileButton() {
  const {
    connected, loading,
    isModerator,
    covBalance, lockedBalance, badges,
    reputationScore, reputationTier,
  } = useRoleAccess();
  const [open, setOpen] = useState(false);

  if (!connected) return null;

  const role: RoleLabel = isModerator ? 'Moderator' : 'User';
  const { color, bg, ringColor, Icon } = ROLE_CONFIG[role];
  const tierCfg = TIER_CONFIG[reputationTier] ?? TIER_CONFIG.user;
  const showRepScore = true; // every connected wallet has a rep score (spec §1)

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Your profile"
        className={`
          flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-all
          ${bg} ${color} border-neutral-700 hover:ring-2 ${ringColor}
        `}
      >
        <Icon className="w-5 h-5" />
        <span className="text-sm font-medium hidden sm:block">{role}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute right-0 mt-2 w-72 bg-neutral-950 rounded-xl shadow-xl border border-neutral-800 z-50 overflow-hidden">
            {/* Role header */}
            <div className={`px-4 py-3 flex items-center gap-3 ${bg}`}>
              <div className="p-2 rounded-full bg-neutral-900 border border-neutral-700">
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
              <div>
                <p className="text-xs text-neutral-500 font-medium uppercase tracking-wider">Role</p>
                <p className={`font-semibold ${color}`}>{role}</p>
              </div>
            </div>

            <div className="divide-y divide-neutral-800">
              {/* Reputation score */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-neutral-400">
                  <ChartBarIcon className="w-4 h-4" />
                  <span className="text-sm">Reputation</span>
                </div>
                {loading ? (
                  <span className="text-neutral-500 text-sm animate-pulse">…</span>
                ) : showRepScore ? (
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white text-sm">{reputationScore}</span>
                    <span className={`text-xs font-medium ${tierCfg.color}`}>{tierCfg.label}</span>
                  </div>
                ) : (
                  <span className="text-neutral-500 text-xs">Not ranked yet</span>
                )}
              </div>

              {/* COV Tokens */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-neutral-400">
                  <span className="text-base font-bold text-amber-500">◈</span>
                  <span className="text-sm">COV Tokens</span>
                </div>
                {loading ? (
                  <span className="text-neutral-500 text-sm animate-pulse">…</span>
                ) : (
                  <span className="font-semibold text-white text-sm">
                    {formatCov(covBalance)} COV
                  </span>
                )}
              </div>

              {/* Locked — only when non-zero */}
              {parseFloat(lockedBalance) > 0 && (
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-neutral-500">
                    <LockClosedIcon className="w-4 h-4" />
                    <span className="text-sm">Locked</span>
                  </div>
                  <span className="text-sm text-neutral-500">{formatCov(lockedBalance)} COV</span>
                </div>
              )}

              {/* Badge */}
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-neutral-400">Badge</span>
                {loading ? (
                  <span className="text-neutral-500 text-sm animate-pulse">…</span>
                ) : (
                  <BadgeLabel badges={badges} />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ProfileButton;
