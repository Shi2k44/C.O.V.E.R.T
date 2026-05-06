/**
 * C.O.V.E.R.T - Report Submission Form Component
 * Multi-step form with encryption, IPFS upload, and blockchain commitment
 */

import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckIcon,
  LockClosedIcon,
  CloudArrowUpIcon,
  CubeIcon,
  DocumentCheckIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'react-hot-toast';
import { useReportStore, type ReportCategory, type ReportVisibility } from '@/stores/reportStore';
import { FileUpload } from './FileUpload';
import { encryptionService } from '@/services/encryption';
import { ipfsService } from '@/services/ipfs';
import { web3Service } from '@/services/web3';
import { useWeb3 } from '@/hooks/useWeb3';
import { useCovBalanceStore, STAKE_AMOUNTS, type VisibilityKey } from '@/stores/covBalanceStore';
import { ethers } from 'ethers';
import { API_BASE } from '@/config';

interface FormErrors {
  category?: string;
  title?: string;
  description?: string;
  visibility?: string;
}

const CATEGORIES: { value: ReportCategory; label: string; description: string }[] = [
  { value: 'corruption', label: 'Corruption', description: 'Bribery, embezzlement, abuse of power' },
  { value: 'fraud', label: 'Fraud', description: 'Financial fraud, scams, deceptive practices' },
  { value: 'safety', label: 'Safety Violation', description: 'Workplace safety, product safety issues' },
  { value: 'environment', label: 'Environmental', description: 'Pollution, illegal dumping, environmental damage' },
  { value: 'human_rights', label: 'Human Rights', description: 'Discrimination, harassment, rights violations' },
  { value: 'other', label: 'Other', description: 'Other whistleblowing matters' },
];

/**
 * Bangalore government departments.
 * These correspond to the Department rows seeded in migration 011.
 * The `value` must match Department.name in the backend DB (case-insensitive).
 */
const BANGALORE_DEPARTMENTS: { value: string; label: string; description: string }[] = [
  { value: 'Lokayukta Karnataka', label: 'Lokayukta Karnataka', description: 'Bribery, corruption & misconduct by government officials' },
  { value: 'Cyber Crime Police', label: 'Cyber Crime Police (CID)', description: 'Online fraud, cybercrime, identity theft, hacking' },
  { value: 'BBMP Roads', label: 'BBMP — Roads & Infrastructure', description: 'Potholes, broken roads, footpaths, dividers' },
  { value: 'BWSSB', label: 'BWSSB — Water & Sewage', description: 'Water supply issues, pipe bursts, sewage overflow' },
  { value: 'BESCOM', label: 'BESCOM — Electricity', description: 'Power cuts, streetlight failures, sparking wires' },
  { value: 'KSPCB', label: 'KSPCB — Pollution Control', description: 'Air, water, noise or industrial pollution' },
  { value: 'FSSAI Karnataka', label: 'FSSAI — Food Safety', description: 'Adulterated food, unhygienic restaurants, expired products' },
  { value: 'BBMP Building Regulation', label: 'BBMP — Building Regulation', description: 'Illegal constructions, building code violations' },
  { value: 'BBMP Public Health', label: 'BBMP — Public Health', description: 'Disease outbreaks, mosquito breeding, sanitation' },
  { value: 'Bangalore Traffic Police', label: 'Bangalore Traffic Police', description: 'Traffic signal issues, illegal parking, accidents' },
  { value: 'Bangalore City Police', label: 'Bangalore City Police', description: 'Harassment, theft, law & order issues' },
  { value: 'BBMP Solid Waste', label: 'BBMP — Solid Waste Management', description: 'Garbage collection, illegal dumping, open burning' },
];

const VISIBILITY_OPTIONS: { value: ReportVisibility; label: string; description: string; icon: React.ElementType; stake: number }[] = [
  {
    value: 'private',
    label: 'Private',
    description: 'Only you can access this report. Use for personal records.',
    icon: EyeSlashIcon,
    stake: STAKE_AMOUNTS.private,
  },
  {
    value: 'moderated',
    label: 'Moderated',
    description: 'Moderators review before public access. Recommended for most reports.',
    icon: ShieldCheckIcon,
    stake: STAKE_AMOUNTS.moderated,
  },
  {
    value: 'public',
    label: 'Public',
    description: 'Immediately visible to everyone after blockchain confirmation.',
    icon: EyeIcon,
    stake: STAKE_AMOUNTS.public,
  },
];

const STEPS = [
  { id: 1, name: 'Details', description: 'Category and description' },
  { id: 2, name: 'Attachments', description: 'Supporting files' },
  { id: 3, name: 'Visibility', description: 'Privacy settings' },
  { id: 4, name: 'Review', description: 'Confirm and submit' },
];

export function ReportSubmissionForm() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [errors, setErrors] = useState<FormErrors>({});

  const {
    draft,
    updateDraft,
    resetDraft,
    submissionProgress,
    setSubmissionProgress,
    resetSubmission,
    addReport,
  } = useReportStore();

  const { commitReport, connect, walletState } = useWeb3();
  const isConnected = walletState.connected;
  const { deductStake } = useCovBalanceStore();
  const [walletTxCount, setWalletTxCount] = useState<number | null>(null);
  const [routingPreview, setRoutingPreview] = useState<{
    is_bangalore: boolean;
    category: string;
    departments: { name: string; short_name: string }[];
  } | null>(null);
  const [routingLoading, setRoutingLoading] = useState(false);

  useEffect(() => {
    resetSubmission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced routing preview based on description text
  useEffect(() => {
    const text = `${draft.title} ${draft.description}`.trim();
    if (text.length < 20) {
      setRoutingPreview(null);
      return;
    }
    setRoutingLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/routing/preview?text=${encodeURIComponent(text)}`
        );
        if (res.ok) {
          setRoutingPreview(await res.json());
        }
      } catch {
        // ignore
      } finally {
        setRoutingLoading(false);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [draft.title, draft.description]);

  // Check wallet tx count for anonymity warning
  useEffect(() => {
    if (!isConnected || !walletState.address) {
      setWalletTxCount(null);
      return;
    }
    (async () => {
      try {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const count = await provider.getTransactionCount(walletState.address!);
        setWalletTxCount(count);
      } catch {
        setWalletTxCount(null);
      }
    })();
  }, [isConnected, walletState.address]);

  const validateStep = useCallback((step: number): boolean => {
    const newErrors: FormErrors = {};

    switch (step) {
      case 1:
        if (!draft.category) {
          newErrors.category = 'Please select a category';
        }
        if (!draft.title || draft.title.length < 10) {
          newErrors.title = 'Title must be at least 10 characters';
        }
        if (!draft.description || draft.description.length < 50) {
          newErrors.description = 'Description must be at least 50 characters';
        }
        break;
      case 3:
        if (!draft.visibility) {
          newErrors.visibility = 'Please select a visibility option';
        }
        break;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [draft]);

  const handleNext = useCallback(() => {
    if (validateStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, 4));
    }
  }, [currentStep, validateStep]);

  const handleBack = useCallback(() => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isConnected) {
      toast.error('Please connect your wallet first');
      await connect();
      return;
    }

    try {
      // Step 1: Encrypt data
      setSubmissionProgress({
        step: 'encrypting',
        progress: 10,
        message: 'Encrypting your report...',
      });

      const reportData = {
        category: draft.category as import('@/types/encryption').ReportCategory,
        title: draft.title,
        description: draft.description,
        visibility: draft.visibility,
        files: draft.files,
      };

      const { blob: encryptedReport, key: encryptionKey } = await encryptionService.encryptReport(reportData);

      // Step 2: Upload to IPFS
      setSubmissionProgress({
        step: 'uploading',
        progress: 40,
        message: 'Uploading to IPFS...',
      });

      const ipfsResult = await ipfsService.upload(encryptedReport);

      if (!ipfsResult.cid) {
        throw new Error('IPFS upload failed: No CID returned');
      }

      // Step 3: Submit to backend FIRST (without tx_hash)
      // This ensures COV tokens are NEVER locked unless the backend already accepted the report.
      setSubmissionProgress({
        step: 'submitting',
        progress: 60,
        message: 'Registering report...',
      });

      const cidHash = ethers.keccak256(ethers.toUtf8Bytes(ipfsResult.cid));
      const visibilityInt = draft.visibility === 'private' ? 0 : draft.visibility === 'moderated' ? 1 : 2;

      const response = await fetch(`${API_BASE}/api/v1/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          ...(walletState.address ? { 'X-Wallet-Address': walletState.address } : {}),
        },
        body: JSON.stringify({
          cid: ipfsResult.cid,
          cid_hash: cidHash,
          category: draft.category,
          visibility: visibilityInt,
          size_bytes: ipfsResult.size,
          title: draft.title,
          description: draft.description,
          ...(draft.delayHours > 0 ? { delay_hours: draft.delayHours } : {}),
          ...(draft.department ? { department: draft.department } : {}),
        }),
      });

      if (!response.ok) {
        let detail = `Backend returned ${response.status}`;
        try {
          const errBody = await response.json();
          detail = errBody?.detail ?? errBody?.message ?? detail;
        } catch {
          detail = response.statusText || detail;
        }
        throw new Error(`Failed to submit report: ${detail}`);
      }

      const result = await response.json();

      // Step 4: Commit to blockchain (locks COV) — only AFTER backend accepted
      setSubmissionProgress({
        step: 'committing',
        progress: 75,
        message: 'Committing to blockchain...',
      });

      let txResult;
      try {
        txResult = await commitReport(ipfsResult.cid, visibilityInt);
      } catch (blockchainErr) {
        // Backend already saved the report — no COV was locked.
        console.warn('[Submit] Blockchain commit failed after backend save:', blockchainErr);
        // Still count as partial success — report is saved
        addReport({
          id: result.id,
          commitmentHash: cidHash,
          ipfsCid: ipfsResult.cid,
          transactionHash: '',
          category: draft.category as ReportCategory,
          title: draft.title,
          status: 'pending',
          visibility: draft.visibility,
          fileSize: ipfsResult.size,
          submittedAt: new Date().toISOString(),
        });
        throw new Error(
          'Report saved but blockchain commit failed. No COV was locked. ' +
          'You can retry the blockchain commit from My Reports.'
        );
      }

      // Step 5: Update backend with the transaction hash
      if (txResult.success && txResult.transactionHash) {
        try {
          await fetch(`${API_BASE}/api/v1/reports/${result.id}/commit`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('token')}`,
              ...(walletState.address ? { 'X-Wallet-Address': walletState.address } : {}),
            },
            body: JSON.stringify({
              tx_hash: txResult.transactionHash,
              block_number: txResult.blockNumber || null,
            }),
          });
        } catch {
          // Non-critical — report and on-chain commit both succeeded
          console.warn('[Submit] Failed to update backend with tx_hash');
        }
      }

      // Store encryption key locally
      try {
        if (walletState.address) {
          const walletSignature = await web3Service.signMessage(
            `COVERT Key Storage: ${ipfsResult.cid}`
          );
          await encryptionService.storeKey(
            ipfsResult.cid,
            encryptionKey,
            walletState.address,
            walletSignature
          );
        }
      } catch (error) {
        console.warn('Failed to store encryption key:', error);
      }

      // Share the AES key with the backend for ALL visibilities so moderators
      // can always decrypt evidence. Access is gated by moderator role in the API.
      try {
        const keyHex = Array.from(encryptionKey)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const _ekToken = localStorage.getItem('token');
        await fetch(`${API_BASE}/api/v1/reports/by-hash/${cidHash}/evidence-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(_ekToken ? { 'Authorization': `Bearer ${_ekToken}` } : {}),
            ...(walletState.address ? { 'X-Wallet-Address': walletState.address } : {}),
          },
          body: JSON.stringify({ key_hex: keyHex }),
        });
      } catch {
        // Non-critical — evidence just won't be decryptable by moderators
      }

      addReport({
        id: result.id,
        commitmentHash: cidHash,
        ipfsCid: ipfsResult.cid,
        transactionHash: txResult?.transactionHash || '',
        category: draft.category as ReportCategory,
        title: draft.title,
        status: 'pending',
        visibility: draft.visibility,
        fileSize: ipfsResult.size,
        submittedAt: new Date().toISOString(),
      });

      // Deduct the stake from the COV balance display
      if (walletState.address && txResult?.success) {
        const staked = deductStake(walletState.address, draft.visibility as VisibilityKey);
        toast.success(`${staked} COV staked on your report`, { id: 'cov-stake', duration: 3000 });
      }

      setSubmissionProgress({
        step: 'complete',
        progress: 100,
        message: 'Report submitted successfully!',
      });

      toast.success('Report submitted successfully!');

      setTimeout(() => {
        resetDraft();
        resetSubmission();
        navigate('/my-reports');
      }, 2000);

    } catch (error) {
      console.error('Submission error:', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : (error as { message?: string })?.message ||
          (typeof error === 'string' ? error : 'Unknown error occurred');
      setSubmissionProgress({
        step: 'error',
        progress: 0,
        message: 'Submission failed',
        error: errorMessage,
      });
      toast.error(errorMessage);
    }
  }, [
    isConnected,
    walletState,
    connect,
    draft,
    setSubmissionProgress,
    commitReport,
    addReport,
    deductStake,
    resetDraft,
    resetSubmission,
    navigate,
  ]);

  const renderStepIndicator = () => (
    <nav aria-label="Progress" className="mb-10">
      <ol className="flex items-center">
        {STEPS.map((step, index) => (
          <li key={step.id} className={`flex-1 ${index !== STEPS.length - 1 ? 'pr-8' : ''}`}>
            <div className="flex items-center">
              <div
                className={`
                  flex items-center justify-center w-12 h-12 rounded-full border-2 font-semibold
                  transition-all duration-300
                  ${currentStep > step.id
                    ? 'border-transparent text-white'
                    : currentStep === step.id
                      ? 'border-orange-500 text-white bg-neutral-800'
                      : 'border-neutral-700 text-neutral-600 bg-neutral-900'
                  }
                `}
                style={currentStep > step.id ? { backgroundColor: '#E84B1A' } : {}}
              >
                {currentStep > step.id ? (
                  <CheckIcon className="h-6 w-6" />
                ) : (
                  <span className="text-lg">{step.id}</span>
                )}
              </div>
              {index !== STEPS.length - 1 && (
                <div
                  className="flex-1 h-1 ml-4 rounded-full transition-all duration-300 bg-neutral-800 overflow-hidden"
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: currentStep > step.id ? '100%' : '0%', backgroundColor: '#E84B1A' }}
                  />
                </div>
              )}
            </div>
            <div className="mt-3">
              <p className={`text-sm font-semibold transition-colors ${currentStep >= step.id ? 'text-white' : 'text-neutral-600'}`}>
                {step.name}
              </p>
              <p className="text-xs text-neutral-500 mt-0.5">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );

  const renderStep1 = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Report Details</h2>

      {/* Category Selection */}
      <div>
        <label className="block text-sm font-semibold text-neutral-300 mb-4">
          Category <span className="text-red-400">*</span>
        </label>
        <div className="grid grid-cols-2 gap-4">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              type="button"
              onClick={() => updateDraft({ category: cat.value })}
              className={`
                p-5 text-left border rounded-xl transition-all duration-200
                ${draft.category === cat.value
                  ? 'bg-neutral-800'
                  : 'border-neutral-700 hover:border-neutral-500 bg-neutral-900'
                }
              `}
              style={draft.category === cat.value ? { borderColor: '#E84B1A', outline: '1.5px solid rgba(232,75,26,0.4)' } : {}}
            >
              <p className="font-semibold text-white">{cat.label}</p>
              <p className="text-xs text-neutral-400 mt-1.5 leading-relaxed">{cat.description}</p>
            </button>
          ))}
        </div>
        {errors.category && (
          <p className="mt-3 text-sm text-red-400 font-medium">{errors.category}</p>
        )}
      </div>

      {/* Title */}
      <div>
        <label className="block text-sm font-semibold text-neutral-300 mb-2">
          Title <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={draft.title}
          onChange={(e) => updateDraft({ title: e.target.value })}
          placeholder="Brief summary of the issue"
          maxLength={200}
          className={`
            w-full px-5 py-3.5 border rounded-xl transition-all duration-200
            bg-neutral-900 text-white placeholder-neutral-600
            focus:ring-2 focus:ring-neutral-500 focus:border-neutral-500
            ${errors.title ? 'border-red-700 bg-red-950/20' : 'border-neutral-700 hover:border-neutral-500'}
          `}
        />
        <div className="flex justify-between mt-2">
          {errors.title ? (
            <p className="text-sm text-red-400 font-medium">{errors.title}</p>
          ) : (
            <p className="text-sm text-neutral-500">Minimum 10 characters</p>
          )}
          <p className="text-sm text-neutral-500 font-medium">{draft.title.length}/200</p>
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-semibold text-neutral-300 mb-2">
          Description <span className="text-red-400">*</span>
        </label>
        <textarea
          value={draft.description}
          onChange={(e) => updateDraft({ description: e.target.value })}
          placeholder="Provide detailed information about the issue..."
          rows={8}
          maxLength={5000}
          className={`
            w-full px-5 py-3.5 border rounded-xl resize-none transition-all duration-200
            bg-neutral-900 text-white placeholder-neutral-600
            focus:ring-2 focus:ring-neutral-500 focus:border-neutral-500
            ${errors.description ? 'border-red-700 bg-red-950/20' : 'border-neutral-700 hover:border-neutral-500'}
          `}
        />
        <div className="flex justify-between mt-2">
          {errors.description ? (
            <p className="text-sm text-red-400 font-medium">{errors.description}</p>
          ) : (
            <p className="text-sm text-neutral-500">Minimum 50 characters</p>
          )}
          <p className="text-sm text-neutral-500 font-medium">{draft.description.length}/5000</p>
        </div>
      </div>

      {/* Department Selection */}
      <div>
        <label className="block text-sm font-semibold text-neutral-300 mb-2">
          Concerned Department <span className="text-neutral-500 font-normal">(optional — Bangalore)</span>
        </label>
        <p className="text-xs text-neutral-500 mb-3">
          Select the government department your report is directed at. After a moderator approves your report, it will be forwarded to this department.
        </p>
        <select
          value={draft.department}
          onChange={(e) => updateDraft({ department: e.target.value })}
          className="w-full px-4 py-3 border border-neutral-700 rounded-xl bg-neutral-900 text-white focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:border-neutral-500"
        >
          <option value="">-- Select department (optional) --</option>
          {BANGALORE_DEPARTMENTS.map((dept) => (
            <option key={dept.value} value={dept.value}>{dept.label}</option>
          ))}
        </select>
        {draft.department && (
          <p className="mt-2 text-xs text-neutral-500">
            {BANGALORE_DEPARTMENTS.find(d => d.value === draft.department)?.description}
          </p>
        )}
      </div>

      {/* Routing Preview */}
      {!draft.department && (draft.title + draft.description).trim().length >= 20 && (
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-xl">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Department Routing Preview
            {routingLoading && (
              <span className="ml-2 inline-block w-3 h-3 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin align-middle" />
            )}
          </p>
          {routingPreview && !routingLoading && (
            <>
              {!routingPreview.is_bangalore ? (
                <p className="text-xs text-neutral-500">
                  Location not detected as Bangalore — no automatic routing.
                </p>
              ) : routingPreview.departments.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-neutral-400">This report will be routed to:</span>
                  {routingPreview.departments.map((d) => (
                    <span
                      key={d.short_name}
                      className="text-xs px-2.5 py-1 rounded-full bg-neutral-800 text-neutral-300 font-medium"
                    >
                      {d.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-neutral-500">
                  No matching department found for the detected category.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Attachments (Optional)</h2>
      <p className="text-neutral-400">
        Upload supporting documents, images, or videos. All files are encrypted before upload.
      </p>

      <FileUpload
        maxFiles={5}
        maxSize={100 * 1024 * 1024}
        showEncryptionStatus
      />

      <div className="p-5 bg-neutral-950 border border-neutral-800 rounded-xl">
        <div className="flex items-start">
          <InformationCircleIcon className="h-6 w-6 text-neutral-400 mt-0.5 mr-3 flex-shrink-0" />
          <div className="text-sm text-neutral-400">
            <p className="font-semibold text-white">Privacy Notice</p>
            <p className="mt-1.5 leading-relaxed">
              Files are encrypted on your device before upload. The encryption key is shared with the platform so moderators can view attached evidence when reviewing your report. Evidence is only visible to logged-in users on the public feed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Privacy Settings</h2>
      <p className="text-neutral-400 leading-relaxed">
        Choose who can access your report. You can change this later.
      </p>

      <div className="space-y-4">
        {VISIBILITY_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => updateDraft({ visibility: option.value })}
              className={`
                w-full p-5 text-left border rounded-xl transition-all duration-200 flex items-start
                ${draft.visibility === option.value
                  ? 'bg-neutral-800'
                  : 'border-neutral-700 hover:border-neutral-500 bg-neutral-900'
                }
              `}
              style={draft.visibility === option.value ? { borderColor: '#E84B1A', outline: '1.5px solid rgba(232,75,26,0.4)' } : {}}
            >
              <Icon className="h-7 w-7 mt-0.5 mr-4 transition-colors"
                style={{ color: draft.visibility === option.value ? '#E84B1A' : '#737373' }} />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-white text-lg">{option.label}</p>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: 'rgba(232,75,26,0.12)', color: '#E84B1A' }}>
                    {option.stake} COV stake
                  </span>
                </div>
                <p className="text-sm text-neutral-400 mt-1.5 leading-relaxed">{option.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Submission Delay */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-2">Schedule Submission Delay</h3>
        <p className="text-sm text-neutral-500 mb-4">
          Recommended for sensitive reports. Adds a time buffer between your activity and the on-chain record.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { value: 0, label: 'Immediately' },
            { value: 6, label: '6 hours' },
            { value: 24, label: '24 hours' },
            { value: 72, label: '72 hours' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateDraft({ delayHours: opt.value })}
              className={`px-4 py-3 rounded-xl border text-sm font-medium transition-all duration-200 ${
                draft.delayHours === opt.value
                  ? 'bg-neutral-800 text-white'
                  : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 bg-neutral-900'
              }`}
              style={draft.delayHours === opt.value ? { borderColor: '#E84B1A' } : {}}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {draft.delayHours > 0 && (
          <div className="mt-3 p-3 bg-neutral-900 border border-neutral-800 rounded-lg">
            <p className="text-xs text-neutral-400">
              Your report will be encrypted and stored immediately, but the blockchain commitment will be
              published ~{draft.delayHours} hours after submission.
            </p>
          </div>
        )}
      </div>

      <div className="p-5 bg-green-950/20 border border-green-900/50 rounded-xl">
        <div className="flex items-start">
          <ShieldCheckIcon className="h-6 w-6 text-green-500 mt-0.5 mr-3 flex-shrink-0" />
          <div className="text-sm text-green-400">
            <p className="font-semibold text-green-300">Your Identity is Protected</p>
            <p className="mt-1.5 leading-relaxed">
              Your identity is protected through zero-knowledge proofs. Even moderators cannot see who submitted this report.
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderStep4 = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Review & Submit</h2>

      {/* Summary Card */}
      <div className="bg-neutral-900 rounded-xl p-7 space-y-5 border border-neutral-800">
        <div>
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Category</p>
          <p className="font-semibold text-white mt-1.5 text-lg">
            {CATEGORIES.find((c) => c.value === draft.category)?.label || 'Not selected'}
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Title</p>
          <p className="font-semibold text-white mt-1.5">{draft.title || 'Not provided'}</p>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Description</p>
          <p className="text-neutral-300 text-sm whitespace-pre-wrap mt-1.5 leading-relaxed">
            {draft.description.length > 300
              ? `${draft.description.substring(0, 300)}...`
              : draft.description || 'Not provided'}
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Attachments</p>
          <p className="font-semibold text-white mt-1.5">
            {draft.files.length} file(s)
          </p>
        </div>

        <div className="border-t border-neutral-800 pt-4">
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Visibility</p>
          <div className="flex items-center justify-between mt-1.5">
            <p className="font-semibold text-white">
              {VISIBILITY_OPTIONS.find((v) => v.value === draft.visibility)?.label || 'Not selected'}
            </p>
            {draft.visibility && (
              <span className="text-sm font-semibold" style={{ color: '#E84B1A' }}>
                {STAKE_AMOUNTS[draft.visibility as VisibilityKey]} COV will be staked
              </span>
            )}
          </div>
        </div>

        {draft.delayHours > 0 && (
          <div className="border-t border-neutral-800 pt-4">
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Submission Delay</p>
            <p className="font-semibold text-white mt-1.5">
              {draft.delayHours} hours
            </p>
          </div>
        )}
      </div>

      {/* Wallet Status */}
      {!isConnected && (
        <div className="p-5 bg-amber-950/20 border border-amber-900/50 rounded-xl">
          <div className="flex items-start">
            <ExclamationTriangleIcon className="h-6 w-6 text-amber-500 mt-0.5 mr-3 flex-shrink-0" />
            <div className="text-sm text-amber-400 flex-1">
              <p className="font-semibold text-amber-300 text-base">Wallet Not Connected</p>
              <p className="mt-1.5 leading-relaxed">
                Please connect your wallet to submit the report to the blockchain.
              </p>
              <button
                onClick={() => connect()}
                className="mt-3 px-6 py-2.5 rounded-lg font-semibold transition-all duration-200 hover:opacity-90"
                style={{ backgroundColor: '#E84B1A', color: '#fff' }}
              >
                Connect Wallet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wallet anonymity warning */}
      {isConnected && walletTxCount !== null && walletTxCount > 5 && (
        <div className="p-5 bg-amber-950/20 border border-amber-900/50 rounded-xl">
          <div className="flex items-start">
            <ExclamationTriangleIcon className="h-6 w-6 text-amber-500 mt-0.5 mr-3 flex-shrink-0" />
            <div className="text-sm text-amber-400">
              <p className="font-semibold text-amber-300">Anonymity Warning</p>
              <p className="mt-1.5 leading-relaxed">
                This wallet has <span className="font-bold text-amber-200">{walletTxCount}</span> prior transactions.
                Using a wallet with transaction history may make it easier to link your identity.
                For maximum anonymity, consider using a fresh burner wallet.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Submission Progress */}
      {submissionProgress.step !== 'idle' && (
        <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg">
          <div className="flex items-center mb-3">
            {submissionProgress.step === 'encrypting' && <LockClosedIcon className="h-5 w-5 text-neutral-400 mr-2 animate-pulse" />}
            {submissionProgress.step === 'uploading' && <CloudArrowUpIcon className="h-5 w-5 text-neutral-400 mr-2 animate-pulse" />}
            {submissionProgress.step === 'committing' && <CubeIcon className="h-5 w-5 text-neutral-400 mr-2 animate-pulse" />}
            {submissionProgress.step === 'submitting' && <DocumentCheckIcon className="h-5 w-5 text-neutral-400 mr-2 animate-pulse" />}
            {submissionProgress.step === 'complete' && <CheckIcon className="h-5 w-5 text-green-500 mr-2" />}
            {submissionProgress.step === 'error' && <ExclamationTriangleIcon className="h-5 w-5 text-red-500 mr-2" />}
            <span className={`font-medium ${submissionProgress.step === 'error' ? 'text-red-400' : 'text-white'}`}>
              {submissionProgress.message}
            </span>
          </div>
          <div className="w-full bg-neutral-800 rounded-full h-2">
            <div
              className="h-2 rounded-full transition-all duration-300"
              style={{
                width: `${submissionProgress.progress}%`,
                backgroundColor: submissionProgress.step === 'error' ? '#ef4444' : '#E84B1A',
              }}
            />
          </div>
          {submissionProgress.error && (
            <p className="mt-2 text-sm text-red-400">{submissionProgress.error}</p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto animate-fade-in">
      {renderStepIndicator()}

      <div className="bg-neutral-950 rounded-2xl border border-neutral-800 p-8">
        <div className="animate-slide-up">
          {currentStep === 1 && renderStep1()}
          {currentStep === 2 && renderStep2()}
          {currentStep === 3 && renderStep3()}
          {currentStep === 4 && renderStep4()}
        </div>

        {/* Navigation Buttons */}
        <div className="flex justify-between mt-10 pt-6 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleBack}
            disabled={currentStep === 1}
            className={`
              px-8 py-3 rounded-xl font-semibold transition-all duration-200
              ${currentStep === 1
                ? 'bg-neutral-900 text-neutral-600 cursor-not-allowed'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 border border-neutral-700'
              }
            `}
          >
            Back
          </button>

          {currentStep < 4 ? (
            <button
              type="button"
              onClick={handleNext}
              className="px-8 py-3 rounded-xl font-semibold transition-all duration-200 hover:opacity-90"
              style={{ backgroundColor: '#E84B1A', color: '#fff' }}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submissionProgress.step !== 'idle' && submissionProgress.step !== 'error'}
              className="px-8 py-3 rounded-xl font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
              style={{ backgroundColor: '#E84B1A', color: '#fff' }}
            >
              Submit Report
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ReportSubmissionForm;
