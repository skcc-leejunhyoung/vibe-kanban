import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@phosphor-icons/react';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import BranchSelector from '@/shared/components/tasks/BranchSelector';
import { useRepoBranches } from '@/shared/hooks/useRepoBranches';
import { defineModal } from '@/shared/lib/modals';

/**
 * Copy differs a little per caller, so the dialog looks up its title, blurb and
 * confirm-button label from a small mode map instead of every call site passing
 * strings. `select` = generic "pick an existing branch" (workspace creation /
 * working-branch row); `changeTarget` = "change this workspace's target branch".
 */
export type BranchPickerMode =
  | 'select'
  | 'changeTarget'
  | 'updateTargetFromBase';

export interface BranchPickerDialogProps {
  repoId: string;
  mode: BranchPickerMode;
  /** Repo name shown in the `select` mode title. */
  repoDisplayName?: string;
  /** Host scope for the branch fetch; defaults to the local host. */
  hostId?: string | null;
  /** Pre-selected branch when the dialog opens. */
  initialBranch?: string | null;
  excludeCurrentBranch?: boolean;
}

/**
 * Shared branch picker used by every "choose a branch" flow so they look and
 * behave the same: a searchable {@link BranchSelector} in a dialog, backed by a
 * fresh `git fetch` on open. `.show()` resolves the chosen branch name, or
 * `null` if the dialog was dismissed.
 */
const BranchPickerDialogImpl = create<BranchPickerDialogProps>(
  ({
    repoId,
    mode,
    repoDisplayName,
    hostId,
    initialBranch,
    excludeCurrentBranch = false,
  }) => {
    const modal = useModal();
    const { t } = useTranslation(['tasks', 'common']);
    const [selectedBranch, setSelectedBranch] = useState<string>(
      initialBranch ?? ''
    );

    // Always fetch from origin so the list is current at the moment of picking.
    const {
      data: branches = [],
      isLoading,
      isError,
      refetch,
    } = useRepoBranches(repoId, { fetch: true, hostId });

    // nice-modal keeps the component mounted between opens, so re-run the fetch
    // and reset the selection every time the dialog becomes visible to keep the
    // "always fetch latest right before selecting" guarantee.
    useEffect(() => {
      if (!modal.visible) return;
      setSelectedBranch(initialBranch ?? '');
      void refetch();
    }, [modal.visible, initialBranch, refetch]);

    // Once branches load, default the selection to the initial branch if it is
    // present, otherwise leave it empty so the placeholder shows.
    useEffect(() => {
      if (!initialBranch || selectedBranch) return;
      if (branches.some((b) => b.name === initialBranch)) {
        setSelectedBranch(initialBranch);
      }
    }, [branches, initialBranch, selectedBranch]);

    const resolveWith = (branch: string | null) => {
      modal.resolve(branch);
      modal.hide();
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) resolveWith(null);
    };

    const title =
      mode === 'changeTarget'
        ? t('branches.changeTarget.dialog.title')
        : mode === 'updateTargetFromBase'
          ? t('branches.updateTargetFromBase.dialog.title')
          : repoDisplayName
          ? t('commandBar.selectBranchFor', {
              repoName: repoDisplayName,
              ns: 'common',
            })
          : t('commandBar.selectBranch', { ns: 'common' });

    const description =
      mode === 'changeTarget'
        ? t('branches.changeTarget.dialog.description')
        : mode === 'updateTargetFromBase'
          ? t('branches.updateTargetFromBase.dialog.description')
          : null;

    const confirmLabel =
      mode === 'changeTarget'
        ? t('branches.changeTarget.dialog.action')
        : mode === 'updateTargetFromBase'
          ? t('branches.updateTargetFromBase.dialog.action')
          : t('createMode.targetBranch.selectBranch', { ns: 'common' });

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange} size="md">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription>{description}</DialogDescription>
            )}
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <SpinnerIcon className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="branch-picker" className="text-sm font-medium">
                {t('rebase.dialog.targetLabel')}
              </label>
              <BranchSelector
                branches={branches}
                selectedBranch={selectedBranch || null}
                onBranchSelect={setSelectedBranch}
                excludeCurrentBranch={excludeCurrentBranch}
              />
              {isError && (
                <p className="text-sm text-destructive">
                  {t('createMode.targetBranch.errors.loadFailed', {
                    ns: 'common',
                  })}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => resolveWith(null)}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button
              type="submit"
              onClick={() => resolveWith(selectedBranch)}
              disabled={isLoading || !selectedBranch}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const BranchPickerDialog = defineModal<
  BranchPickerDialogProps,
  string | null
>(BranchPickerDialogImpl);
