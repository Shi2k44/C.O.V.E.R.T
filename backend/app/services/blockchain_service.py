"""
C.O.V.E.R.T - Backend Blockchain Service

Handles server-side contract interactions for:
- Daily anchor submissions
- Event monitoring
- Transaction verification
"""

import asyncio
import json
import logging
from typing import Optional, List, Callable
from datetime import datetime
from dataclasses import dataclass

from web3 import Web3, AsyncWeb3
from web3.contract import Contract
from web3.types import TxReceipt, EventData
from eth_account import Account
from eth_account.signers.local import LocalAccount

from app.core.config import settings

logger = logging.getLogger(__name__)


# Contract ABIs
COMMITMENT_REGISTRY_ABI = json.loads("""
[
    {
        "inputs": [{"name": "_cidHash", "type": "bytes32"}, {"name": "_visibility", "type": "uint8"}],
        "name": "commit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "_cidHash", "type": "bytes32"}],
        "name": "getCommitment",
        "outputs": [
            {"name": "cidHash", "type": "bytes32"},
            {"name": "visibility", "type": "uint8"},
            {"name": "submitter", "type": "address"},
            {"name": "timestamp", "type": "uint256"},
            {"name": "isActive", "type": "bool"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "_cidHash", "type": "bytes32"}],
        "name": "isActive",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "name": "cidHash", "type": "bytes32"},
            {"indexed": true, "name": "submitter", "type": "address"},
            {"indexed": false, "name": "visibility", "type": "uint8"},
            {"indexed": false, "name": "timestamp", "type": "uint256"}
        ],
        "name": "ReportCommitted",
        "type": "event"
    }
]
""")

DAILY_ANCHOR_ABI = json.loads("""
[
    {
        "inputs": [
            {"name": "_date", "type": "uint256"},
            {"name": "_merkleRoot", "type": "bytes32"},
            {"name": "_actionCount", "type": "uint256"}
        ],
        "name": "submitAnchor",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "_date", "type": "uint256"}],
        "name": "getAnchor",
        "outputs": [
            {"name": "merkleRoot", "type": "bytes32"},
            {"name": "actionCount", "type": "uint256"},
            {"name": "timestamp", "type": "uint256"},
            {"name": "operator", "type": "address"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "address"}],
        "name": "operators",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "name": "date", "type": "uint256"},
            {"indexed": false, "name": "merkleRoot", "type": "bytes32"},
            {"indexed": false, "name": "actionCount", "type": "uint256"},
            {"indexed": false, "name": "operator", "type": "address"}
        ],
        "name": "AnchorSubmitted",
        "type": "event"
    }
]
""")

COVERT_PROTOCOL_ABI = json.loads("""
[
    {
        "inputs": [{"name": "role", "type": "bytes32"}, {"name": "account", "type": "address"}],
        "name": "grantRole",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "role", "type": "bytes32"}, {"name": "account", "type": "address"}],
        "name": "revokeRole",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "role", "type": "bytes32"}, {"name": "account", "type": "address"}],
        "name": "hasRole",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "REVIEWER_ROLE",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "MODERATOR_ROLE",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
        "type": "function"
    }
]
""")


@dataclass
class Commitment:
    """Commitment data from blockchain"""
    cid_hash: str
    visibility: int
    submitter: str
    timestamp: int
    is_active: bool


@dataclass
class Anchor:
    """Daily anchor data"""
    date: int
    merkle_root: str
    action_count: int
    timestamp: int
    operator: str


@dataclass
class TransactionResult:
    """Transaction result"""
    hash: str
    block_number: int
    status: str
    gas_used: int


class BlockchainServiceError(Exception):
    """Blockchain operation error"""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class BlockchainService:
    """
    Backend blockchain service for server-side operations
    """

    def __init__(self):
        self.w3: Optional[Web3] = None
        self.account: Optional[LocalAccount] = None
        self.automation_account: Optional[LocalAccount] = None
        self.commitment_registry: Optional[Contract] = None
        self.daily_anchor: Optional[Contract] = None
        self.covert_protocol: Optional[Contract] = None
        self._reviewer_role: Optional[bytes] = None
        self._moderator_role: Optional[bytes] = None
        self._event_callbacks: dict = {}

    async def initialize(self) -> None:
        """Initialize blockchain connection"""
        try:
            # Connect to RPC
            self.w3 = Web3(Web3.HTTPProvider(settings.RPC_URL))

            if not self.w3.is_connected():
                raise BlockchainServiceError(
                    "CONNECTION_FAILED",
                    f"Failed to connect to {settings.RPC_URL}"
                )

            logger.info(f"Connected to blockchain: {settings.RPC_URL}")
            logger.info(f"Chain ID: {self.w3.eth.chain_id}")

            # Initialize contracts
            if settings.COMMITMENT_REGISTRY_ADDRESS:
                self.commitment_registry = self.w3.eth.contract(
                    address=Web3.to_checksum_address(settings.COMMITMENT_REGISTRY_ADDRESS),
                    abi=COMMITMENT_REGISTRY_ABI
                )
                logger.info(f"CommitmentRegistry: {settings.COMMITMENT_REGISTRY_ADDRESS}")

            if settings.DAILY_ANCHOR_ADDRESS:
                self.daily_anchor = self.w3.eth.contract(
                    address=Web3.to_checksum_address(settings.DAILY_ANCHOR_ADDRESS),
                    abi=DAILY_ANCHOR_ABI
                )
                logger.info(f"DailyAnchor: {settings.DAILY_ANCHOR_ADDRESS}")

            if settings.COVERT_PROTOCOL_ADDRESS:
                self.covert_protocol = self.w3.eth.contract(
                    address=Web3.to_checksum_address(settings.COVERT_PROTOCOL_ADDRESS),
                    abi=COVERT_PROTOCOL_ABI
                )
                logger.info(f"CovertProtocol: {settings.COVERT_PROTOCOL_ADDRESS}")

            # Initialize automation signer if configured
            if settings.AUTOMATION_PRIVATE_KEY:
                self.automation_account = Account.from_key(settings.AUTOMATION_PRIVATE_KEY)
                logger.info(f"Automation signer: {self.automation_account.address}")

        except Exception as e:
            logger.error(f"Blockchain initialization failed: {e}")
            raise

    def set_signer(self, private_key: str) -> str:
        """
        Set the signer account for transactions

        Args:
            private_key: Hex-encoded private key

        Returns:
            Account address
        """
        self.account = Account.from_key(private_key)
        return self.account.address

    # ============ CommitmentRegistry Functions ============

    async def get_commitment(self, cid_hash: str) -> Optional[Commitment]:
        """
        Get commitment details

        Args:
            cid_hash: 0x-prefixed hash

        Returns:
            Commitment data or None
        """
        if not self.commitment_registry:
            raise BlockchainServiceError("NOT_INITIALIZED", "Contract not initialized")

        try:
            result = self.commitment_registry.functions.getCommitment(
                Web3.to_bytes(hexstr=cid_hash)
            ).call()

            if result[3] == 0:  # timestamp == 0 means doesn't exist
                return None

            return Commitment(
                cid_hash=result[0].hex(),
                visibility=result[1],
                submitter=result[2],
                timestamp=result[3],
                is_active=result[4]
            )
        except Exception as e:
            logger.error(f"Failed to get commitment: {e}")
            return None

    async def verify_commitment(self, cid_hash: str) -> bool:
        """
        Verify commitment exists and is active

        Args:
            cid_hash: 0x-prefixed hash

        Returns:
            True if valid
        """
        if not self.commitment_registry:
            return False

        try:
            return self.commitment_registry.functions.isActive(
                Web3.to_bytes(hexstr=cid_hash)
            ).call()
        except Exception:
            return False

    # ============ DailyAnchor Functions ============

    async def submit_anchor(
        self,
        date: int,
        merkle_root: str,
        action_count: int
    ) -> TransactionResult:
        """
        Submit a daily anchor

        Args:
            date: Date in YYYYMMDD format
            merkle_root: 0x-prefixed merkle root
            action_count: Number of actions

        Returns:
            Transaction result
        """
        if not self.daily_anchor or not self.account:
            raise BlockchainServiceError(
                "NOT_INITIALIZED",
                "Contract or signer not initialized"
            )

        try:
            # Build transaction
            tx = self.daily_anchor.functions.submitAnchor(
                date,
                Web3.to_bytes(hexstr=merkle_root),
                action_count
            ).build_transaction({
                'from': self.account.address,
                'nonce': self.w3.eth.get_transaction_count(self.account.address),
                'gas': 100000,
                'gasPrice': self.w3.eth.gas_price
            })

            # Sign and send
            signed_tx = self.w3.eth.account.sign_transaction(tx, self.account.key)
            tx_hash = self.w3.eth.send_raw_transaction(signed_tx.rawTransaction)

            logger.info(f"Anchor transaction sent: {tx_hash.hex()}")

            # Wait for receipt
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

            return TransactionResult(
                hash=receipt['transactionHash'].hex(),
                block_number=receipt['blockNumber'],
                status='success' if receipt['status'] == 1 else 'failed',
                gas_used=receipt['gasUsed']
            )

        except Exception as e:
            logger.error(f"Anchor submission failed: {e}")
            raise BlockchainServiceError("TX_FAILED", str(e))

    async def get_anchor(self, date: int) -> Optional[Anchor]:
        """
        Get anchor for a date

        Args:
            date: Date in YYYYMMDD format

        Returns:
            Anchor data or None
        """
        if not self.daily_anchor:
            raise BlockchainServiceError("NOT_INITIALIZED", "Contract not initialized")

        try:
            result = self.daily_anchor.functions.getAnchor(date).call()

            if result[2] == 0:  # timestamp == 0
                return None

            return Anchor(
                date=date,
                merkle_root="0x" + result[0].hex(),
                action_count=result[1],
                timestamp=result[2],
                operator=result[3]
            )
        except Exception as e:
            logger.error(f"Failed to get anchor: {e}")
            return None

    async def is_operator(self, address: str) -> bool:
        """Check if address is an authorized operator"""
        if not self.daily_anchor:
            return False

        try:
            return self.daily_anchor.functions.operators(
                Web3.to_checksum_address(address)
            ).call()
        except Exception:
            return False

    # ============ Event Monitoring ============

    async def get_recent_commitments(
        self,
        from_block: int = 0,
        to_block: str = 'latest'
    ) -> List[dict]:
        """
        Get recent report commitment events

        Args:
            from_block: Starting block
            to_block: Ending block

        Returns:
            List of commitment events
        """
        if not self.commitment_registry:
            return []

        try:
            event_filter = self.commitment_registry.events.ReportCommitted.create_filter(
                fromBlock=from_block,
                toBlock=to_block
            )
            events = event_filter.get_all_entries()

            return [
                {
                    'cid_hash': "0x" + e['args']['cidHash'].hex(),
                    'submitter': e['args']['submitter'],
                    'visibility': e['args']['visibility'],
                    'timestamp': e['args']['timestamp'],
                    'block_number': e['blockNumber'],
                    'tx_hash': e['transactionHash'].hex()
                }
                for e in events
            ]
        except Exception as e:
            logger.error(f"Failed to get events: {e}")
            return []

    async def get_recent_anchors(
        self,
        from_block: int = 0,
        to_block: str = 'latest'
    ) -> List[dict]:
        """Get recent anchor submission events"""
        if not self.daily_anchor:
            return []

        try:
            event_filter = self.daily_anchor.events.AnchorSubmitted.create_filter(
                fromBlock=from_block,
                toBlock=to_block
            )
            events = event_filter.get_all_entries()

            return [
                {
                    'date': e['args']['date'],
                    'merkle_root': "0x" + e['args']['merkleRoot'].hex(),
                    'action_count': e['args']['actionCount'],
                    'operator': e['args']['operator'],
                    'block_number': e['blockNumber'],
                    'tx_hash': e['transactionHash'].hex()
                }
                for e in events
            ]
        except Exception as e:
            logger.error(f"Failed to get anchor events: {e}")
            return []

    # ============ CovertProtocol: Reviewer Role Management ============

    async def _get_reviewer_role(self) -> bytes:
        """Cache and return the REVIEWER_ROLE bytes32 from the contract."""
        if self._reviewer_role is not None:
            return self._reviewer_role
        if not self.covert_protocol:
            raise BlockchainServiceError("NOT_INITIALIZED", "CovertProtocol not initialized")
        self._reviewer_role = self.covert_protocol.functions.REVIEWER_ROLE().call()
        return self._reviewer_role

    async def _get_moderator_role(self) -> bytes:
        """Cache and return the MODERATOR_ROLE bytes32 from the contract."""
        if self._moderator_role is not None:
            return self._moderator_role
        if not self.covert_protocol:
            raise BlockchainServiceError("NOT_INITIALIZED", "CovertProtocol not initialized")
        self._moderator_role = self.covert_protocol.functions.MODERATOR_ROLE().call()
        return self._moderator_role

    async def has_moderator_role(self, wallet_address: str) -> bool:
        """Check if a wallet currently holds the MODERATOR_ROLE on-chain."""
        if not self.covert_protocol:
            return False
        try:
            role = await self._get_moderator_role()
            return self.covert_protocol.functions.hasRole(
                role, Web3.to_checksum_address(wallet_address)
            ).call()
        except Exception as e:
            logger.error(f"Failed to check moderator role: {e}")
            return False

    async def has_reviewer_role(self, wallet_address: str) -> bool:
        """Check if a wallet currently holds the REVIEWER_ROLE on-chain."""
        if not self.covert_protocol:
            return False
        try:
            role = await self._get_reviewer_role()
            return self.covert_protocol.functions.hasRole(
                role, Web3.to_checksum_address(wallet_address)
            ).call()
        except Exception as e:
            logger.error(f"Failed to check reviewer role: {e}")
            return False

    async def grant_reviewer_role(self, wallet_address: str) -> TransactionResult:
        """Grant REVIEWER_ROLE to a wallet using the AUTOMATION_ROLE signer."""
        if not self.covert_protocol or not self.automation_account or not self.w3:
            raise BlockchainServiceError("NOT_INITIALIZED", "CovertProtocol or automation signer not initialized")

        role = await self._get_reviewer_role()
        addr = Web3.to_checksum_address(wallet_address)

        tx = self.covert_protocol.functions.grantRole(role, addr).build_transaction({
            'from': self.automation_account.address,
            'nonce': self.w3.eth.get_transaction_count(self.automation_account.address),
            'gas': 150000,
            'gasPrice': self.w3.eth.gas_price,
        })
        signed_tx = self.w3.eth.account.sign_transaction(tx, self.automation_account.key)
        tx_hash = self.w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        logger.info(f"Granted REVIEWER_ROLE to {wallet_address}, tx={receipt['transactionHash'].hex()}")

        return TransactionResult(
            hash=receipt['transactionHash'].hex(),
            block_number=receipt['blockNumber'],
            status='success' if receipt['status'] == 1 else 'failed',
            gas_used=receipt['gasUsed'],
        )

    async def revoke_reviewer_role(self, wallet_address: str) -> TransactionResult:
        """Revoke REVIEWER_ROLE from a wallet using the AUTOMATION_ROLE signer."""
        if not self.covert_protocol or not self.automation_account or not self.w3:
            raise BlockchainServiceError("NOT_INITIALIZED", "CovertProtocol or automation signer not initialized")

        role = await self._get_reviewer_role()
        addr = Web3.to_checksum_address(wallet_address)

        tx = self.covert_protocol.functions.revokeRole(role, addr).build_transaction({
            'from': self.automation_account.address,
            'nonce': self.w3.eth.get_transaction_count(self.automation_account.address),
            'gas': 150000,
            'gasPrice': self.w3.eth.gas_price,
        })
        signed_tx = self.w3.eth.account.sign_transaction(tx, self.automation_account.key)
        tx_hash = self.w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        logger.info(f"Revoked REVIEWER_ROLE from {wallet_address}, tx={receipt['transactionHash'].hex()}")

        return TransactionResult(
            hash=receipt['transactionHash'].hex(),
            block_number=receipt['blockNumber'],
            status='success' if receipt['status'] == 1 else 'failed',
            gas_used=receipt['gasUsed'],
        )

    # ============ Utility Functions ============

    def compute_cid_hash(self, cid: str) -> str:
        """Compute keccak256 hash of CID"""
        return Web3.keccak(text=cid).hex()

    def get_date_int(self, dt: Optional[datetime] = None) -> int:
        """Convert datetime to YYYYMMDD integer"""
        if dt is None:
            dt = datetime.utcnow()
        return int(dt.strftime('%Y%m%d'))

    async def get_block_number(self) -> int:
        """Get current block number"""
        if not self.w3:
            raise BlockchainServiceError("NOT_INITIALIZED", "Not connected")
        return self.w3.eth.block_number

    async def get_balance(self, address: str) -> float:
        """Get ETH balance for address"""
        if not self.w3:
            raise BlockchainServiceError("NOT_INITIALIZED", "Not connected")
        balance_wei = self.w3.eth.get_balance(Web3.to_checksum_address(address))
        return Web3.from_wei(balance_wei, 'ether')


# Singleton instance
blockchain_service = BlockchainService()
