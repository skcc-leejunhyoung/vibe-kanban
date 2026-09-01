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
import type { SubagentControlTarget } from 'shared/types';
import { defineModal } from '@/shared/lib/modals';
import { executionProcessesApi } from '@/shared/lib/api';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';

export interface SubagentTranscriptDialogProps {
  processId: string;
  target: SubagentControlTarget;
  title?: string;
  hostId?: string | null;
}

const SubagentTranscriptDialogImpl = create<SubagentTranscriptDialogProps>(
  (props) => {
    const modal = useModal();
    const { t } = useTranslation();
    const [content, setContent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      executionProcessesApi
        .subagentTranscript(props.processId, props.target, props.hostId)
        .then((transcript) => {
          if (!cancelled) setContent(transcript.content);
        })
        .catch((err: unknown) => {
          if (!cancelled)
            setError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }, [props.processId, props.target, props.hostId]);

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
            {error ? (
              <p className="text-sm text-error">
                {t('conversation.subagent.transcriptError')}: {error}
              </p>
            ) : content == null ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
              </div>
            ) : (
              <WYSIWYGEditor value={content} disabled />
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
