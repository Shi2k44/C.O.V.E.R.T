/**
 * C.O.V.E.R.T - IPFS Storage Service
 *
 * Handles encrypted blob storage on IPFS with NFT.Storage/web3.storage
 */

import {
  EncryptedReportBlob,
  IPFSUploadResult,
  IPFSUploadProgress,
  IPFSPinStatus,
  IIPFSService,
  IPFS_CONFIG,
  IPFSError,
} from '../types/encryption';

// ── Dev-mode local blob store (IndexedDB) ──────────────────────────────────────
// When VITE_DEV_MODE=true and no real IPFS service is configured, encrypted blobs
// are stored in IndexedDB keyed by their fake "bafyDEV…" CID so the EvidenceViewer
// can retrieve them without a real IPFS gateway.
class DevIPFSStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('covert-dev-ipfs', 1);
        request.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('blobs')) {
            db.createObjectStore('blobs');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async put(cid: string, blob: EncryptedReportBlob): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, cid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async get(cid: string): Promise<EncryptedReportBlob | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readonly');
      const req = tx.objectStore('blobs').get(cid);
      req.onsuccess = () => resolve((req.result as EncryptedReportBlob) ?? null);
      req.onerror = () => reject(req.error);
    });
  }
}

const devStore = new DevIPFSStore();

/**
 * IPFS service implementation
 */
class IPFSService implements IIPFSService {
  private nftStorageToken: string = '';
  private web3StorageToken: string = '';
  private pinataApiKey: string = '';
  private pinataSecretKey: string = '';
  private pinataJwt: string = '';
  private localGateway: string = IPFS_CONFIG.GATEWAY_URL;

  /**
   * Configure the IPFS service
   */
  configure(config: {
    nftStorageToken?: string;
    web3StorageToken?: string;
    pinataApiKey?: string;
    pinataSecretKey?: string;
    pinataJwt?: string;
    localGateway?: string;
  }): void {
    if (config.nftStorageToken) {
      this.nftStorageToken = config.nftStorageToken;
    }
    if (config.web3StorageToken) {
      this.web3StorageToken = config.web3StorageToken;
    }
    if (config.pinataApiKey) {
      this.pinataApiKey = config.pinataApiKey;
    }
    if (config.pinataSecretKey) {
      this.pinataSecretKey = config.pinataSecretKey;
    }
    if (config.pinataJwt) {
      this.pinataJwt = config.pinataJwt;
    }
    if (config.localGateway) {
      this.localGateway = config.localGateway;
    }
  }

  /**
   * Upload encrypted blob to IPFS
   */
  async upload(
    data: EncryptedReportBlob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    // Serialize the data
    const jsonData = JSON.stringify(data);
    const blob = new Blob([jsonData], { type: 'application/json' });

    // Check file size
    if (blob.size > IPFS_CONFIG.MAX_FILE_SIZE) {
      throw this.createError(
        'UPLOAD_FAILED',
        `File size ${blob.size} exceeds maximum ${IPFS_CONFIG.MAX_FILE_SIZE}`
      );
    }

    // ── Dev-mode fast path ────────────────────────────────────────────────────
    // When VITE_DEV_MODE=true and no real IPFS tokens are configured, skip all
    // network attempts and return a deterministic fake CID immediately.
    // This avoids waiting for connection timeouts against localhost:5001.
    const isDevMode = import.meta.env.VITE_DEV_MODE === 'true';
    const hasRealService = !!(this.pinataJwt || this.pinataApiKey || this.nftStorageToken || this.web3StorageToken);
    if (isDevMode && !hasRealService) {
      console.warn(
        '[DEV MODE] No IPFS tokens configured — using simulated CID. ' +
        'Set VITE_NFT_STORAGE_TOKEN or VITE_WEB3_STORAGE_TOKEN to use real IPFS.'
      );
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(jsonData)
      );
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      // "bafy" prefix mimics a real CIDv1 so backend prefix-validation passes
      const fakeCid = `bafyDEV${hashHex.substring(0, 50)}`;
      // Persist the encrypted blob locally so EvidenceViewer can retrieve it
      await devStore.put(fakeCid, data);
      if (onProgress) {
        onProgress({ loaded: blob.size, total: blob.size, percentage: 100 });
      }
      return {
        cid: fakeCid,
        gatewayUrl: `https://ipfs.io/ipfs/${fakeCid}`,
        size: blob.size,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Try Pinata JWT → Pinata key/secret → NFT.Storage → web3.storage → local
    let lastError: Error | undefined;
    const tried: string[] = [];

    if (this.pinataJwt) {
      tried.push('Pinata-JWT');
      try {
        return await this.uploadToPinataJwt(blob, onProgress);
      } catch (error) {
        console.warn('Pinata JWT upload failed, trying fallback:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (this.pinataApiKey && this.pinataSecretKey) {
      tried.push('Pinata-Key');
      try {
        return await this.uploadToPinata(blob, onProgress);
      } catch (error) {
        console.warn('Pinata upload failed, trying fallback:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (this.nftStorageToken) {
      tried.push('NFT.Storage');
      try {
        return await this.uploadToNFTStorage(blob, onProgress);
      } catch (error) {
        console.warn('NFT.Storage upload failed, trying fallback:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (this.web3StorageToken) {
      tried.push('web3.storage');
      try {
        return await this.uploadToWeb3Storage(blob, onProgress);
      } catch (error) {
        console.warn('web3.storage upload failed, trying fallback:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (tried.length === 0) {
      tried.push('local-IPFS');
      try {
        return await this.uploadToLocalIPFS(blob, onProgress);
      } catch (error) {
        console.warn('Local IPFS upload failed:', error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `IPFS upload failed. Tried: [${tried.join(', ')}]. ` +
      (tried.length === 0
        ? 'No IPFS tokens configured. Set VITE_PINATA_JWT in Vercel env vars.'
        : `Last error: ${lastError?.message ?? 'unknown'}`)
    );
  }

  /**
   * Upload to NFT.Storage
   */
  private async uploadToNFTStorage(
    blob: Blob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    const totalSize = blob.size;

    // Simulate progress for fetch (no real progress API)
    if (onProgress) {
      onProgress({ loaded: 0, total: totalSize, percentage: 0 });
    }

    const response = await this.fetchWithRetry(
      'https://api.nft.storage/upload',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.nftStorageToken}`,
        },
        body: blob,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`NFT.Storage error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress({ loaded: totalSize, total: totalSize, percentage: 100 });
    }

    return {
      cid: result.value.cid,
      gatewayUrl: `https://nftstorage.link/ipfs/${result.value.cid}`,
      size: totalSize,
    };
  }

  /**
   * Upload to Pinata
   */
  private async uploadToPinata(
    blob: Blob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    const totalSize = blob.size;

    if (onProgress) {
      onProgress({ loaded: 0, total: totalSize, percentage: 0 });
    }

    const formData = new FormData();
    formData.append('file', blob, `report_${Date.now()}.json`);
    formData.append('pinataMetadata', JSON.stringify({ name: `covert-report-${Date.now()}` }));

    const response = await this.fetchWithRetry(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
      {
        method: 'POST',
        headers: {
          pinata_api_key: this.pinataApiKey,
          pinata_secret_api_key: this.pinataSecretKey,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress({ loaded: totalSize, total: totalSize, percentage: 100 });
    }

    return {
      cid: result.IpfsHash,
      gatewayUrl: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
      size: totalSize,
    };
  }

  /**
   * Upload to Pinata using JWT (modern auth — single token)
   */
  private async uploadToPinataJwt(
    blob: Blob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    const totalSize = blob.size;

    if (onProgress) {
      onProgress({ loaded: 0, total: totalSize, percentage: 0 });
    }

    const formData = new FormData();
    formData.append('file', blob, `report_${Date.now()}.json`);
    formData.append('pinataMetadata', JSON.stringify({ name: `covert-report-${Date.now()}` }));

    const response = await this.fetchWithRetry(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.pinataJwt}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata JWT error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress({ loaded: totalSize, total: totalSize, percentage: 100 });
    }

    return {
      cid: result.IpfsHash,
      gatewayUrl: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
      size: totalSize,
    };
  }

  /**
   * Upload to web3.storage
   */
  private async uploadToWeb3Storage(
    blob: Blob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    const totalSize = blob.size;

    if (onProgress) {
      onProgress({ loaded: 0, total: totalSize, percentage: 0 });
    }

    const response = await this.fetchWithRetry(
      'https://api.web3.storage/upload',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.web3StorageToken}`,
          'X-Name': `report_${Date.now()}`,
        },
        body: blob,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`web3.storage error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress({ loaded: totalSize, total: totalSize, percentage: 100 });
    }

    return {
      cid: result.cid,
      gatewayUrl: `https://w3s.link/ipfs/${result.cid}`,
      size: totalSize,
    };
  }

  /**
   * Upload to local IPFS node
   */
  private async uploadToLocalIPFS(
    blob: Blob,
    onProgress?: (progress: IPFSUploadProgress) => void
  ): Promise<IPFSUploadResult> {
    const totalSize = blob.size;

    if (onProgress) {
      onProgress({ loaded: 0, total: totalSize, percentage: 0 });
    }

    const formData = new FormData();
    formData.append('file', blob);

    const ipfsApiUrl = import.meta.env.VITE_IPFS_API || 'http://localhost:5001';
    const response = await this.fetchWithRetry(
      `${ipfsApiUrl}/api/v0/add`,
      {
        method: 'POST',
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local IPFS error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress({ loaded: totalSize, total: totalSize, percentage: 100 });
    }

    return {
      cid: result.Hash,
      gatewayUrl: `${this.localGateway}/${result.Hash}`,
      size: totalSize,
    };
  }

  /**
   * Retrieve encrypted blob from IPFS
   */
  async retrieve(cid: string): Promise<EncryptedReportBlob> {
    // Dev-mode: CIDs starting with "bafyDEV" were stored locally in IndexedDB
    if (cid.startsWith('bafyDEV')) {
      const stored = await devStore.get(cid);
      if (stored) return stored;
      throw new Error(
        `Dev-mode CID ${cid.slice(0, 24)}… not found in local store. ` +
        `This can happen if you cleared site data or submitted the report in a different browser. ` +
        `Re-submit the report to generate a new evidence bundle.`
      );
    }

    // Try multiple gateways
    const gateways = [
      `https://nftstorage.link/ipfs/${cid}`,
      `https://w3s.link/ipfs/${cid}`,
      `https://ipfs.io/ipfs/${cid}`,
      `https://cloudflare-ipfs.com/ipfs/${cid}`,
      `${this.localGateway}/${cid}`,
    ];

    let lastError: Error | undefined;

    for (const gatewayUrl of gateways) {
      try {
        const response = await this.fetchWithRetry(gatewayUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Gateway returned ${response.status}`);
        }

        const data: EncryptedReportBlob = await response.json();
        return data;
      } catch (error) {
        console.warn(`Failed to retrieve from ${gatewayUrl}:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    throw this.createError(
      'RETRIEVAL_FAILED',
      `Failed to retrieve CID ${cid} from all gateways`,
      lastError
    );
  }

  /**
   * Pin CID to ensure persistence
   */
  async pin(cid: string): Promise<IPFSPinStatus> {
    // Try NFT.Storage
    if (this.nftStorageToken) {
      try {
        const response = await this.fetchWithRetry(
          `https://api.nft.storage/pins/${cid}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.nftStorageToken}`,
            },
          }
        );

        if (response.ok) {
          return {
            cid,
            isPinned: true,
            provider: 'pinata',
            pinnedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        console.warn('NFT.Storage pin failed:', error);
      }
    }

    // Try local IPFS
    try {
      const ipfsApiUrl = import.meta.env.VITE_IPFS_API || 'http://localhost:5001';
      const response = await this.fetchWithRetry(
        `${ipfsApiUrl}/api/v0/pin/add?arg=${cid}`,
        {
          method: 'POST',
        }
      );

      if (response.ok) {
        return {
          cid,
          isPinned: true,
          provider: 'local',
          pinnedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      console.warn('Local IPFS pin failed:', error);
    }

    throw this.createError('PIN_FAILED', `Failed to pin CID ${cid}`);
  }

  /**
   * Unpin CID
   */
  async unpin(cid: string): Promise<void> {
    // Try local IPFS
    try {
      const ipfsApiUrl = import.meta.env.VITE_IPFS_API || 'http://localhost:5001';
      const response = await fetch(
        `${ipfsApiUrl}/api/v0/pin/rm?arg=${cid}`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        throw new Error(`Unpin failed: ${response.status}`);
      }
    } catch (error) {
      console.warn('Failed to unpin from local IPFS:', error);
    }
  }

  /**
   * Get gateway URL for a CID
   */
  getGatewayUrl(cid: string): string {
    return `${this.localGateway}/${cid}`;
  }

  /**
   * Check if CID is available
   */
  async isAvailable(cid: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://nftstorage.link/ipfs/${cid}`,
        {
          method: 'HEAD',
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get CID metadata
   */
  async getCIDInfo(cid: string): Promise<{
    size: number;
    type: string;
    created?: string;
  }> {
    const response = await this.fetchWithRetry(
      `https://nftstorage.link/ipfs/${cid}`,
      {
        method: 'HEAD',
      }
    );

    if (!response.ok) {
      throw this.createError('GATEWAY_ERROR', `Failed to get info for ${cid}`);
    }

    return {
      size: parseInt(response.headers.get('content-length') || '0', 10),
      type: response.headers.get('content-type') || 'unknown',
      created: response.headers.get('x-ipfs-roots') || undefined,
    };
  }

  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries: number = IPFS_CONFIG.MAX_RETRIES
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          IPFS_CONFIG.UPLOAD_TIMEOUT
        );

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < retries) {
          // Exponential backoff
          const delay = IPFS_CONFIG.RETRY_DELAY * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create a typed IPFS error
   */
  private createError(
    code: IPFSError['code'],
    message: string,
    cause?: Error
  ): IPFSError {
    return {
      code,
      message,
      cause,
    };
  }
}

// Export singleton instance (auto-configured from env vars)
export const ipfsService = new IPFSService();

// Auto-configure from Vite env variables at import time
console.log('[IPFS] VITE_PINATA_JWT:', import.meta.env.VITE_PINATA_JWT ? 'SET' : 'EMPTY');
console.log('[IPFS] VITE_PINATA_API_KEY:', import.meta.env.VITE_PINATA_API_KEY ? 'SET' : 'EMPTY');
console.log('[IPFS] VITE_DEV_MODE:', import.meta.env.VITE_DEV_MODE);
ipfsService.configure({
  pinataJwt: import.meta.env.VITE_PINATA_JWT || '',
  pinataApiKey: import.meta.env.VITE_PINATA_API_KEY || '',
  pinataSecretKey: import.meta.env.VITE_PINATA_SECRET_KEY || '',
  nftStorageToken: import.meta.env.VITE_NFT_STORAGE_TOKEN || '',
  web3StorageToken: import.meta.env.VITE_WEB3_STORAGE_TOKEN || '',
  localGateway: import.meta.env.VITE_IPFS_GATEWAY || undefined,
});

// Export class for testing
export { IPFSService };

export default ipfsService;
