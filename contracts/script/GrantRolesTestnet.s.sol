// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/CovertProtocol.sol";
import "../src/CovertBadges.sol";

/**
 * @title GrantRolesTestnet
 * @notice Grants MODERATOR_ROLE on CovertProtocol AND mints MODERATOR_BADGE SBTs
 *         on CovertBadges for all three testnet moderator accounts.
 *         Safe to re-run: skips mintBadge if the badge already exists.
 *
 * Required .env variables:
 *   PRIVATE_KEY         – deployer private key (must hold DEFAULT_ADMIN_ROLE)
 *   MODERATOR_ADDRESS_1 – 0xa429C534cF66A83bFbFFF1163ce4e7c4f907f136
 *   MODERATOR_ADDRESS_2 – 0xE06C3F820586b4e31C001565b4eB9D18fBB0C0C7
 *   MODERATOR_ADDRESS_3 – 0x52e0ec9dcfF2FF7082927414cEe58F4Aac976C03
 *
 * Usage:
 *   forge script script/GrantRolesTestnet.s.sol --rpc-url https://sepolia.base.org --broadcast
 */
contract GrantRolesTestnet is Script {
    address constant PROTOCOL = 0x5B7AB21B2656BD187c3B544937eac9f36d901CbA;
    address constant BADGES   = 0x81ec2Fe3467535fd8e3A8a5bc00Bc226f2fedda4;

    function grantModerator(CovertProtocol protocol, CovertBadges badges, address addr) internal {
        // Revoke REVIEWER_ROLE first if held — contract enforces mutual exclusivity
        if (protocol.hasRole(protocol.REVIEWER_ROLE(), addr)) {
            protocol.revokeRole(protocol.REVIEWER_ROLE(), addr);
            console.log("[OK] Reviewer role revoked for:", addr);
        }

        // Grant MODERATOR_ROLE (idempotent — AccessControl ignores duplicate grants)
        protocol.grantRole(protocol.MODERATOR_ROLE(), addr);

        // Only mint badge if not already minted (tokenId 0 = none)
        if (badges.badgeTokenId(addr, CovertBadges.BadgeType.MODERATOR_BADGE) == 0) {
            badges.mintBadge(addr, CovertBadges.BadgeType.MODERATOR_BADGE);
            console.log("[OK] Badge minted for:", addr);
        } else {
            console.log("[SKIP] Badge already exists for:", addr);
        }
        console.log("[OK] Role granted for:", addr);
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address moderator1  = vm.envAddress("MODERATOR_ADDRESS_1");
        address moderator2  = vm.envAddress("MODERATOR_ADDRESS_2");
        address moderator3  = vm.envAddress("MODERATOR_ADDRESS_3");

        CovertProtocol protocol = CovertProtocol(PROTOCOL);
        CovertBadges   badges   = CovertBadges(BADGES);

        console.log("=== GrantRolesTestnet ===");
        console.log("Protocol:", PROTOCOL);
        console.log("Badges:  ", BADGES);

        vm.startBroadcast(deployerKey);

        grantModerator(protocol, badges, moderator1);
        grantModerator(protocol, badges, moderator2);
        grantModerator(protocol, badges, moderator3);

        vm.stopBroadcast();

        console.log("=== Done ===");
    }
}
