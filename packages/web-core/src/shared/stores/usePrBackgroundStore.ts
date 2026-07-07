import { useCallback } from 'react';
import { create } from 'zustand';
import { workspacesApi } from '@/shared/lib/api';
import type { Result } from '@/shared/lib/api';
import type {
  CreatePrApiRequest,
  GeneratePrDescriptionRequest,
  PrError,
} from 'shared/types';

/**
 * Background tracking for the two slow PR operations (AI description generation
 * and PR creation) so they survive the dialog being dismissed with X / ESC.
 * State is keyed by workspace id and lives outside the dialog component, so
 * closing and reopening the dialog just re-attaches to the running operation.
 * Only an explicit cancel aborts the in-flight request.
 */

export interface PrGenerateTask {
  status: 'running' | 'success' | 'error';
  title?: string;
  description?: string;
  error?: string;
}

export interface PrCreateTask {
  // `done` means the request returned; the business success/failure lives in
  // `result`. `error` is a network/unexpected throw.
  status: 'running' | 'done' | 'error';
  // Base branch that was used, so success handling can remember it without
  // relying on (possibly reset) dialog form state.
  baseBranch?: string | null;
  result?: Result<string, PrError>;
  error?: string;
}

interface PrBackgroundEntry {
  generate?: PrGenerateTask;
  create?: PrCreateTask;
}

interface PrBackgroundState {
  byWorkspace: Record<string, PrBackgroundEntry | undefined>;
  startGenerate: (
    workspaceId: string,
    req: GeneratePrDescriptionRequest
  ) => void;
  startCreate: (workspaceId: string, req: CreatePrApiRequest) => void;
  cancelGenerate: (workspaceId: string) => void;
  cancelCreate: (workspaceId: string) => void;
  clearGenerate: (workspaceId: string) => void;
  clearCreate: (workspaceId: string) => void;
}

// AbortControllers are non-serializable and must not trigger re-renders, so
// they live outside the reactive store, keyed by workspace id.
const controllers = new Map<
  string,
  { generate?: AbortController; create?: AbortController }
>();

function slot(workspaceId: string) {
  let entry = controllers.get(workspaceId);
  if (!entry) {
    entry = {};
    controllers.set(workspaceId, entry);
  }
  return entry;
}

// Drop the controllers map entry once neither operation is in flight, so a long
// session touching many workspaces doesn't accumulate empty entries.
function pruneControllers(workspaceId: string) {
  const entry = controllers.get(workspaceId);
  if (entry && !entry.generate && !entry.create) {
    controllers.delete(workspaceId);
  }
}

// Write a workspace entry, or remove the key entirely when both slots are empty,
// keeping `byWorkspace` from growing unbounded across workspaces.
function writeWorkspace(
  byWorkspace: Record<string, PrBackgroundEntry | undefined>,
  workspaceId: string,
  entry: PrBackgroundEntry
): Record<string, PrBackgroundEntry | undefined> {
  const next = { ...byWorkspace };
  if (!entry.generate && !entry.create) {
    delete next[workspaceId];
    pruneControllers(workspaceId);
  } else {
    next[workspaceId] = entry;
  }
  return next;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export const usePrBackgroundStore = create<PrBackgroundState>()((set, get) => {
  const patch = (workspaceId: string, partial: Partial<PrBackgroundEntry>) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: { ...state.byWorkspace[workspaceId], ...partial },
      },
    }));

  return {
    byWorkspace: {},

    startGenerate: (workspaceId, req) => {
      if (get().byWorkspace[workspaceId]?.generate?.status === 'running') {
        return;
      }
      const controller = new AbortController();
      slot(workspaceId).generate = controller;
      patch(workspaceId, { generate: { status: 'running' } });

      workspacesApi
        .generatePrDescription(workspaceId, req, controller.signal)
        .then((res) => {
          if (slot(workspaceId).generate !== controller) return;
          patch(workspaceId, {
            generate: {
              status: 'success',
              title: res.title,
              description: res.description,
            },
          });
        })
        .catch((err) => {
          if (slot(workspaceId).generate !== controller) return;
          if (isAbortError(err)) return; // canceled → already cleared
          patch(workspaceId, {
            generate: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        })
        .finally(() => {
          if (slot(workspaceId).generate === controller) {
            slot(workspaceId).generate = undefined;
            pruneControllers(workspaceId);
          }
        });
    },

    startCreate: (workspaceId, req) => {
      if (get().byWorkspace[workspaceId]?.create?.status === 'running') {
        return;
      }
      const controller = new AbortController();
      slot(workspaceId).create = controller;
      patch(workspaceId, {
        create: { status: 'running', baseBranch: req.target_branch },
      });

      workspacesApi
        .createPR(workspaceId, req, controller.signal)
        .then((result) => {
          if (slot(workspaceId).create !== controller) return;
          patch(workspaceId, {
            create: {
              status: 'done',
              baseBranch: req.target_branch,
              result,
            },
          });
        })
        .catch((err) => {
          if (slot(workspaceId).create !== controller) return;
          if (isAbortError(err)) return; // canceled → already cleared
          patch(workspaceId, {
            create: {
              status: 'error',
              baseBranch: req.target_branch,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        })
        .finally(() => {
          if (slot(workspaceId).create === controller) {
            slot(workspaceId).create = undefined;
            pruneControllers(workspaceId);
          }
        });
    },

    cancelGenerate: (workspaceId) => {
      slot(workspaceId).generate?.abort();
      slot(workspaceId).generate = undefined;
      get().clearGenerate(workspaceId);
    },

    cancelCreate: (workspaceId) => {
      slot(workspaceId).create?.abort();
      slot(workspaceId).create = undefined;
      get().clearCreate(workspaceId);
    },

    clearGenerate: (workspaceId) =>
      set((state) => {
        const entry = state.byWorkspace[workspaceId];
        if (!entry?.generate) return state;
        return {
          byWorkspace: writeWorkspace(state.byWorkspace, workspaceId, {
            ...entry,
            generate: undefined,
          }),
        };
      }),

    clearCreate: (workspaceId) =>
      set((state) => {
        const entry = state.byWorkspace[workspaceId];
        if (!entry?.create) return state;
        return {
          byWorkspace: writeWorkspace(state.byWorkspace, workspaceId, {
            ...entry,
            create: undefined,
          }),
        };
      }),
  };
});

export function usePrBackground(
  workspaceId: string | null | undefined
): PrBackgroundEntry | undefined {
  return usePrBackgroundStore(
    useCallback(
      (state) => (workspaceId ? state.byWorkspace[workspaceId] : undefined),
      [workspaceId]
    )
  );
}
