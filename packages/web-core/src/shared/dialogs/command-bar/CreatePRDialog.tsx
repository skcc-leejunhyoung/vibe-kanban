import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Label } from '@radix-ui/react-label';
import { Textarea } from '@vibe/ui/components/Textarea';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { Alert, AlertDescription, AlertTitle } from '@vibe/ui/components/Alert';
import BranchSelector from '@/shared/components/tasks/BranchSelector';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { Err } from '@/shared/lib/api';
import type { PrError } from 'shared/types';
import {
  usePrBackground,
  usePrBackgroundStore,
} from '@/shared/stores/usePrBackgroundStore';
import { useTranslation } from 'react-i18next';

import { Workspace } from 'shared/types';
import { Loader2, Sparkles } from 'lucide-react';
import { create, useModal } from '@ebay/nice-modal-react';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useRepoBranches } from '@/shared/hooks/useRepoBranches';
import {
  GhCliHelpInstructions,
  GhCliSetupDialog,
  mapGhCliErrorToUi,
} from '@/shared/dialogs/auth/GhCliSetupDialog';
import type {
  GhCliSupportContent,
  GhCliSupportVariant,
} from '@/shared/dialogs/auth/GhCliSetupDialog';
import type { GhCliSetupError } from 'shared/types';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { defineModal } from '@/shared/lib/modals';
import { splitMessageToTitleDescription } from '@/shared/lib/string';

interface CreatePRDialogProps {
  attempt: Workspace;
  repoId: string;
  targetBranch?: string;
  /**
   * Default head (source) branch — typically an intermediate "feature" branch
   * the work branch was merged into (three-branch workflow). Falls back to the
   * workspace's work branch when absent or not found in the branch list.
   */
  headBranch?: string;
  /**
   * Fallback base branch (repo's default target) used when no remembered choice
   * exists and the head is a feature branch (so `targetBranch` would be wrong).
   */
  defaultBaseBranch?: string;
  issueIdentifier?: string;
}

export type CreatePRDialogResult = {
  success: boolean;
  error?: string;
};

const PR_TITLE_SUFFIX = ' (vibe-kanban)';

// Remember the last base branch the user actually opened a PR against, per repo,
// so the next PR (e.g. feature -> develop) defaults to the same base.
const prBaseStorageKey = (repoId: string) => `vk-pr-base:${repoId}`;

const readRememberedBase = (repoId: string): string | undefined => {
  try {
    return localStorage.getItem(prBaseStorageKey(repoId)) ?? undefined;
  } catch {
    return undefined;
  }
};

const rememberBase = (repoId: string, base: string) => {
  try {
    if (base) localStorage.setItem(prBaseStorageKey(repoId), base);
  } catch {
    // localStorage may be unavailable (private mode); remembering is best-effort.
  }
};

const appendPrTitleSuffix = (title: string): string => {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return trimmedTitle;
  if (trimmedTitle.endsWith(PR_TITLE_SUFFIX)) return trimmedTitle;
  return `${trimmedTitle}${PR_TITLE_SUFFIX}`;
};

const CreatePRDialogImpl = create<CreatePRDialogProps>(
  ({
    attempt,
    repoId,
    targetBranch,
    headBranch,
    defaultBaseBranch,
    issueIdentifier,
  }) => {
    const modal = useModal();
    const queryClient = useQueryClient();
    const { t } = useTranslation('tasks');
    const { isLoaded } = useAuth();
    const { environment, config } = useUserSystem();
    const [prTitle, setPrTitle] = useState('');
    const [prBody, setPrBody] = useState('');
    const [prHeadBranch, setPrHeadBranch] = useState('');
    const [prBaseBranch, setPrBaseBranch] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [ghCliHelp, setGhCliHelp] = useState<GhCliSupportContent | null>(
      null
    );
    const [isDraft, setIsDraft] = useState(false);
    const isRemote = useAppRuntime() === 'remote';
    // The settings toggle acts as a master switch for the AI generate button;
    // treat an unloaded config as enabled (backend default) so the button shows.
    const aiEnabled = config?.pr_auto_description_enabled !== false;

    // The two slow operations (AI generate + PR creation) live in a per-workspace
    // background store so they keep running when the dialog is dismissed with
    // X / ESC, and reattach when it is reopened. Only Cancel aborts them.
    const bg = usePrBackground(attempt.id);
    // Select each action individually. The action identities are stable, so this
    // avoids re-rendering the dialog whenever *any* workspace's PR state changes
    // (which a whole-store subscription would trigger).
    const startGenerate = usePrBackgroundStore((s) => s.startGenerate);
    const startCreate = usePrBackgroundStore((s) => s.startCreate);
    const cancelGenerate = usePrBackgroundStore((s) => s.cancelGenerate);
    const cancelCreate = usePrBackgroundStore((s) => s.cancelCreate);
    const generating = bg?.generate?.status === 'running';
    const creatingPR = bg?.create?.status === 'running';

    const { data: branches = [], isLoading: branchesLoading } = useRepoBranches(
      repoId,
      { enabled: modal.visible && !!repoId }
    );

    const getGhCliHelpTitle = (variant: GhCliSupportVariant) =>
      variant === 'homebrew'
        ? 'Homebrew is required for automatic setup'
        : 'GitHub CLI needs manual setup';

    // Initialize form once per workspace. Deliberately NOT keyed on
    // `modal.visible`: reopening the same workspace must preserve edits and any
    // in-progress / completed background result instead of re-running the
    // first-message prefill. A different workspace (attempt.id change) resets.
    const initializedFor = useRef<string | null>(null);
    useEffect(() => {
      if (!isLoaded || initializedFor.current === attempt.id) {
        return;
      }
      initializedFor.current = attempt.id;

      // Fresh form for this workspace.
      setPrHeadBranch('');
      setPrBaseBranch('');
      setIsDraft(false);
      setError(null);
      setGhCliHelp(null);
      setPrTitle('');
      setPrBody('');

      // If a generated result is already waiting for this workspace, leave the
      // title/body to the generate-apply effect below.
      if (
        usePrBackgroundStore.getState().byWorkspace[attempt.id]?.generate
          ?.status === 'success'
      ) {
        return;
      }

      let isCancelled = false;
      const initializePRFields = async () => {
        try {
          const firstUserMessage = await workspacesApi.getFirstUserMessage(
            attempt.id
          );

          if (isCancelled) return;

          if (firstUserMessage?.trim()) {
            const { title, description } =
              splitMessageToTitleDescription(firstUserMessage);
            setPrTitle(appendPrTitleSuffix(title));
            setPrBody(description ?? '');
          }
        } catch {
          // Fall back to empty fields if prompt loading fails.
        }
      };

      initializePRFields();

      return () => {
        isCancelled = true;
      };
    }, [attempt.id, isLoaded, issueIdentifier]);

    // Apply a completed AI generation into the form (works whether it finished
    // while open or in the background), then consume it. Surface generate errors
    // when the dialog is visible; otherwise keep them for the next open.
    useEffect(() => {
      const gen = bg?.generate;
      if (!gen) return;
      if (gen.status === 'success') {
        if (gen.title !== undefined) setPrTitle(gen.title);
        if (gen.description !== undefined) setPrBody(gen.description);
        usePrBackgroundStore.getState().clearGenerate(attempt.id);
      } else if (gen.status === 'error' && modal.visible) {
        setError(gen.error ?? t('createPrDialog.errors.generateFailed'));
        usePrBackgroundStore.getState().clearGenerate(attempt.id);
      }
    }, [bg?.generate, modal.visible, attempt.id, t]);

    // Set default head (source) branch when branches load. Prefer the feature
    // branch the work branch was merged into; fall back to the work branch.
    useEffect(() => {
      if (!modal.visible || branches.length === 0) {
        return;
      }
      const exists = (name: string) =>
        branches.some((branch) => branch.name === name);
      if (prHeadBranch && exists(prHeadBranch)) {
        return;
      }
      const desired =
        headBranch && exists(headBranch) ? headBranch : attempt.branch;
      setPrHeadBranch(exists(desired) ? desired : '');
    }, [branches, modal.visible, prHeadBranch, headBranch, attempt.branch]);

    // Set default base branch when branches/head load. Candidates, best first:
    // a remembered choice, the workspace's current target (only when the head is
    // the work branch — for a feature head the target branch IS the head, so it's
    // skipped), then the repo default. Never default the base to the head branch.
    useEffect(() => {
      if (!modal.visible || branches.length === 0) {
        return;
      }
      const exists = (name: string) =>
        branches.some((branch) => branch.name === name);
      const hasValidSelection =
        prBaseBranch && exists(prBaseBranch) && prBaseBranch !== prHeadBranch;
      if (hasValidSelection) {
        return;
      }
      const candidates = [
        readRememberedBase(repoId),
        // For a work-branch head, the workspace's explicitly chosen merge target
        // is the most accurate base. For a feature head the target IS the head,
        // so it's skipped here and the repo default is used instead.
        prHeadBranch === attempt.branch ? targetBranch : undefined,
        defaultBaseBranch ?? undefined,
      ];
      const pick = candidates.find(
        (c): c is string => !!c && exists(c) && c !== prHeadBranch
      );
      // Leave empty when nothing resolves; backend falls back to repo target branch.
      setPrBaseBranch(pick ?? '');
    }, [
      branches,
      modal.visible,
      prBaseBranch,
      prHeadBranch,
      repoId,
      defaultBaseBranch,
      targetBranch,
      attempt.branch,
    ]);

    const isMacEnvironment = useMemo(
      () => environment?.os_type?.toLowerCase().includes('mac'),
      [environment?.os_type]
    );

    // Kick off PR creation in the background store so it survives the dialog
    // being dismissed with X / ESC. The outcome is handled by the effect below.
    const handleConfirmCreatePR = useCallback(() => {
      if (!repoId || !attempt.id || creatingPR) return;
      setError(null);
      setGhCliHelp(null);
      startCreate(attempt.id, {
        title: prTitle,
        body: prBody || null,
        target_branch: prBaseBranch || null,
        head_branch: prHeadBranch || null,
        draft: isDraft,
        repo_id: repoId,
      });
    }, [
      attempt.id,
      repoId,
      prHeadBranch,
      prBaseBranch,
      prBody,
      prTitle,
      isDraft,
      creatingPR,
      startCreate,
    ]);

    // Map a business failure from createPR onto the dialog (error text or the
    // GitHub CLI setup flow). Mirrors the pre-background behaviour.
    const processCreateFailure = useCallback(
      async (result: Err<PrError>) => {
        const handleGhCliSetupOutcome = (
          setupResult: GhCliSetupError | null,
          fallbackMessage: string
        ) => {
          if (setupResult === null) {
            setError(null);
            setGhCliHelp(null);
            modal.hide();
            return;
          }

          const ui = mapGhCliErrorToUi(setupResult, fallbackMessage, t);

          if (ui.variant) {
            setGhCliHelp(ui);
            setError(null);
            return;
          }

          setGhCliHelp(null);
          setError(ui.message);
        };

        const defaultGhCliErrorMessage =
          result.message || 'Failed to run GitHub CLI setup.';

        const showGhCliSetupDialog = async () => {
          const setupResult = await GhCliSetupDialog.show({
            workspaceId: attempt.id,
          });

          handleGhCliSetupOutcome(setupResult, defaultGhCliErrorMessage);
        };

        if (result.error) {
          if (
            result.error.type === 'cli_not_installed' ||
            result.error.type === 'cli_not_logged_in'
          ) {
            // Only show setup dialog for GitHub CLI on Mac
            if (result.error.provider === 'git_hub' && isMacEnvironment) {
              await showGhCliSetupDialog();
            } else {
              const providerName =
                result.error.provider === 'git_hub'
                  ? 'GitHub'
                  : result.error.provider === 'azure_dev_ops'
                    ? 'Azure DevOps'
                    : 'Git host';
              const action =
                result.error.type === 'cli_not_installed'
                  ? 'not installed'
                  : 'not logged in';
              setError(`${providerName} CLI is ${action}`);
              setGhCliHelp(null);
            }
            return;
          } else if (
            result.error.type === 'git_cli_not_installed' ||
            result.error.type === 'git_cli_not_logged_in'
          ) {
            const gitCliErrorKey =
              result.error.type === 'git_cli_not_logged_in'
                ? 'createPrDialog.errors.gitCliNotLoggedIn'
                : 'createPrDialog.errors.gitCliNotInstalled';

            setError(result.message || t(gitCliErrorKey));
            setGhCliHelp(null);
            return;
          } else if (result.error.type === 'target_branch_not_found') {
            setError(
              t('createPrDialog.errors.targetBranchNotFound', {
                branch: result.error.branch,
              })
            );
            setGhCliHelp(null);
            return;
          }
        }

        if (result.message) {
          setError(result.message);
          setGhCliHelp(null);
        } else {
          setError(t('createPrDialog.errors.failedToCreate'));
          setGhCliHelp(null);
        }
      },
      [attempt.id, isMacEnvironment, modal, t]
    );

    // React to a finished background PR creation. Success is finalized even when
    // the dialog is hidden; errors are surfaced only while visible and otherwise
    // kept in the store for the next open.
    useEffect(() => {
      const cr = bg?.create;
      if (!cr || cr.status === 'running') return;
      const { clearCreate } = usePrBackgroundStore.getState();

      if (cr.status === 'error') {
        if (!modal.visible) return;
        clearCreate(attempt.id);
        setGhCliHelp(null);
        setError(cr.error ?? t('createPrDialog.errors.failedToCreate'));
        return;
      }

      // status === 'done'
      const result = cr.result;
      if (!result) return;

      if (result.success) {
        if (cr.baseBranch) rememberBase(repoId, cr.baseBranch);
        // The PR button / link is driven by the branch-status query. Refresh it
        // now so a PR created in the background is reflected immediately instead
        // of after the next 5s poll.
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', attempt.id],
        });
        clearCreate(attempt.id);
        modal.resolve({ success: true } as CreatePRDialogResult);
        modal.hide();
        return;
      }

      if (!modal.visible) return;
      clearCreate(attempt.id);
      void processCreateFailure(result);
    }, [
      bg?.create,
      modal,
      modal.visible,
      attempt.id,
      repoId,
      processCreateFailure,
      queryClient,
      t,
    ]);

    // Generate a PR title + description by running the configured agent, once,
    // read-only, over the branch diff. Runs in the background store so it keeps
    // going if the dialog is dismissed; the result is applied by the effect
    // above. Local-app only (backend rejects relayed calls).
    const handleGenerate = useCallback(() => {
      if (!repoId || !attempt.id || generating) return;
      setError(null);
      startGenerate(attempt.id, {
        repo_id: repoId,
        target_branch: prBaseBranch || null,
        head_branch: prHeadBranch || null,
      });
    }, [
      attempt.id,
      repoId,
      prBaseBranch,
      prHeadBranch,
      generating,
      startGenerate,
    ]);

    // X button / ESC: keep any running background operation alive and just hide.
    // Resolve without error so the invoking action completes cleanly.
    const handleDismiss = useCallback(() => {
      modal.resolve({ success: false } as CreatePRDialogResult);
      modal.hide();
    }, [modal]);

    // Cancel button: abort any in-flight generation / creation, then close.
    const handleCancelCreatePR = useCallback(() => {
      cancelGenerate(attempt.id);
      cancelCreate(attempt.id);
      const result: CreatePRDialogResult = error
        ? { success: false, error }
        : { success: false };
      modal.resolve(result);
      modal.hide();
    }, [modal, error, attempt.id, cancelGenerate, cancelCreate]);

    return (
      <>
        <Dialog
          open={modal.visible}
          onOpenChange={(open) => {
            if (!open) {
              handleDismiss();
            }
          }}
        >
          <DialogContent className="sm:max-w-[525px]">
            <DialogHeader>
              <DialogTitle>{t('createPrDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('createPrDialog.description')}
              </DialogDescription>
            </DialogHeader>
            {!isLoaded ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4 py-4">
                {aiEnabled && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleGenerate}
                    disabled={generating || creatingPR || isRemote}
                    className="w-full"
                    title={
                      isRemote
                        ? t('createPrDialog.generateUnavailableRemote')
                        : undefined
                    }
                  >
                    {generating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('createPrDialog.generating')}
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        {t('createPrDialog.generateButton')}
                      </>
                    )}
                  </Button>
                )}
                <div className="space-y-2">
                  <Label htmlFor="pr-title">
                    {t('createPrDialog.titleLabel')}
                  </Label>
                  <Input
                    id="pr-title"
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.nativeEvent.isComposing &&
                        prTitle.trim() &&
                        !creatingPR &&
                        !generating
                      ) {
                        e.preventDefault();
                        handleConfirmCreatePR();
                      }
                    }}
                    placeholder={t('createPrDialog.titlePlaceholder')}
                    disabled={generating}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pr-body">
                    {t('createPrDialog.descriptionLabel')}
                  </Label>
                  <Textarea
                    id="pr-body"
                    value={prBody}
                    onChange={(e) => setPrBody(e.target.value)}
                    placeholder={t('createPrDialog.descriptionPlaceholder')}
                    rows={4}
                    disabled={generating}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pr-head">
                    {t('createPrDialog.headBranchLabel')}
                  </Label>
                  <BranchSelector
                    branches={branches}
                    selectedBranch={prHeadBranch}
                    onBranchSelect={setPrHeadBranch}
                    placeholder={
                      branchesLoading
                        ? t('createPrDialog.loadingBranches')
                        : t('createPrDialog.selectHeadBranch')
                    }
                    className={
                      branchesLoading ? 'opacity-50 cursor-not-allowed' : ''
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pr-base">
                    {t('createPrDialog.baseBranchLabel')}
                  </Label>
                  <BranchSelector
                    branches={branches}
                    selectedBranch={prBaseBranch}
                    onBranchSelect={setPrBaseBranch}
                    placeholder={
                      branchesLoading
                        ? t('createPrDialog.loadingBranches')
                        : t('createPrDialog.selectBaseBranch')
                    }
                    className={
                      branchesLoading ? 'opacity-50 cursor-not-allowed' : ''
                    }
                  />
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="pr-draft"
                    checked={isDraft}
                    onCheckedChange={setIsDraft}
                    className="h-5 w-5"
                  />
                  <Label htmlFor="pr-draft" className="cursor-pointer text-sm">
                    {t('createPrDialog.draftLabel')}
                  </Label>
                </div>
                {ghCliHelp?.variant && (
                  <Alert variant="default">
                    <AlertTitle>
                      {getGhCliHelpTitle(ghCliHelp.variant)}
                    </AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{ghCliHelp.message}</p>
                      <GhCliHelpInstructions
                        variant={ghCliHelp.variant}
                        t={t}
                      />
                    </AlertDescription>
                  </Alert>
                )}
                {error && <Alert variant="destructive">{error}</Alert>}
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelCreatePR}
              >
                {t('common:buttons.cancel')}
              </Button>
              <Button
                type="submit"
                onClick={handleConfirmCreatePR}
                disabled={creatingPR || generating || !prTitle.trim()}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {creatingPR ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('createPrDialog.creating')}
                  </>
                ) : (
                  t('createPrDialog.createButton')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
);

export const CreatePRDialog = defineModal<
  CreatePRDialogProps,
  CreatePRDialogResult
>(CreatePRDialogImpl);
