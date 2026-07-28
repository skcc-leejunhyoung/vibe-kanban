import { create } from 'zustand';

interface PendingPrChatContext {
  workspaceId: string;
  markdown: string;
}

interface PrChatContextState {
  pending: PendingPrChatContext | null;
  add: (workspaceId: string, markdown: string) => void;
  clear: () => void;
}

export const usePrChatContextStore = create<PrChatContextState>()((set) => ({
  pending: null,
  add: (workspaceId, markdown) => set({ pending: { workspaceId, markdown } }),
  clear: () => set({ pending: null }),
}));
