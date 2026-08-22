import { useCallback } from 'react';
import { create } from 'zustand';
import { openExternalUrl, reserveExternalWindow } from '@vibe/ui/lib/open-url';
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

// The current PR form (AI-generated and/or hand-edited) for a workspace. Held
// here rather than only in the dialog's local state so it survives the dialog
// unmounting when the user navigates away, instead of the default first-message
// prefill overwriting a generated/edited draft on the next open.
export interface PrDraft {
  title: string;
  body: string;
}

interface PrBackgroundEntry {
  generate?: PrGenerateTask;
  create?: PrCreateTask;
  draftsByRepo?: Record<string, PrDraft>;
}

interface PrBackgroundState {
  byWorkspace: Record<string, PrBackgroundEntry | undefined>;
  startGenerate: (
    workspaceId: string,
    req: GeneratePrDescriptionRequest,
    hostId?: string | null
  ) => void;
  startCreate: (
    workspaceId: string,
    req: CreatePrApiRequest,
    hostId?: string | null
  ) => void;
  cancelGenerate: (workspaceId: string) => void;
  cancelCreate: (workspaceId: string) => void;
  clearGenerate: (workspaceId: string) => void;
  clearCreate: (workspaceId: string) => void;
  setDraft: (workspaceId: string, repoId: string, draft: PrDraft) => void;
  clearDraft: (workspaceId: string, repoId: string) => void;
}

// AbortControllers are non-serializable and must not trigger re-renders, so
// they live outside the reactive store, keyed by workspace id.
const controllers = new Map<
  string,
  {
    generate?: AbortController;
    create?: AbortController;
    createWindow?: Window | null;
  }
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
  if (entry && !entry.generate && !entry.create && !entry.createWindow) {
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
  if (
    !entry.generate &&
    !entry.create &&
    (!entry.draftsByRepo || Object.keys(entry.draftsByRepo).length === 0)
  ) {
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

    startGenerate: (workspaceId, req, hostId) => {
      if (get().byWorkspace[workspaceId]?.generate?.status === 'running') {
        return;
      }
      const controller = new AbortController();
      slot(workspaceId).generate = controller;
      patch(workspaceId, { generate: { status: 'running' } });

      workspacesApi
        .generatePrDescription(workspaceId, req, controller.signal, hostId)
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

    startCreate: (workspaceId, req, hostId) => {
      if (get().byWorkspace[workspaceId]?.create?.status === 'running') {
        return;
      }
      const controller = new AbortController();
      const controllerSlot = slot(workspaceId);
      controllerSlot.create = controller;
      // Reserve the window synchronously while the create-button click still
      // has user activation. Opening it after the API response is popup-blocked.
      controllerSlot.createWindow = reserveExternalWindow();
      patch(workspaceId, {
        create: { status: 'running', baseBranch: req.target_branch },
      });

      workspacesApi
        .createPR(workspaceId, req, controller.signal, hostId)
        .then((result) => {
          if (slot(workspaceId).create !== controller) return;
          if (result.success) {
            const createWindow = slot(workspaceId).createWindow;
            if (!openExternalUrl(result.data, createWindow)) {
              createWindow?.close();
            }
          } else {
            slot(workspaceId).createWindow?.close();
          }
          slot(workspaceId).createWindow = undefined;
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
          slot(workspaceId).createWindow?.close();
          slot(workspaceId).createWindow = undefined;
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
      slot(workspaceId).createWindow?.close();
      slot(workspaceId).createWindow = undefined;
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

    setDraft: (workspaceId, repoId, draft) => {
      const entry = get().byWorkspace[workspaceId];
      patch(workspaceId, {
        draftsByRepo: { ...entry?.draftsByRepo, [repoId]: draft },
      });
    },

    clearDraft: (workspaceId, repoId) =>
      set((state) => {
        const entry = state.byWorkspace[workspaceId];
        if (!entry?.draftsByRepo?.[repoId]) return state;
        const draftsByRepo = { ...entry.draftsByRepo };
        delete draftsByRepo[repoId];
        return {
          byWorkspace: writeWorkspace(state.byWorkspace, workspaceId, {
            ...entry,
            draftsByRepo,
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
