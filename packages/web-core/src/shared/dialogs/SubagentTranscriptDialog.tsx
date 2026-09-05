import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
import type {
  NormalizedEntry,
  RepoWithTargetBranch,
  SubagentControlTarget,
  SubagentTranscript,
} from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import { executionProcessesApi } from '@/shared/lib/api';
import type { WorkspaceWithSession } from '@/shared/types/attempt';
import type { UseResetProcessResult } from '@/features/workspace-chat/model/hooks/useResetProcess';
import DisplayConversationEntry from '@/features/workspace-chat/ui/DisplayConversationEntry';
import {
  ChangesViewActionsContext,
  type ChangesViewActionsContextValue,
} from '@/shared/hooks/useChangesView';

export interface SubagentTranscriptDialogProps {
  processId: string;
  target: SubagentControlTarget;
  title?: string;
  hostId?: string | null;
  isLive?: () => boolean;
  workspaceWithSession: WorkspaceWithSession;
  resetAction: UseResetProcessResult;
  repos: RepoWithTargetBranch[];
  changesViewActions: ChangesViewActionsContextValue;
}

export interface TranscriptMessage {
  role: 'user' | 'agent';
  content: string;
}

export const shouldPollTranscript = (
  visible: boolean,
  isLive?: () => boolean
) => visible && Boolean(isLive?.());

export function parseTranscriptMessages(content: string): TranscriptMessage[] {
  const marker = /(?:^|\n\n)\*\*(User|Agent)\*\*\n\n/g;
  const matches = [...content.matchAll(marker)];
  if (matches.length === 0) return [{ role: 'agent', content }];

  return matches
    .map((match, index) => ({
      role: match[1].toLowerCase() as TranscriptMessage['role'],
      content: content
        .slice(
          (match.index ?? 0) + match[0].length,
          matches[index + 1]?.index ?? content.length
        )
        .trim(),
    }))
    .filter((message) => message.content.length > 0);
}

export function getTranscriptEntries(
  transcript: SubagentTranscript
): NormalizedEntry[] {
  if (transcript.entries?.length) return transcript.entries;
  return parseTranscriptMessages(transcript.content).map(
    (message): NormalizedEntry => ({
      timestamp: null,
      entry_type: {
        type: message.role === 'user' ? 'user_message' : 'assistant_message',
      },
      content: message.content,
    })
  );
}

const SubagentTranscriptDialogImpl = create<SubagentTranscriptDialogProps>(
  (props) => {
    const modal = useModal();
    const { t } = useTranslation();
    const requestKey = JSON.stringify([
      props.hostId ?? null,
      props.processId,
      props.target,
    ]);
    const [loaded, setLoaded] = useState<{
      requestKey: string;
      transcript: SubagentTranscript | null;
      error: string | null;
    } | null>(null);
    const transcript =
      loaded?.requestKey === requestKey ? loaded.transcript : null;
    const error = loaded?.requestKey === requestKey ? loaded.error : null;

    useEffect(() => {
      if (!modal.visible) return;
      let cancelled = false;
      let timeout: number | undefined;
      const load = async () => {
        await executionProcessesApi
          .subagentTranscript(props.processId, props.target, props.hostId)
          .then((transcript) => {
            if (!cancelled) {
              setLoaded({ requestKey, transcript, error: null });
            }
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              const error = err instanceof Error ? err.message : String(err);
              setLoaded((current) => ({
                requestKey,
                transcript:
                  current?.requestKey === requestKey
                    ? current.transcript
                    : null,
                error,
              }));
            }
          });
        if (!cancelled && shouldPollTranscript(modal.visible, props.isLive))
          timeout = window.setTimeout(load, 2000);
      };
      void load();
      return () => {
        cancelled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
      };
    }, [
      modal.visible,
      props.processId,
      props.target,
      props.hostId,
      props.isLive,
      requestKey,
    ]);

    const renderStructuredEntry = (entry: NormalizedEntry, index: number) => {
      return (
        <DisplayConversationEntry
          key={index}
          expansionKey={`transcript:${props.processId}:${index}`}
          executionProcessId={props.processId}
          workspaceWithSession={props.workspaceWithSession}
          resetAction={props.resetAction}
          repos={props.repos}
          entry={entry}
          aggregatedGroup={null}
          aggregatedDiffGroup={null}
          aggregatedThinkingGroup={null}
          readOnly
          artifactOverrides={(transcript?.artifacts ?? []).filter(
            (artifact) => artifact.source_entry === index
          )}
        />
      );
    };

    return (
      <ChangesViewActionsContext.Provider value={props.changesViewActions}>
        <Dialog
          open={modal.visible}
          onOpenChange={(open) => {
            if (!open) modal.hide();
          }}
          size="3xl"
        >
          <DialogContent className="w-full p-0 overflow-hidden">
            <DialogHeader className="px-4 pt-4 pb-0">
              <DialogTitle className="truncate">
                {props.title || t('conversation.subagent.transcriptTitle')}
              </DialogTitle>
            </DialogHeader>
            <div className="max-h-[70vh] overflow-y-auto py-2">
              {error && transcript == null ? (
                <p className="px-4 py-2 text-sm text-error">
                  {t('conversation.subagent.transcriptError')}: {error}
                </p>
              ) : transcript == null ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              ) : (
                getTranscriptEntries(transcript).map(renderStructuredEntry)
              )}
            </div>
          </DialogContent>
        </Dialog>
      </ChangesViewActionsContext.Provider>
    );
  }
);

export const SubagentTranscriptDialog = defineModal<
  SubagentTranscriptDialogProps,
  void
>(SubagentTranscriptDialogImpl);
