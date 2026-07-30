import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import { WarningIcon, CopyIcon, CheckIcon } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { defineModal } from '@/shared/lib/modals';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';

export interface PushErrorDialogProps {
  message: string;
  title?: string;
}

// Push failures surface the full git stderr/stdout (often multi-line, e.g. a
// rejected pre-push hook or server-side message). ConfirmDialog truncates that
// into a cramped description, so this dedicated dialog shows the whole thing in
// a scrollable, selectable monospace block with a one-click copy button.
const PushErrorDialogImpl = create<PushErrorDialogProps>((props) => {
  const modal = useModal();
  const { message, title } = props;
  const { t } = useTranslation(['tasks', 'common']);
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    modal.resolve();
    modal.hide();
  };

  const handleCopy = async () => {
    await writeClipboardViaBridge(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={modal.visible} onOpenChange={handleClose} size="2xl">
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <WarningIcon className="h-6 w-6 text-destructive" />
            <DialogTitle>{title ?? t('tasks:git.pushError.title')}</DialogTitle>
          </div>
        </DialogHeader>

        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-secondary p-3 text-xs font-mono text-normal select-text">
          {message}
        </pre>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={handleCopy}>
            {copied ? (
              <CheckIcon className="mr-2 h-4 w-4 text-success" weight="bold" />
            ) : (
              <CopyIcon className="mr-2 h-4 w-4" weight="bold" />
            )}
            {copied
              ? t('common:actions.copied')
              : t('tasks:git.pushError.copy')}
          </Button>
          <Button type="submit" onClick={handleClose}>
            {t('common:buttons.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const PushErrorDialog = defineModal<PushErrorDialogProps, void>(
  PushErrorDialogImpl
);
