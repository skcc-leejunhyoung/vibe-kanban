import { useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { Alert, AlertDescription } from '@vibe/ui/components/Alert';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { defineModal } from '@/shared/lib/modals';
import { useMergeRemote } from '@/shared/hooks/useMergeRemote';
import { useResetToRemote } from '@/shared/hooks/useResetToRemote';

export interface ReconcileRemoteBranchDialogProps {
  workspaceId: string;
  repoId: string;
  ahead: number;
  behind: number;
  triggeredByPush?: boolean;
  isTarget?: boolean;
  hostId?: string | null;
}

export type ReconcileRemoteBranchDialogResult =
  | 'merged'
  | 'reset'
  | 'conflicts'
  | 'canceled';

const ReconcileRemoteBranchDialogImpl =
  create<ReconcileRemoteBranchDialogProps>((props) => {
    const {
      workspaceId,
      repoId,
      ahead,
      behind,
      triggeredByPush = false,
      isTarget = false,
      hostId,
    } = props;
    const modal = useModal();
    const { t } = useTranslation(['tasks', 'common']);
    const [error, setError] = useState<string | null>(null);

    const finish = (result: ReconcileRemoteBranchDialogResult) => {
      modal.resolve(result);
      modal.hide();
    };

    const mergeRemote = useMergeRemote(
      workspaceId,
      () => finish('merged'),
      (err, errorData) => {
        if (errorData?.type === 'merge_conflicts') {
          finish('conflicts');
          return;
        }
        setError(
          err instanceof Error
            ? err.message
            : t('tasks:git.reconcileRemote.error')
        );
      },
      isTarget,
      hostId
    );
    const resetToRemote = useResetToRemote(
      workspaceId,
      () => finish('reset'),
      (err) => {
        setError(
          err instanceof Error
            ? err.message
            : t('tasks:git.reconcileRemote.resetError')
        );
      },
      isTarget,
      hostId
    );

    const handleMerge = async () => {
      setError(null);
      try {
        await mergeRemote.mutateAsync({ repo_id: repoId });
      } catch {
        // Mutation callback renders or hands off the error.
      }
    };

    const handleReset = async () => {
      const confirmation = await ConfirmDialog.show({
        title: t('tasks:git.reconcileRemote.resetConfirmTitle'),
        message: t(
          isTarget
            ? 'tasks:git.reconcileRemote.targetResetConfirmMessage'
            : 'tasks:git.reconcileRemote.resetConfirmMessage',
          { ahead }
        ),
        confirmText: t('tasks:git.reconcileRemote.resetToRemote'),
        variant: 'destructive',
      });
      if (confirmation !== 'confirmed') return;

      setError(null);
      try {
        await resetToRemote.mutateAsync({
          repo_id: repoId,
          confirm_discard: true,
        });
      } catch {
        // Mutation callback renders the error.
      }
    };

    const isProcessing = mergeRemote.isPending || resetToRemote.isPending;

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => {
          if (!open) finish('canceled');
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <ArrowDownToLine className="h-6 w-6 text-primary" />
              <DialogTitle>
                {t(
                  isTarget
                    ? 'tasks:git.reconcileRemote.targetTitle'
                    : 'tasks:git.reconcileRemote.title'
                )}
              </DialogTitle>
            </div>
            <DialogDescription className="space-y-2 pt-2 text-left">
              <p>
                {t(
                  triggeredByPush
                    ? 'tasks:git.reconcileRemote.pushDescription'
                    : isTarget
                      ? 'tasks:git.reconcileRemote.targetPullDescription'
                      : 'tasks:git.reconcileRemote.pullDescription',
                  { ahead, behind }
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('tasks:git.reconcileRemote.note')}
              </p>
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={handleReset}
              disabled={isProcessing}
              className="text-destructive hover:text-destructive"
            >
              {t('tasks:git.reconcileRemote.resetToRemote')}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => finish('canceled')}
              disabled={isProcessing}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button type="submit" onClick={handleMerge} disabled={isProcessing}>
              {isProcessing && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('tasks:git.reconcileRemote.mergeRemote')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  });

export const ReconcileRemoteBranchDialog = defineModal<
  ReconcileRemoteBranchDialogProps,
  ReconcileRemoteBranchDialogResult
>(ReconcileRemoteBranchDialogImpl);
