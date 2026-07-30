import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { create, useModal } from '@ebay/nice-modal-react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { defineModal } from '@/shared/lib/modals';
import { usePullAndPush } from '@/shared/hooks/usePullAndPush';
import { useState } from 'react';
import { Alert, AlertDescription } from '@vibe/ui/components/Alert';
import { useTranslation } from 'react-i18next';

export interface PullFirstDialogProps {
  workspaceId: string;
  repoId: string;
  branchName?: string;
  /** Commits the local branch has that the remote lacks. */
  ahead: number;
  /** Commits the remote has that the local branch lacks (would be overwritten). */
  behind: number;
  /** Resolve the divergence on the target (base) branch instead of the work branch. */
  isTarget?: boolean;
}

/**
 * Shown when a push is rejected because the branch diverged (the remote holds
 * commits the local branch is missing). Leads with the safe, non-destructive
 * resolution — pull/merge the remote in, then push — and offers a force push
 * only as an explicit, clearly-destructive fallback.
 *
 * Resolves with one of: `'success'` (pulled & pushed), `'conflicts'` (the merge
 * hit conflicts — the conflict UI takes over), `'force'` (the user chose to
 * force push instead), or `'canceled'`.
 */
const PullFirstDialogImpl = create<PullFirstDialogProps>((props) => {
  const modal = useModal();
  const { workspaceId, repoId, branchName, ahead, behind, isTarget } = props;
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation(['tasks', 'common']);
  const branchLabel = branchName ? ` "${branchName}"` : '';

  const pullAndPush = usePullAndPush(
    workspaceId,
    () => {
      modal.resolve('success');
      modal.hide();
    },
    (err: unknown, errorData) => {
      // A merge conflict isn't a dead end — the worktree is left mid-merge and
      // branchStatus was refreshed, so hand off to the conflict-resolution UI.
      if (errorData?.type === 'merge_conflicts') {
        modal.resolve('conflicts');
        modal.hide();
        return;
      }
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : t('tasks:git.pullFirstDialog.error');
      setError(message);
    },
    isTarget ?? false
  );
  const handlePullAndPush = async () => {
    setError(null);
    try {
      await pullAndPush.mutateAsync({ repo_id: repoId });
    } catch {
      // Error already handled by the onError callback.
    }
  };

  const handleForce = () => {
    modal.resolve('force');
    modal.hide();
  };

  const handleCancel = () => {
    modal.resolve('canceled');
    modal.hide();
  };

  const isProcessing = pullAndPush.isPending;

  return (
    <Dialog open={modal.visible} onOpenChange={handleCancel} size="lg">
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ArrowDownToLine className="h-6 w-6 text-primary" />
            <DialogTitle>{t('tasks:git.pullFirstDialog.title')}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>
              {t('tasks:git.pullFirstDialog.description', {
                branchLabel,
                behind,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('tasks:git.pullFirstDialog.note', { ahead, behind })}
            </p>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            type="button"
            onClick={handleForce}
            disabled={isProcessing}
            className="text-destructive hover:text-destructive"
          >
            {t('tasks:git.pullFirstDialog.forceInstead')}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={handleCancel}
              disabled={isProcessing}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button
              type="submit"
              onClick={handlePullAndPush}
              disabled={isProcessing}
            >
              {isProcessing && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isProcessing
                ? t('tasks:git.pullFirstDialog.pulling')
                : t('tasks:git.pullFirstDialog.pullAndPush')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const PullFirstDialog = defineModal<PullFirstDialogProps, string>(
  PullFirstDialogImpl
);
