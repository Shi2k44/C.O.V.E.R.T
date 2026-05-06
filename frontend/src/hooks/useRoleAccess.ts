import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useWeb3 } from './useWeb3';
import { protocolService } from '@/services/protocol';
import { BadgeType } from '@/types/protocol';
import { getAddressRole } from '@/config/roles';
import { useCovBalanceStore } from '@/stores/covBalanceStore';
import { API_BASE } from '@/config';

interface RoleAccessState {
  loading: boolean;
  isModerator: boolean;
  covBalance: string;
  lockedBalance: string;
  badges: { type: BadgeType; active: boolean; tokenId: string }[];
  reputationScore: number;
  reputationTier: string;
}

const INITIAL: RoleAccessState = {
  loading: true,
  isModerator: false,
  covBalance: '0',
  lockedBalance: '0',
  badges: [],
  reputationScore: 0,
  reputationTier: 'user',
};

async function fetchReputation(address: string): Promise<{ reputation_score: number; tier: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/reputation/wallet/${address}`);
    if (!res.ok) return { reputation_score: 0, tier: 'user' };
    return await res.json();
  } catch {
    return { reputation_score: 0, tier: 'user' };
  }
}

/** localStorage key used to remember that the welcome grant was already claimed.
 *  Versioned — bump the suffix (v2, v3…) whenever a fresh-start wipe happens
 *  so all users get the welcome grant once more on next login. */
function welcomeClaimedKey(address: string) {
  return `covert_welcome_claimed_v2_${address.toLowerCase()}`;
}

export function useRoleAccess() {
  const { walletState } = useWeb3();
  const [state, setState] = useState<RoleAccessState>(INITIAL);
  // Track whether the initial load has completed — background refreshes must NOT
  // set loading:true (that causes the dashboard to unmount and "reload" visually).
  const initialLoadDone = useRef(false);

  // Stable address ref so the COV balance selector doesn't recreate on every render
  const addressRef = useRef(walletState.address);
  addressRef.current = walletState.address;
  const covBalanceLive = useCovBalanceStore(
    (s) => addressRef.current ? s.getBalance(addressRef.current) : 0
  );

  useEffect(() => {
    let cancelled = false;

    const loadRoles = async (isBackground = false) => {
      if (!walletState.connected || !walletState.address) {
        initialLoadDone.current = false;
        setState({ ...INITIAL, loading: false });
        return;
      }

      protocolService.configure({
        covCreditsAddress: import.meta.env.VITE_COV_CREDITS_ADDRESS || '',
        covertBadgesAddress: import.meta.env.VITE_COVERT_BADGES_ADDRESS || '',
        covertProtocolAddress: import.meta.env.VITE_COVERT_PROTOCOL_ADDRESS || '',
      });

      // Only show the loading spinner on the very first load.
      if (!isBackground) {
        setState((prev) => ({ ...prev, loading: true }));
      }

      try {
        if (import.meta.env.VITE_DEV_MODE === 'true') {
          const role = getAddressRole(walletState.address);
          console.info(`[DEV MODE] Address ${walletState.address} → role: ${role}`);
          const repData = await fetchReputation(walletState.address);

          if (import.meta.env.VITE_COVERT_PROTOCOL_ADDRESS) {
            try {
              await protocolService.connect();
              const userState = await protocolService.getUserState(walletState.address);
              const onChainBal = parseFloat(userState.covBalance);
              useCovBalanceStore.getState().setBalance(walletState.address, onChainBal);
            } catch {
              // Contract not reachable in this dev session — store balance stays as-is
            }
          }

          if (!cancelled) {
            initialLoadDone.current = true;
            setState({
              loading: false,
              isModerator: role === 'moderator',
              covBalance: '0', // overridden by covBalanceLive from store below
              lockedBalance: '0',
              badges: [],
              reputationScore: repData.reputation_score,
              reputationTier: repData.tier,
            });
          }
          return;
        }

        await protocolService.connect();

        const [userState, repData] = await Promise.all([
          protocolService.getUserState(walletState.address),
          fetchReputation(walletState.address),
        ]);

        // ── Auto-claim 30 COV welcome grant for new users ──────────────────
        // Guard with localStorage so we never attempt the claim twice for the
        // same wallet (avoids redundant wallet prompts on every login).
        const alreadyClaimed =
          userState.welcomeClaimed ||
          localStorage.getItem(welcomeClaimedKey(walletState.address)) === '1';

        if (!alreadyClaimed) {
          toast.loading('Welcome! Confirm in your wallet to receive 30 COV tokens…', {
            id: 'welcome-claim',
          });
          try {
            await protocolService.claimWelcome();
            const refreshed = await protocolService.getUserState(walletState.address);
            userState.covBalance = refreshed.covBalance;
            userState.welcomeClaimed = true;
            // Persist so future logins skip the claim attempt entirely
            localStorage.setItem(welcomeClaimedKey(walletState.address), '1');
            toast.success('30 COV tokens added to your account!', { id: 'welcome-claim' });
          } catch {
            toast.dismiss('welcome-claim');
            // User rejected or tx failed — they can try again manually
          }
        }

        const isModerator = userState.badges.some(
          (badge) => badge.type === BadgeType.MODERATOR_BADGE && badge.active
        );

        if (!cancelled) {
          initialLoadDone.current = true;
          setState({
            loading: false,
            isModerator,
            covBalance: userState.covBalance,
            lockedBalance: userState.lockedBalance,
            badges: userState.badges,
            reputationScore: repData.reputation_score,
            reputationTier: repData.tier,
          });
        }
      } catch {
        if (import.meta.env.VITE_DEV_MODE === 'true') {
          const role = getAddressRole(walletState.address);
          if (!cancelled) {
            initialLoadDone.current = true;
            setState({
              loading: false,
              isModerator: role === 'moderator',
              covBalance: '0',
              lockedBalance: '0',
              badges: [],
              reputationScore: 0,
              reputationTier: 'tier_0',
            });
          }
          return;
        }
        if (!cancelled) {
          initialLoadDone.current = true;
          setState(INITIAL);
        }
      }
    };

    // Initial load (shows spinner)
    loadRoles(false);

    // Re-run silently when a finalized report triggers a rep refresh
    const onRepRefresh = () => { loadRoles(true); };
    window.addEventListener('covert:rep-refresh', onRepRefresh);

    // Poll every 60s silently — no loading spinner
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') loadRoles(true);
    }, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('covert:rep-refresh', onRepRefresh);
    };
  }, [walletState.connected, walletState.address]);

  // In dev mode, always serve the live store balance so it updates immediately
  // after a stake without waiting for the hook's effect to re-run.
  const covBalanceOut =
    import.meta.env.VITE_DEV_MODE === 'true' && walletState.address
      ? String(covBalanceLive)
      : state.covBalance;

  return { ...state, covBalance: covBalanceOut, connected: walletState.connected };
}

export default useRoleAccess;
