import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { create, useModal } from '@ebay/nice-modal-react';
import { Loader2 } from 'lucide-react';
import { RobotIcon, UserIcon } from '@phosphor-icons/react';
import type { SubagentControlTarget } from 'shared/types';
import { ChatMarkdown } from '@vibe/ui/components/ChatMarkdown';
import { defineModal } from '@/shared/lib/modals';
import { executionProcessesApi } from '@/shared/lib/api';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';

export interface SubagentTranscriptDialogProps {
  processId: string;
  target: SubagentControlTarget;
  title?: string;
  hostId?: string | null;
  isLive?: () => boolean;
}

export interface TranscriptMessage {
  role: 'user' | 'agent';
  content: string;
}

export function TranscriptMessageFrame({
  role,
  label,
  children,
}: {
  role: TranscriptMessage['role'];
  label: string;
  children: ReactNode;
}) {
  const user = role === 'user';
  const Icon = user ? UserIcon : RobotIcon;
  return (
    <section
      aria-label={label}
      data-transcript-role={role}
      className={`flex ${user ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`w-full max-w-[85%] overflow-hidden rounded-lg border ${
          user ? 'border-brand/30 bg-brand/10' : 'border-border bg-panel'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-low">
          <Icon className="size-icon-xs" aria-hidden />
          {label}
        </div>
        <div className="px-3 py-2">{children}</div>
      </div>
    </section>
  );
}

export const shouldPollTranscript = (isLive?: () => boolean) => isLive?.();

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

const SubagentTranscriptDialogImpl = create<SubagentTranscriptDialogProps>(
  (props) => {
    const modal = useModal();
    const { t } = useTranslation();
    const [content, setContent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      let timeout: number | undefined;
      const load = async () => {
        await executionProcessesApi
          .subagentTranscript(props.processId, props.target, props.hostId)
          .then((transcript) => {
            if (!cancelled) {
              setContent(transcript.content);
              setError(null);
            }
          })
          .catch((err: unknown) => {
            if (!cancelled)
              setError(err instanceof Error ? err.message : String(err));
          });
        if (!cancelled && shouldPollTranscript(props.isLive))
          timeout = window.setTimeout(load, 2000);
      };
      void load();
      return () => {
        cancelled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
      };
    }, [props.processId, props.target, props.hostId, props.isLive]);

    const renderMarkdown = (value: string) => (
      <ChatMarkdown
        content={value}
        maxWidth="none"
        renderContent={({ content, className }) => (
          <WYSIWYGEditor value={content} disabled className={className} />
        )}
      />
    );

    return (
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
          <div className="max-h-[70vh] overflow-y-auto px-4 py-4">
            {error && content == null ? (
              <p className="text-sm text-error">
                {t('conversation.subagent.transcriptError')}: {error}
              </p>
            ) : content == null ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              </div>
            ) : (
              <div className="space-y-4">
                {parseTranscriptMessages(content).map((message, index) => (
                  <TranscriptMessageFrame
                    key={index}
                    role={message.role}
                    label={
                      message.role === 'user'
                        ? `${t('conversation.input')} · ${t(
                            'conversation.you',
                            { ns: 'tasks' }
                          )}`
                        : `${t('conversation.output')} · ${t(
                            'modelSelector.agent'
                          )}`
                    }
                  >
                    {renderMarkdown(message.content)}
                  </TranscriptMessageFrame>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export const SubagentTranscriptDialog = defineModal<
  SubagentTranscriptDialogProps,
  void
>(SubagentTranscriptDialogImpl);
