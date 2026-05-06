/**
 * C.O.V.E.R.T - Evidence Viewer
 *
 * Fetches the AES key from the backend, retrieves the encrypted IPFS blob,
 * decrypts it in-browser, and renders attached files for reviewers/moderators.
 *
 * Visibility rules:
 *   public    → key is available; anyone can decrypt
 *   moderated → key is available; reviewers/moderators can decrypt
 *   private   → no key stored; reporter controls access
 */

import { useState } from 'react';
import {
    DocumentArrowDownIcon,
    PhotoIcon,
    DocumentIcon,
    EyeIcon,
    LockClosedIcon,
    ExclamationTriangleIcon,
    ArrowPathIcon,
    ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import { encryptionService } from '@/services/encryption';
import { web3Service } from '@/services/web3';
import { ipfsService } from '@/services/ipfs';
import type { EncryptedReportBlob, DecryptedReportData } from '@/types/encryption';
import { API_BASE } from '@/config';

interface Attachment {
    filename: string;
    mimeType: string;
    size: number;
    content: string; // base64
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCard({ attachment }: { attachment: Attachment }) {
    const isImage = attachment.mimeType.startsWith('image/');
    const isPDF = attachment.mimeType === 'application/pdf';
    const dataUrl = `data:${attachment.mimeType};base64,${attachment.content}`;

    const handleDownload = () => {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = attachment.filename;
        link.click();
    };

    return (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 overflow-hidden">
            {/* Image preview */}
            {isImage && (
                <div className="bg-neutral-950 border-b border-neutral-800 flex items-center justify-center max-h-64 overflow-hidden">
                    <img
                        src={dataUrl}
                        alt={attachment.filename}
                        className="max-h-64 max-w-full object-contain"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                </div>
            )}

            {/* File info row */}
            <div className="p-3 flex items-center gap-3">
                <div className="p-2 bg-neutral-800 rounded-lg shrink-0">
                    {isImage
                        ? <PhotoIcon className="h-5 w-5 text-neutral-300" />
                        : <DocumentIcon className="h-5 w-5 text-neutral-400" />
                    }
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{attachment.filename}</p>
                    <p className="text-xs text-neutral-500">{attachment.mimeType} · {formatSize(attachment.size)}</p>
                </div>
                <button
                    onClick={handleDownload}
                    title="Download file"
                    className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0"
                >
                    <DocumentArrowDownIcon className="h-5 w-5" />
                </button>
            </div>

            {/* PDF open link — use blob URL; browsers block data: URL navigation */}
            {isPDF && (
                <div className="px-3 pb-3">
                    <button
                        onClick={() => {
                            const bytes = Uint8Array.from(atob(attachment.content), c => c.charCodeAt(0));
                            const blob = new Blob([bytes], { type: attachment.mimeType });
                            const url = URL.createObjectURL(blob);
                            window.open(url, '_blank', 'noopener,noreferrer');
                            setTimeout(() => URL.revokeObjectURL(url), 10000);
                        }}
                        className="text-xs text-neutral-400 hover:text-white underline"
                    >
                        Open PDF in new tab
                    </button>
                </div>
            )}
        </div>
    );
}

interface EvidenceViewerProps {
    /** keccak256(CID) — used to fetch the evidence key from the backend */
    contentHash: string;
    /** IPFS CID of the encrypted blob */
    cid: string;
    /** Backend visibility: 'public' | 'moderated' | 'private' */
    visibility: string;
}

export function EvidenceViewer({ contentHash, cid, visibility }: EvidenceViewerProps) {
    const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error' | 'needs-auth' | 'needs-sync'>('idle');
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [errorMsg, setErrorMsg] = useState('');
    const [syncing, setSyncing] = useState(false);

    const isPrivate = visibility === 'private';

    /** Check if the reporter's local key exists for this CID */
    const hasLocalKey = (): boolean => !!localStorage.getItem(`covert_key_${cid}`);

    const loadEvidence = async () => {
        setState('loading');
        setErrorMsg('');

        try {
            // 1. Fetch AES key from backend
            const _evToken = localStorage.getItem('token');
            const keyRes = await fetch(`${API_BASE}/api/v1/reports/by-hash/${contentHash}/evidence-key`, {
                headers: _evToken ? { 'Authorization': `Bearer ${_evToken}` } : {},
            });
            if (!keyRes.ok) {
                if (keyRes.status === 401 || keyRes.status === 403 || keyRes.status === 422) {
                    setState('needs-auth');
                    return;
                }
                if (keyRes.status === 404 && hasLocalKey()) {
                    // Reporter hasn't synced their key yet — offer to do it
                    setState('needs-sync');
                    return;
                }
                const err = await keyRes.json().catch(() => ({ detail: 'No evidence key available' }));
                throw new Error(err.detail ?? 'Failed to fetch evidence key');
            }
            const { key_hex } = await keyRes.json();
            const keyBytes = hexToBytes(key_hex);

            // 2. Fetch encrypted blob from IPFS
            let blob: EncryptedReportBlob;
            try {
                blob = await ipfsService.retrieve(cid);
            } catch {
                throw new Error(`Could not fetch evidence from IPFS (CID: ${cid.slice(0, 20)}…). The file may not be pinned on a reachable gateway.`);
            }

            // 3. Decrypt in-browser
            let decrypted: DecryptedReportData;
            try {
                decrypted = await encryptionService.decryptReport(blob, keyBytes);
            } catch {
                throw new Error('Decryption failed — the stored key may not match this report.');
            }

            setAttachments(decrypted.attachments ?? []);
            setState('done');
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
            setState('error');
        }
    };

    /** Upload the locally-stored AES key to the backend so reviewers can access it */
    const syncKeyToBackend = async () => {
        setSyncing(true);
        try {
            const signature = await web3Service.signMessage(`COVERT Key Storage: ${cid}`);
            const keyBytes = await encryptionService.retrieveKey(cid, signature);
            if (!keyBytes) throw new Error('Key not found in local storage');

            const keyHex = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const token = localStorage.getItem('token');
            const walletAddress = localStorage.getItem('wallet_address');
            const res = await fetch(`${API_BASE}/api/v1/reports/by-hash/${contentHash}/evidence-key`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    ...(walletAddress ? { 'X-Wallet-Address': walletAddress } : {}),
                },
                body: JSON.stringify({ key_hex: keyHex }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail ?? `Server returned ${res.status}`);
            }
            // Key synced — now load evidence
            setState('idle');
            loadEvidence();
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Sync failed');
            setState('error');
        } finally {
            setSyncing(false);
        }
    };

    // Private reports: no key stored
    if (isPrivate) {
        return (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 flex items-center gap-3">
                <LockClosedIcon className="h-5 w-5 text-neutral-500 shrink-0" />
                <div>
                    <p className="text-sm font-medium text-neutral-300">Private Report</p>
                    <p className="text-xs text-neutral-500 mt-0.5">
                        Evidence files are controlled by the reporter. Contact them for access.
                    </p>
                </div>
            </div>
        );
    }

    if (state === 'idle') {
        return (
            <button
                onClick={loadEvidence}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
            >
                <EyeIcon className="h-4 w-4" />
                View Evidence Files
            </button>
        );
    }

    if (state === 'loading') {
        return (
            <div className="flex items-center gap-2 text-sm text-neutral-400">
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
                Fetching and decrypting evidence…
            </div>
        );
    }

    if (state === 'needs-auth') {
        return (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 flex items-center gap-3">
                <LockClosedIcon className="h-5 w-5 text-neutral-500 shrink-0" />
                <p className="text-sm text-neutral-400">Sign in to view the evidence.</p>
            </div>
        );
    }

    if (state === 'needs-sync') {
        return (
            <div className="rounded-xl border border-amber-900/40 bg-neutral-950 p-4 space-y-2">
                <div className="flex items-center gap-2">
                    <ExclamationTriangleIcon className="h-4 w-4 text-amber-500 shrink-0" />
                    <p className="text-sm font-medium text-amber-400">Evidence key not synced</p>
                </div>
                <p className="text-xs text-neutral-500">
                    Your encryption key hasn't been uploaded to the backend yet. Sync it so reviewers can access the evidence.
                </p>
                <button
                    onClick={syncKeyToBackend}
                    disabled={syncing}
                    className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-white underline disabled:opacity-50"
                >
                    {syncing
                        ? <><ArrowPathIcon className="h-3.5 w-3.5 animate-spin" /> Syncing…</>
                        : <><ArrowUpTrayIcon className="h-3.5 w-3.5" /> Sync key to backend</>
                    }
                </button>
            </div>
        );
    }

    if (state === 'error') {
        return (
            <div className="rounded-xl border border-red-900/40 bg-neutral-950 p-4 space-y-2">
                <div className="flex items-center gap-2">
                    <ExclamationTriangleIcon className="h-4 w-4 text-red-500 shrink-0" />
                    <p className="text-sm font-medium text-red-400">Evidence unavailable</p>
                </div>
                <p className="text-xs text-neutral-500">{errorMsg}</p>
                <button
                    onClick={loadEvidence}
                    className="text-xs text-neutral-400 hover:text-white underline"
                >
                    Retry
                </button>
            </div>
        );
    }

    // state === 'done'
    return (
        <div className="space-y-3">
            <p className="text-xs text-neutral-500 uppercase tracking-wider">
                Evidence Files ({attachments.length})
            </p>

            {attachments.length === 0 ? (
                <p className="text-sm text-neutral-500">No files were attached to this report.</p>
            ) : (
                <div className="space-y-2">
                    {attachments.map((att, i) => (
                        <AttachmentCard key={i} attachment={att} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default EvidenceViewer;
