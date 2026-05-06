/**
 * C.O.V.E.R.T - Role Configuration
 *
 * Maps specific wallet addresses to platform roles.
 * In production, roles are determined by on-chain badge ownership via CovertBadges.
 * This file provides the dev/test fallback using the standard Hardhat/Anvil accounts.
 *
 * Test accounts (Hardhat / Anvil defaults):
 *   0  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  — normal user
 *   1  0x70997970C51812dc3A010C7d01b50e0d17dc79C8  — normal user
 *   2  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC  — reviewer
 *   3  0x90F79bf6EB2c4f870365E785982E1f101E93b906  — moderator
 *   4  0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65  — reviewer
 *   5  0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc  — normal user
 *   6  0x976EA74026E726554dB657fA54763abd0C3a0aa9  — moderator
 *   7  0x14dC79964da2C08b23698B3D3cc7Ca32193d9955  — normal user
 *   8  0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f  — normal user
 *   9  0xa0Ee7A142d267C1f36714E4a8F75612F20a79720  — moderator
 */

export type PlatformRole = 'user' | 'moderator';

// All comparisons use lowercase addresses.
// These are the testnet moderator accounts (Base Sepolia).
const MODERATOR_ADDRESSES = new Set([
    '0xa429c534cf66a83bfbfff1163ce4e7c4f907f136', // Moderator 1
    '0xe06c3f820586b4e31c001565b4eb9d18fbb0c0c7', // Moderator 2
    '0x52e0ec9dcff2ff7082927414cee58f4aac976c03', // Moderator 3
]);

export function getAddressRole(address: string): PlatformRole {
    const lower = address.toLowerCase();
    if (MODERATOR_ADDRESSES.has(lower)) return 'moderator';
    return 'user';
}

export function isModeratorAddress(address: string): boolean {
    return MODERATOR_ADDRESSES.has(address.toLowerCase());
}

/** Human-readable role label. */
export const ROLE_LABELS: Record<PlatformRole, string> = {
    user: 'Reporter',
    moderator: 'Protocol Moderator',
};

/** Badge classes per role. */
export const ROLE_BADGE_STYLES: Record<PlatformRole, string> = {
    user: 'bg-neutral-800 text-neutral-300',
    moderator: 'bg-purple-900/40 text-purple-400',
};
