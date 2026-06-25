import { useMemo, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDropzone } from 'react-dropzone';
import { useCreateMode } from '@/features/create-mode/model/useCreateMode';
import {
  toWorkingBranchInput,
  validateBranchName,
} from '@/features/create-mode/model/workingBranch';
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
import { ReviewModeBanner } from './ReviewModeBanner';
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
  const repoSummaryLabel = useMemo(() => {
    if (repos.length === 1) {
      const repo = repos[0];
      if (!repo) return '0 repositories selected';
      const selectedBranch = targetBranches[repo.id];
      const branch = selectedBranch
        ? truncateBranchLabel(selectedBranch)
        : 'Select branch';
      return `${getRepoDisplayName(repo)} · ${branch}`;
    }

    return `${repos.length} repositories selected`;
  }, [repos, targetBranches]);

  const repoSummaryTitle = useMemo(
    () =>
      repos
        .map((repo) => {
          const branch = targetBranches[repo.id] ?? 'Select branch';
          return `${getRepoDisplayName(repo)} (${branch})`;
        })
        .join('\n'),
    [repos, targetBranches]
  );

  const hasSelectedBranchesForAllRepos = repos.every(
    (repo) => !!targetBranches[repo.id]
  );

  // A `new` working branch needs a valid non-empty name; `existing` needs a
  // picked branch; `auto` is always fine.
  const isWorkingBranchValid =
    workingBranch.mode === 'auto' ||
    (workingBranch.name.trim().length > 0 &&
      (workingBranch.mode === 'existing' ||
        validateBranchName(workingBranch.name) === null));

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
      })),
    [repos, targetBranches]
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

  // Resolve the UI selection into the request payload, expanding "auto" into a
  // concrete issue-template name when a linked issue is present.
  const getWorkingBranchPayload = useCallback(
    () =>
      toWorkingBranchInput(
        workingBranch,
        config?.git_branch_name_template ?? '',
        linkedIssue
      ),
    [workingBranch, config?.git_branch_name_template, linkedIssue]
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
  const finishWorkspaceCreated = useCallback(
    async (workspaceId: string) => {
      onWorkspaceCreated(workspaceId);

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
      working_branch: getWorkingBranchPayload(),
    };

    const result = await createWorkspace.mutateAsync({
      data,
      linkToIssue: getLinkToIssue(),
    });

    if (result.workspace) {
      await finishWorkspaceCreated(result.workspace.id);
    }
  }, [
    canSubmit,
    executorConfig,
    message,
    createWorkspace,
    getWorkspaceName,
    getWorkspaceRepos,
    getLinkedIssuePayload,
    getWorkingBranchPayload,
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
      working_branch: getWorkingBranchPayload(),
    };

    const result = await createWorkspaceOnly.mutateAsync({
      data,
      linkToIssue: getLinkToIssue(),
    });

    if (result.workspace) {
      await finishWorkspaceCreated(result.workspace.id);
    }
  }, [
    canCreateOnly,
    createWorkspaceOnly,
    getWorkspaceName,
    getWorkspaceRepos,
    getLinkedIssuePayload,
    getWorkingBranchPayload,
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
      <div className="flex flex-1 items-center justify-center px-base">
        <div className="flex w-chat max-w-full flex-col gap-base">
          {showRepoPickerStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
                {t('createMode.headings.repoStep')}
              </h2>
              <CreateModeRepoPickerBar
                onContinueToPrompt={() => setIsSelectingRepos(false)}
              />
            </>
          )}

          {showChatStep && (
            <>
              <h2 className="mb-double text-center text-4xl font-medium tracking-tight text-high">
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

              <div className="flex justify-center @container">
                <CreateChatBox
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
                      className="min-h-double max-h-[50vh] overflow-y-auto"
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
