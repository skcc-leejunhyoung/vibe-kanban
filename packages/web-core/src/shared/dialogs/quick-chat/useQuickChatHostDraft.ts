import { useCallback, useState } from 'react';
import type {
  DraftWorkspaceAttachment,
  ExecutorConfig,
  Repo,
} from 'shared/types';

/** What was picked for ONE host: the folder, the agent/model, uploaded files. */
export interface QuickChatHostDraft {
  repo: Repo | null;
  scratchConfig: ExecutorConfig | null;
  attachments: DraftWorkspaceAttachment[];
}

export type QuickChatHostDraftPatch =
  | Partial<QuickChatHostDraft>
  | ((draft: QuickChatHostDraft) => Partial<QuickChatHostDraft>);

const EMPTY_DRAFT: QuickChatHostDraft = {
  repo: null,
  scratchConfig: null,
  attachments: [],
};

function isSameDraft(a: QuickChatHostDraft, b: QuickChatHostDraft): boolean {
  return (
    a.repo === b.repo &&
    a.scratchConfig === b.scratchConfig &&
    (a.attachments === b.attachments ||
      (a.attachments.length === 0 && b.attachments.length === 0))
  );
}

/**
 * The host-owned part of a quick chat draft, held above the per-host panel.
 *
 * The panel unmounts whenever the dialog closes (and while its host is
 * unavailable), but the folder a prompt was written about has to be there on
 * the way back: falling back to the most recent repo would run the agent in
 * another working tree. It belongs to one host and is dropped when another
 * is selected — a repo id, a model and an attachment id mean nothing there.
 *
 * `hostKey` is `null` while no host is selected.
 */
export function useQuickChatHostDraft(hostKey: string | null) {
  const [stored, setStored] = useState({ hostKey, draft: EMPTY_DRAFT });
  if (stored.hostKey !== hostKey) setStored({ hostKey, draft: EMPTY_DRAFT });
  const draft = stored.hostKey === hostKey ? stored.draft : EMPTY_DRAFT;

  /**
   * `forHostKey` is the host the caller was mounted for. An answer that
   * arrives after "Run on" moved on (a folder being registered, an upload
   * finishing) names the previous host and is ignored.
   */
  const update = useCallback(
    (forHostKey: string | null, patch: QuickChatHostDraftPatch) => {
      setStored((prev) => {
        if (prev.hostKey !== forHostKey) return prev;
        const next = {
          ...prev.draft,
          ...(typeof patch === 'function' ? patch(prev.draft) : patch),
        };
        return isSameDraft(prev.draft, next)
          ? prev
          : { hostKey: prev.hostKey, draft: next };
      });
    },
    []
  );

  return [draft, update] as const;
}
