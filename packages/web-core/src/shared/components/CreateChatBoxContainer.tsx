import { useMemo, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import { LockIcon } from '@phosphor-icons/react';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import { validateBranchName } from '@/features/create-mode/model/workingBranch';
import { targetBranchModeCreates } from '@/features/create-mode/model/targetBranch';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { useCreateWorkspace } from '@/shared/hooks/useCreateWorkspace';
import { useReviewMode } from '@/shared/hooks/useReviewMode';
import { appendReviewInstruction } from '@/shared/lib/reviewMode';
import { useCreateAttachments } from '@/shared/hooks/useCreateAttachments';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { getSortedExecutorVariantKeys } from '@/shared/lib/executor';
import {
  toPrettyCase,
  splitMessageToTitleDescription,
} from '@/shared/lib/string';
import type { BaseCodingAgent, Repo } from 'shared/types';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { CreateModeRepoPickerBar } from './CreateModeRepoPickerBar';
import type { LockedBranch } from './WorkingBranchRow';
import { ReviewModeBanner } from './ReviewModeBanner';
import { GithubLinkedBranchBanner } from './GithubLinkedBranchBanner';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';

function getRepoDisplayName(repo: Repo) {
  return repo.display_name || repo.name;
}

const BRANCH_LABEL_MAX_CHARS = 15;

function truncateBranchLabel(branch: string) {
  return branch.length > BRANCH_LABEL_MAX_CHARS
    ? `${branch.slice(0, BRANCH_LABEL_MAX_CHARS)}...`
    : branch;
}

interface CreateChatBoxContainerProps {
  onWorkspaceCreated: (workspaceId: string) => void;
}

export function CreateChatBoxContainer({
  onWorkspaceCreated,
}: CreateChatBoxContainerProps) {
  const { t } = useTranslation('common');
  const { profiles, config } = useUserSystem();
  const {
    repos,
    targetBranches,
    targetBranchModes,
    message,
    setMessage,
    clearDraft,
    hasInitialValue,
    hasResolvedInitialRepoDefaults,
    linkedIssue,
    clearLinkedIssue,
    preferredExecutorConfig,
    executorConfig: draftConfig,
    setExecutorConfig: setDraftConfig,
    attachments: draftAttachments,
    setAttachments: setDraftAttachments,
    workingBranch,
  } = useCreateMode();

  const { createWorkspace, createWorkspaceOnly } = useCreateWorkspace();
  const hasSelectedRepos = repos.length > 0;
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [hasInitializedStep, setHasInitializedStep] = useState(false);
  const [isSelectingRepos, setIsSelectingRepos] = useState(true);
  // Whether a GitHub-linked issue's target branch should be its linked branch
  // (default on; only takes effect when `githubLinkedBranchSource` is set).
  const [useGithubLinkedTarget, setUseGithubLinkedTarget] = useState(true);

  useEffect(() => {
    if (!hasInitialValue || hasInitializedStep) return;
    if (!hasSelectedRepos && !hasResolvedInitialRepoDefaults) return;

    setIsSelectingRepos(!hasSelectedRepos);
    setHasInitializedStep(true);
  }, [
    hasInitialValue,
    hasInitializedStep,
    hasSelectedRepos,
    hasResolvedInitialRepoDefaults,
  ]);

  const showRepoPickerStep = !hasSelectedRepos || isSelectingRepos;
  const showChatStep = hasSelectedRepos && !isSelectingRepos;

  // Attachment handling - insert markdown and track attachment IDs
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const newMessage = message.trim()
        ? `${message}\n\n${markdown}`
        : markdown;
      setMessage(newMessage);
    },
    [message, setMessage]
  );

  const { uploadFiles, getAttachmentIds, clearAttachments, localAttachments } =
    useCreateAttachments(
      handleInsertMarkdown,
      draftAttachments,
      setDraftAttachments
    );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled:
      createWorkspace.isPending ||
      createWorkspaceOnly.isPending ||
      !hasSelectedRepos,
    noClick: true,
    noKeyboard: true,
  });

  const scratchConfig = useMemo(() => {
    if (!hasInitialValue) return undefined; // still loading
    return draftConfig ?? null;
  }, [hasInitialValue, draftConfig]);

  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: preferredExecutorConfig,
    scratchConfig,
    configExecutorProfile: config?.executor_profile,
    disabledExecutors: config?.disabled_executors,
    onPersist: (cfg) => setDraftConfig(cfg),
  });

  const repoId = repos.length === 1 ? repos[0]?.id : undefined;
  const reviewMode = useReviewMode(linkedIssue, repoId);
  // A GitHub-issue-linked, single-repo workspace can work on the issue's GitHub
  // linked branch (reused or created at submit). Surfaced as a banner toggle,
  // mutually exclusive with review mode (which checks out an open PR instead).
  const githubLinkedBranchSource =
    linkedIssue?.githubNodeId &&
    linkedIssue?.githubRepository &&
    repos.length === 1
      ? {
          nodeId: linkedIssue.githubNodeId,
          repository: linkedIssue.githubRepository,
        }
      : null;
  // Review mode fixes the working branch to the PR head branch, so surface it
  // read-only in the working-branch selector (warn on change). The GitHub linked
  // branch does NOT touch the working branch — it only redirects the target
  // branch — so it is absent here.
  const lockedWorkingBranch = useMemo<LockedBranch | null>(() => {
    if (reviewMode.prReviewPayload && reviewMode.headBranch) {
      return {
        label: reviewMode.headBranch,
        toggleName: t('createMode.reviewMode.toggleLabel', 'Review mode'),
      };
    }
    return null;
  }, [reviewMode.prReviewPayload, reviewMode.headBranch, t]);

  // A toggle can fix the (single) repo's target branch: the GitHub linked branch
  // (created/reused at submit), or — in review mode, where both branches are the
  // PR — the PR head branch. Reflected read-only in the target selector and the
  // chat footer. Review wins; the two banners are mutually exclusive anyway.
  const lockedTargetBranch = useMemo<LockedBranch | null>(() => {
    if (reviewMode.prReviewPayload && reviewMode.headBranch) {
      return {
        label: reviewMode.headBranch,
        toggleName: t('createMode.reviewMode.toggleLabel', 'Review mode'),
      };
    }
    if (useGithubLinkedTarget && githubLinkedBranchSource) {
      return {
        label: t('createMode.workingBranch.githubLinkedShort'),
        toggleName: t(
          'createMode.githubLinkedBranch.toggleLabel',
          'GitHub linked branch'
        ),
      };
    }
    return null;
  }, [
    reviewMode.prReviewPayload,
    reviewMode.headBranch,
    useGithubLinkedTarget,
    githubLinkedBranchSource,
    t,
  ]);

  // The chat-box footer shows the branch the workspace targets. When a toggle
  // has locked the target branch, reflect that branch (with a lock marker) so
  // the auto-selected branch is visible right in the chat input — not only on
  // the repo-picker step.
  const repoSummaryLabel = useMemo(() => {
    if (repos.length === 1) {
      const repo = repos[0];
      if (!repo) return '0 repositories selected';
      if (lockedTargetBranch) {
        return (
          <span className="inline-flex min-w-0 items-center gap-half">
            <LockIcon className="size-icon-2xs shrink-0" weight="bold" />
            <span className="truncate">
              {`${getRepoDisplayName(repo)} · ${truncateBranchLabel(
                lockedTargetBranch.label
              )}`}
            </span>
          </span>
        );
      }
      const selectedBranch = targetBranches[repo.id];
      const branch = selectedBranch
        ? truncateBranchLabel(selectedBranch)
        : 'Select branch';
      return `${getRepoDisplayName(repo)} · ${branch}`;
    }

    return `${repos.length} repositories selected`;
  }, [repos, targetBranches, lockedTargetBranch]);

  const repoSummaryTitle = useMemo(() => {
    if (repos.length === 1 && lockedTargetBranch) {
      const repo = repos[0];
      if (repo) {
        return `${getRepoDisplayName(repo)} (${lockedTargetBranch.label})`;
      }
    }
    return repos
      .map((repo) => {
        const branch = targetBranches[repo.id] ?? 'Select branch';
        return `${getRepoDisplayName(repo)} (${branch})`;
      })
      .join('\n');
  }, [repos, targetBranches, lockedTargetBranch]);

  // Each repo needs a non-empty target branch; for the create modes
  // ("new"/"auto") the name must also pass branch-name validation.
  const hasSelectedBranchesForAllRepos = repos.every((repo) => {
    const branch = targetBranches[repo.id];
    if (!branch) return false;
    const mode = targetBranchModes[repo.id] ?? 'existing';
    return mode === 'existing' ? true : validateBranchName(branch) === null;
  });

  // `auto` is always fine; `existing` just needs a picked (non-empty) branch;
  // `new` needs a name that passes validation (which also rejects empty).
  const isWorkingBranchValid =
    workingBranch.mode === 'auto'
      ? true
      : workingBranch.mode === 'existing'
        ? workingBranch.name.trim().length > 0
        : validateBranchName(workingBranch.name) === null;

  // Determine if we can submit
  const canSubmit =
    hasSelectedRepos &&
    hasSelectedBranchesForAllRepos &&
    isWorkingBranchValid &&
    message.trim().length > 0 &&
    effectiveExecutor !== null;
  const canCreateOnly =
    hasSelectedRepos && hasSelectedBranchesForAllRepos && isWorkingBranchValid;

  const handlePresetSelect = (presetId: string | null) => {
    if (!effectiveExecutor) return;
    setDraftConfig({
      ...draftConfig,
      executor: effectiveExecutor,
      variant: presetId,
    });
  };

  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Handle executor change - use saved variant if switching to default executor
  const handleExecutorChange = useCallback(
    (executor: BaseCodingAgent) => {
      const executorProfile = profiles?.[executor];
      if (!executorProfile) {
        setDraftConfig({ executor, variant: null });
        return;
      }

      const variants = getSortedExecutorVariantKeys(executorProfile);
      let targetVariant: string | null = null;

      // If switching to user's default executor, use their saved variant
      if (
        config?.executor_profile?.executor === executor &&
        config?.executor_profile?.variant
      ) {
        const savedVariant = config.executor_profile.variant;
        if (variants.includes(savedVariant)) {
          targetVariant = savedVariant;
        }
      }

      // Fallback to DEFAULT or first available
      if (!targetVariant) {
        targetVariant = variants.includes('DEFAULT')
          ? 'DEFAULT'
          : (variants[0] ?? null);
      }

      setDraftConfig({ executor, variant: targetVariant });
    },
    [profiles, setDraftConfig, config?.executor_profile]
  );

  const getWorkspaceName = useCallback(() => {
    const { title } = splitMessageToTitleDescription(message);
    return title.trim().length > 0 ? title : null;
  }, [message]);

  const getWorkspaceRepos = useCallback(
    () =>
      repos.map((r) => ({
        repo_id: r.id,
        target_branch: targetBranches[r.id]!,
        create_target_branch: targetBranchModeCreates(
          targetBranchModes[r.id] ?? 'existing'
        ),
        // When on, the backend swaps this repo's target for the issue's GitHub
        // linked branch (created/reused), forking from the target above. Only
        // set for the matching single repo (source is null otherwise).
        ...(useGithubLinkedTarget && githubLinkedBranchSource
          ? {
              github_linked_branch: {
                issue_node_id: githubLinkedBranchSource.nodeId,
                repository: githubLinkedBranchSource.repository,
              },
            }
          : {}),
      })),
    [
      repos,
      targetBranches,
      targetBranchModes,
      useGithubLinkedTarget,
      githubLinkedBranchSource,
    ]
  );

  const getLinkedIssuePayload = useCallback(
    () =>
      linkedIssue
        ? {
            remote_project_id: linkedIssue.remoteProjectId,
            issue_id: linkedIssue.issueId,
          }
        : null,
    [linkedIssue]
  );

  const getLinkToIssue = useCallback(
    () =>
      linkedIssue
        ? {
            remoteProjectId: linkedIssue.remoteProjectId,
            issueId: linkedIssue.issueId,
          }
        : undefined,
    [linkedIssue]
  );

  // Workspace creation must not mutate the project's saved repo defaults.
  // The picked repos/branches are a per-workspace override; project defaults
  // only change via the project settings dialog.
  //
  // `shouldNavigate` gates the jump into the new workspace: creation runs
  // async, so if the user has navigated away from the create screen while it
  // was in flight, we must NOT yank them into the workspace when it resolves —
  // they asked for it to be created in the background. The draft/attachment
  // cleanup still runs either way so the next create screen starts fresh.
  const finishWorkspaceCreated = useCallback(
    async (workspaceId: string, shouldNavigate: boolean) => {
      if (shouldNavigate) {
        onWorkspaceCreated(workspaceId);
      }

      clearAttachments();
      await clearDraft();
    },
    [onWorkspaceCreated, clearAttachments, clearDraft]
  );

  // Handle submit
  const handleSubmit = useCallback(async () => {
    setHasAttemptedSubmit(true);
    if (!canSubmit || !executorConfig) return;

    const workspaceRepos = getWorkspaceRepos();
    const data = {
      executor_config: executorConfig,
      name: getWorkspaceName(),
      // In review mode, append "Review the checked-out PR." below the user's prompt
      // so the agent reviews the resolved PR. Gated on the same payload that
      // sends `pr_review`, so it is omitted when no PR is being reviewed.
      prompt: reviewMode.prReviewPayload
        ? appendReviewInstruction(message)
        : message,
      repos: workspaceRepos,
      linked_issue: getLinkedIssuePayload(),
      attachment_ids: getAttachmentIds(),
      // Review mode: work on the issue's open PR head branch instead of a new
      // `vk/` branch, and auto-link the PR. Null for normal workspace creation.
      pr_review: reviewMode.prReviewPayload,
      working_branch: workingBranch,
    };

    // Snapshot the route before the async create; if the user leaves the
    // create screen while it runs, we skip the post-create navigation.
    const startPathname = window.location.pathname;
    const result = await createWorkspace.mutateAsync({
      data,
      linkToIssue: getLinkToIssue(),
    });

    if (result.workspace) {
      await finishWorkspaceCreated(
        result.workspace.id,
        window.location.pathname === startPathname
      );
    }
  }, [
    canSubmit,
    executorConfig,
    message,
    createWorkspace,
    getWorkspaceName,
    getWorkspaceRepos,
    getLinkedIssuePayload,
    getAttachmentIds,
    getLinkToIssue,
    finishWorkspaceCreated,
    reviewMode.prReviewPayload,
  ]);

  const handleCreateOnly = useCallback(async () => {
    setHasAttemptedSubmit(true);
    if (!canCreateOnly) return;

    const workspaceRepos = getWorkspaceRepos();
    const data = {
      name: getWorkspaceName(),
      repos: workspaceRepos,
      linked_issue: getLinkedIssuePayload(),
      attachment_ids: getAttachmentIds(),
      working_branch: workingBranch,
    };

    // Snapshot the route before the async create; if the user leaves the
    // create screen while it runs, we skip the post-create navigation.
    const startPathname = window.location.pathname;
    const result = await createWorkspaceOnly.mutateAsync({
      data,
      linkToIssue: getLinkToIssue(),
    });

    if (result.workspace) {
      await finishWorkspaceCreated(
        result.workspace.id,
        window.location.pathname === startPathname
      );
    }
  }, [
    canCreateOnly,
    createWorkspaceOnly,
    getWorkspaceName,
    getWorkspaceRepos,
    getLinkedIssuePayload,
    getAttachmentIds,
    getLinkToIssue,
    finishWorkspaceCreated,
  ]);

  const creationError = createWorkspace.error ?? createWorkspaceOnly.error;

  // Determine error to display
  const displayError =
    hasAttemptedSubmit && repos.length === 0
      ? 'Add at least one repository to create a workspace'
      : hasAttemptedSubmit && !hasSelectedBranchesForAllRepos
        ? 'Select a branch for every repository before creating a workspace'
        : creationError
          ? creationError instanceof Error
            ? creationError.message
            : 'Failed to create workspace'
          : null;

  // Wait for initial value to be applied before rendering
  // This ensures the editor mounts with content ready, so autoFocus works correctly
  if (!hasInitialValue) {
    return null;
  }

  return (
    <div className="relative flex flex-1 flex-col bg-primary h-full">
      {/* `max-h-full` caps the box to the viewport; the chat box then flexes
          (see `fillHeight`) so the prompt editor shrinks to fit instead of
          pushing the create button off-screen on short mobile heights / when
          the on-screen keyboard is open. `my-auto` keeps it centered when it
          fits; `overflow-y-auto` is a last-resort fallback for viewports too
          short even for the shrunk editor. */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-base py-base">
        <div className="flex w-chat max-w-full min-h-0 max-h-full flex-col gap-base my-auto">
          {showRepoPickerStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.repoStep')}
              </h2>
              <CreateModeRepoPickerBar
                onContinueToPrompt={() => setIsSelectingRepos(false)}
                lockedWorkingBranch={lockedWorkingBranch}
                lockedTargetBranch={lockedTargetBranch}
              />
            </>
          )}

          {showChatStep && (
            <>
              <h2 className="mb-double shrink-0 text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.chatStep')}
              </h2>

              {reviewMode.reviewTagPresent && (
                <ReviewModeBanner
                  resolved={reviewMode.resolved}
                  isResolving={reviewMode.isResolving}
                  headBranch={reviewMode.headBranch}
                  prNumber={reviewMode.prNumber}
                  enabled={reviewMode.enabled}
                  onEnabledChange={reviewMode.setEnabled}
                />
              )}

              {!reviewMode.reviewTagPresent && githubLinkedBranchSource && (
                <GithubLinkedBranchBanner
                  repository={githubLinkedBranchSource.repository}
                  enabled={useGithubLinkedTarget}
                  onEnabledChange={setUseGithubLinkedTarget}
                />
              )}

              <div className="flex min-h-0 flex-1 justify-center @container">
                <CreateChatBox
                  fillHeight
                  editor={{
                    value: message,
                    onChange: setMessage,
                  }}
                  renderEditor={({
                    value,
                    onChange,
                    onCmdEnter,
                    disabled,
                    repoIds,
                    repoId,
                    executor,
                    onPasteFiles,
                    localAttachments,
                  }) => (
                    <WYSIWYGEditor
                      placeholder="Describe the task..."
                      value={value}
                      onChange={onChange}
                      onCmdEnter={onCmdEnter}
                      disabled={disabled}
                      fillHeight
                      className="min-h-0 flex-1 max-h-[50vh] overflow-y-auto"
                      repoIds={repoIds}
                      repoId={repoId}
                      executor={executor}
                      autoFocus
                      onPasteFiles={onPasteFiles}
                      localAttachments={localAttachments}
                      sendShortcut={config?.send_message_shortcut}
                    />
                  )}
                  agentIcon={
                    <AgentIcon
                      agent={effectiveExecutor}
                      className="size-icon-xl"
                    />
                  }
                  onSend={handleSubmit}
                  isSending={createWorkspace.isPending}
                  secondaryAction={{
                    value: t('createMode.workspaceOnly.create'),
                    pendingValue: t('createMode.workspaceOnly.creating'),
                    onClick: handleCreateOnly,
                    disabled: !canCreateOnly,
                    isPending: createWorkspaceOnly.isPending,
                  }}
                  disabled={!hasSelectedRepos}
                  executor={{
                    selected: effectiveExecutor,
                    options: executorOptions,
                    onChange: handleExecutorChange,
                  }}
                  formatExecutorLabel={toPrettyCase}
                  error={displayError}
                  repoIds={repos.map((r) => r.id)}
                  repoId={repoId}
                  modelSelector={
                    effectiveExecutor ? (
                      <ModelSelectorContainer
                        agent={effectiveExecutor}
                        workspaceId={undefined}
                        onAdvancedSettings={handleCustomise}
                        presets={variantOptions}
                        selectedPreset={selectedVariant}
                        onPresetSelect={handlePresetSelect}
                        onOverrideChange={setExecutorOverrides}
                        executorConfig={executorConfig}
                        presetOptions={presetOptions}
                      />
                    ) : undefined
                  }
                  onPasteFiles={uploadFiles}
                  localAttachments={localAttachments}
                  dropzone={{ getRootProps, getInputProps, isDragActive }}
                  onEditRepos={() => setIsSelectingRepos(true)}
                  repoSummaryLabel={repoSummaryLabel}
                  repoSummaryTitle={repoSummaryTitle}
                  linkedIssue={
                    linkedIssue?.simpleId
                      ? {
                          simpleId: linkedIssue.simpleId,
                          title: linkedIssue.title ?? '',
                          onRemove: clearLinkedIssue,
                        }
                      : null
                  }
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
