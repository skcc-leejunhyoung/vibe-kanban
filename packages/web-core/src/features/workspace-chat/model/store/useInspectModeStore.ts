import { create } from 'zustand';

/**
 * Inspect mode of the preview: picking a component in a workspace's preview
 * pastes its context into that workspace's composer.
 *
 * Both halves are keyed by workspace scope. Several panes can be open at once,
 * each with its own preview and composer, possibly on different hosts; a single
 * global slot switched every preview into inspect mode and pasted the picked
 * component into every open conversation.
 */
interface InspectModeState {
  /** Scope whose preview is in inspect mode, or `null`. */
  inspectScope: string | null;
  toggleInspectMode: (scope: string) => void;
  pendingComponent: { scope: string; markdown: string } | null;
  setPendingComponentMarkdown: (scope: string, markdown: string) => void;
  clearPendingComponentMarkdown: () => void;
}

/** Identity of one workspace across hosts (`null` host = this machine). */
export function inspectModeScope(
  hostId: string | null,
  workspaceId: string | undefined
): string {
  return `${hostId ?? 'local'}:${workspaceId ?? ''}`;
}

export const useInspectModeStore = create<InspectModeState>((set) => ({
  inspectScope: null,
  toggleInspectMode: (scope) =>
    set((s) => ({ inspectScope: s.inspectScope === scope ? null : scope })),
  pendingComponent: null,
  // Picking a component ends inspect mode.
  setPendingComponentMarkdown: (scope, markdown) =>
    set({ pendingComponent: { scope, markdown }, inspectScope: null }),
  clearPendingComponentMarkdown: () => set({ pendingComponent: null }),
}));
