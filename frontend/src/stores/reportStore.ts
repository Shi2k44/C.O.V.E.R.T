/**
 * C.O.V.E.R.T - Report State Management (Zustand)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Types
export type ReportStatus =
  // New lifecycle statuses (v2)
  | 'pending_review'         // submitted, awaiting reviewer
  | 'needs_evidence'         // reviewer returned: needs more evidence
  | 'rejected_by_reviewer'   // reviewer flagged as spam/reject
  | 'pending_moderation'     // reviewer passed; awaiting moderator
  | 'appealed'               // reporter appealed reviewer decision
  | 'verified'               // moderator approved
  | 'rejected'               // moderator rejected
  | 'archived'
  // Legacy statuses (backward compat)
  | 'pending'
  | 'under_review'
  | 'disputed';
export type ReportVisibility = 'private' | 'moderated' | 'public';
export type ReportCategory = 'corruption' | 'fraud' | 'safety' | 'environment' | 'human_rights' | 'other';

export interface Report {
  id: string;
  commitmentHash: string;
  ipfsCid: string;
  transactionHash: string;
  category: ReportCategory;
  title?: string;
  description?: string;
  status: ReportStatus;
  visibility: ReportVisibility;
  verificationScore?: number;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  fileSize: number;
  submittedAt: string;
  updatedAt?: string;
  // Decision labels from backend DB (populated by API responses)
  reviewDecisionLabel?: string;  // 'REVIEW_PASSED' | 'NEEDS_EVIDENCE' | 'REJECT_SPAM'
  finalLabel?: string;           // 'CORROBORATED' | 'NEEDS_EVIDENCE' | 'DISPUTED' | 'FALSE_OR_MANIPULATED'
  // On-chain fields (populated by enrichment in MySubmissions)
  onChainId?: number;
  reviewDecision?: number;    // 0=NONE, 1=NEEDS_EVIDENCE, 2=REVIEW_PASSED, 3=REJECT_SPAM
  hasAppeal?: boolean;
  finalizedAt?: number;
}

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface ReportDraft {
  category: ReportCategory | '';
  title: string;
  description: string;
  visibility: ReportVisibility;
  delayHours: number;
  files: File[];
  fileMetadata: FileMetadata[];
  /** User-selected Bangalore govt department for post-decision routing */
  department: string;
}

export interface SubmissionProgress {
  step: 'idle' | 'encrypting' | 'uploading' | 'committing' | 'submitting' | 'complete' | 'error';
  progress: number;
  message: string;
  error?: string;
}

export interface ReportFilters {
  status?: ReportStatus;
  category?: ReportCategory;
  search?: string;
  sortBy: 'submittedAt' | 'status' | 'category';
  sortOrder: 'asc' | 'desc';
}

export interface ReportAnalytics {
  totalReports: number;
  pendingReports: number;
  verifiedReports: number;
  rejectedReports: number;
  averageVerificationTime: number;
}

interface ReportState {
  // User's reports
  reports: Report[];
  isLoading: boolean;
  error: string | null;

  // Current draft
  draft: ReportDraft;

  // Submission state
  submissionProgress: SubmissionProgress;

  // Filters
  filters: ReportFilters;

  // Analytics
  analytics: ReportAnalytics | null;

  // Actions - Reports
  setReports: (reports: Report[]) => void;
  addReport: (report: Report) => void;
  updateReport: (id: string, updates: Partial<Report>) => void;
  removeReport: (id: string) => void;

  // Actions - Draft
  updateDraft: (updates: Partial<ReportDraft>) => void;
  resetDraft: () => void;
  addFile: (file: File) => void;
  removeFile: (index: number) => void;

  // Actions - Submission
  setSubmissionProgress: (progress: Partial<SubmissionProgress>) => void;
  resetSubmission: () => void;

  // Actions - Filters
  setFilters: (filters: Partial<ReportFilters>) => void;
  resetFilters: () => void;

  // Actions - Loading/Error
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Actions - Analytics
  setAnalytics: (analytics: ReportAnalytics) => void;

  // Computed
  getFilteredReports: () => Report[];
  getReportById: (id: string) => Report | undefined;
}

const initialDraft: ReportDraft = {
  category: '',
  title: '',
  description: '',
  visibility: 'moderated',
  delayHours: 0,
  files: [],
  fileMetadata: [],
  department: '',
};

const initialProgress: SubmissionProgress = {
  step: 'idle',
  progress: 0,
  message: '',
};

const initialFilters: ReportFilters = {
  sortBy: 'submittedAt',
  sortOrder: 'desc',
};

export const useReportStore = create<ReportState>()(
  persist(
    (set, get) => ({
      // Initial state
      reports: [],
      isLoading: false,
      error: null,
      draft: initialDraft,
      submissionProgress: initialProgress,
      filters: initialFilters,
      analytics: null,

      // Report actions
      setReports: (reports) => set({ reports }),

      addReport: (report) => set((state) => ({
        reports: [report, ...state.reports],
      })),

      updateReport: (id, updates) => set((state) => ({
        reports: state.reports.map((r) =>
          r.id === id ? { ...r, ...updates } : r
        ),
      })),

      removeReport: (id) => set((state) => ({
        reports: state.reports.filter((r) => r.id !== id),
      })),

      // Draft actions
      updateDraft: (updates) => set((state) => ({
        draft: { ...state.draft, ...updates },
      })),

      resetDraft: () => set({ draft: initialDraft }),

      addFile: (file) => set((state) => ({
        draft: {
          ...state.draft,
          files: [...state.draft.files, file],
          fileMetadata: [...state.draft.fileMetadata, {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
          }],
        },
      })),

      removeFile: (index) => set((state) => ({
        draft: {
          ...state.draft,
          files: state.draft.files.filter((_, i) => i !== index),
          fileMetadata: state.draft.fileMetadata.filter((_, i) => i !== index),
        },
      })),

      // Submission actions
      setSubmissionProgress: (progress) => set((state) => ({
        submissionProgress: { ...state.submissionProgress, ...progress },
      })),

      resetSubmission: () => set({ submissionProgress: initialProgress }),

      // Filter actions
      setFilters: (filters) => set((state) => ({
        filters: { ...state.filters, ...filters },
      })),

      resetFilters: () => set({ filters: initialFilters }),

      // Loading/Error actions
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),

      // Analytics actions
      setAnalytics: (analytics) => set({ analytics }),

      // Computed
      getFilteredReports: () => {
        const { reports, filters } = get();
        let filtered = [...reports];

        // Filter by status
        if (filters.status) {
          filtered = filtered.filter((r) => r.status === filters.status);
        }

        // Filter by category
        if (filters.category) {
          filtered = filtered.filter((r) => r.category === filters.category);
        }

        // Filter by search
        if (filters.search) {
          const search = filters.search.toLowerCase();
          filtered = filtered.filter(
            (r) =>
              r.title?.toLowerCase().includes(search) ||
              r.id.toLowerCase().includes(search) ||
              r.commitmentHash.toLowerCase().includes(search)
          );
        }

        // Sort
        filtered.sort((a, b) => {
          let comparison = 0;

          switch (filters.sortBy) {
            case 'submittedAt':
              comparison = new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
              break;
            case 'status':
              comparison = a.status.localeCompare(b.status);
              break;
            case 'category':
              comparison = a.category.localeCompare(b.category);
              break;
          }

          return filters.sortOrder === 'asc' ? comparison : -comparison;
        });

        return filtered;
      },

      getReportById: (id) => {
        return get().reports.find((r) => r.id === id);
      },
    }),
    {
      // v3: restore draft text-field persistence (files are never serialisable,
      //     but category/title/description/visibility survive page refresh).
      //     Draft is cleared programmatically on wallet disconnect + after submit.
      name: 'covert-reports-v3',
      partialize: (state) => ({
        // Only persist the submitted reports list, active filters, and
        // the draft's text fields (so the user can navigate away and come back).
        // File objects are never persisted — they must be re-uploaded each session.
        reports: state.reports,
        filters: state.filters,
        draft: {
          category: state.draft.category,
          title: state.draft.title,
          description: state.draft.description,
          visibility: state.draft.visibility,
          files: [],
          fileMetadata: [],
        },
      }),
      merge: (persisted: unknown, current) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        return { ...current, ...p };
      },
    }
  )
);

// Selectors
export const selectReports = (state: ReportState) => state.reports;
export const selectDraft = (state: ReportState) => state.draft;
export const selectSubmissionProgress = (state: ReportState) => state.submissionProgress;
export const selectFilters = (state: ReportState) => state.filters;
export const selectAnalytics = (state: ReportState) => state.analytics;
export const selectIsLoading = (state: ReportState) => state.isLoading;
export const selectError = (state: ReportState) => state.error;
