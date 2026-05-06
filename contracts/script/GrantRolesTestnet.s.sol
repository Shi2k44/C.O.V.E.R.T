// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/CovertProtocol.sol";
import "../src/CovertBadges.sol";

/**
 * @title GrantRolesTestnet
 * @notice Grants MODERATOR_ROLE on CovertProtocol AND mints MODERATOR_BADGE SBTs
 *         on CovertBadges for all three testnet moderator accounts.
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

        // ── Moderator 1 ──
        protocol.grantRole(protocol.MODERATOR_ROLE(), moderator1);
        badges.mintBadge(moderator1, CovertBadges.BadgeType.MODERATOR_BADGE);
        console.log("[OK] Moderator 1:", moderator1);

        // ── Moderator 2 ──
        protocol.grantRole(protocol.MODERATOR_ROLE(), moderator2);
        badges.mintBadge(moderator2, CovertBadges.BadgeType.MODERATOR_BADGE);
        console.log("[OK] Moderator 2:", moderator2);

        // ── Moderator 3 ──
        protocol.grantRole(protocol.MODERATOR_ROLE(), moderator3);
        badges.mintBadge(moderator3, CovertBadges.BadgeType.MODERATOR_BADGE);
        console.log("[OK] Moderator 3:", moderator3);

        vm.stopBroadcast();

        console.log("=== Done ===");
    }
}
