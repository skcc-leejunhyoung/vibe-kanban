import {
  useState,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useMemo,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';
import type { JsonValue, OrganizationMemberWithProfile } from 'shared/types';
import type { IssuePriority } from 'shared/remote-types';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useOrgContext } from '@/shared/hooks/useOrgContext';
import { useProjectWorkspaceCreateDraft } from '@/shared/hooks/useProjectWorkspaceCreateDraft';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { SearchableTagDropdownContainer } from '@/shared/components/SearchableTagDropdownContainer';
import { IssueCommentsSectionContainer } from './IssueCommentsSectionContainer';
import { IssueSubIssuesSectionContainer } from './IssueSubIssuesSectionContainer';
import { IssueRelationshipsSectionContainer } from './IssueRelationshipsSectionContainer';
import { IssueWorkspacesSectionContainer } from './IssueWorkspacesSectionContainer';
import { IssueIntakeSection } from './IssueIntakeSection';
import {
  KanbanIssuePanel,
  type IssueFormData,
} from '@vibe/ui/components/KanbanIssuePanel';
import { useActions } from '@/shared/hooks/useActions';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { getWorkspaceDefaults } from '@/shared/lib/workspaceDefaults';
import {
  buildLinkedIssueCreateState,
  buildWorkspaceCreateInitialState,
  buildWorkspaceCreatePrompt,
} from '@/shared/lib/workspaceCreateState';
import { selectWorkspaceHost } from '@/shared/dialogs/command-bar/WorkspaceHostSelectionDialog';
import {
  createBlankCreateFormData,
  createInitialKanbanIssuePanelFormState,
  kanbanIssuePanelFormReducer,
  selectDisplayData,
} from './kanban-issue-panel-state';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { useAzureAttachments } from '@/shared/hooks/useAzureAttachments';
import {
  commitIssueAttachments,
  deleteAttachment,
} from '@/shared/lib/remoteApi';
import {
  extractAttachmentIds,
  removeAttachmentMarkdownBySource,
  replaceAttachmentSource,
} from '@/shared/lib/attachmentUtils';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { openInSplitPane } from '@/shared/lib/openInSplitPane';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  patchKanbanIssueComposer,
  useKanbanIssueComposer,
  useKanbanIssueComposerStore,
} from '@/shared/stores/useKanbanIssueComposerStore';
import { resolveGithubIssueAutomationHostId } from '@/shared/lib/githubIssueAutomationHost';

interface KanbanIssuePanelContainerProps {
  issueResolution: 'resolving' | 'ready' | 'missing' | null;
  onExpectIssueOpen: (issueId: string) => void;
}

/**
 * KanbanIssuePanelContainer manages the issue detail/create panel.
 * Uses ProjectContext and OrgContext for data and mutations.
 * Must be rendered within both OrgProvider and ProjectProvider.
 */
export function KanbanIssuePanelContainer({
  issueResolution,
  onExpectIssueOpen,
}: KanbanIssuePanelContainerProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const routeState = useCurrentKanbanRouteState();
  const runtime = useAppRuntime();
  const { hosts: availableWorkspaceHosts } = useWorkspaceHostOptions();

  const workspaceHosts = useMemo(
    () => [
      ...(runtime === 'local'
        ? [{ id: null, name: t('kanban.thisMachine') }]
        : []),
      ...availableWorkspaceHosts
        .filter((host) => host.status === 'online')
        .map((host) => ({ id: host.id, name: host.name })),
    ],
    [availableWorkspaceHosts, runtime, t]
  );
  const defaultWorkspaceHostId = useMemo(() => {
    if (
      routeState.hostId &&
      workspaceHosts.some((host) => host.id === routeState.hostId)
    ) {
      return routeState.hostId;
    }
    return workspaceHosts[0]?.id ?? null;
  }, [routeState.hostId, workspaceHosts]);
  const githubIssueAutomationHostId = useMemo(
    () =>
      resolveGithubIssueAutomationHostId(
        runtime,
        routeState.hostId,
        availableWorkspaceHosts
      ),
    [availableWorkspaceHosts, routeState.hostId, runtime]
  );

  const { openWorkspaceCreateFromState } = useProjectWorkspaceCreateDraft();
  const { workspaces } = useUserContext();
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();

  // Build set of local workspace IDs that exist on this machine
  const localWorkspaceIds = useMemo(
    () =>
      new Set([
        ...activeWorkspaces.map((w) => w.id),
        ...archivedWorkspaces.map((w) => w.id),
      ]),
    [activeWorkspaces, archivedWorkspaces]
  );

  // Get data from contexts
  const {
    projectId,
    issues,
    statuses,
    tags,
    issueAssignees,
    issueTags,
    insertIssue,
    updateIssue,
    insertIssueAssignee,
    insertIssueTag,
    removeIssueTag,
    insertTag,
    getTagsForIssue,
    getPullRequestsForIssue,
    pullRequestIssues,
    removePullRequestIssue,
    githubIssueLinks,
    removeGithubIssueLink,
    isLoading: projectLoading,
  } = useProjectContext();
  const selectedKanbanIssueId = routeState.issueId;
  const issueComposerKey = useMemo(
    () => buildKanbanIssueComposerKey(routeState.hostId, projectId),
    [routeState.hostId, projectId]
  );
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const kanbanCreateMode = issueComposer !== null;
  const createComposerInitial = issueComposer?.initial ?? null;
  const kanbanCreateDefaultStatusId = createComposerInitial?.statusId ?? null;
  const kanbanCreateDefaultPriority = createComposerInitial?.priority ?? null;
  const kanbanCreateDefaultAssigneeIds =
    createComposerInitial?.assigneeIds ?? null;
  const kanbanCreateDefaultParentIssueId =
    createComposerInitial?.parentIssueId ?? null;
  const createDraftWorkspaceByDefault = useUiPreferencesStore(
    (state) => state.createDraftWorkspaceByDefault
  );
  const setCreateDraftWorkspaceByDefault = useUiPreferencesStore(
    (state) => state.setCreateDraftWorkspaceByDefault
  );
  const openIssue = useCallback(
    (issueId: string) => {
      if (kanbanCreateMode && issueComposerKey) {
        closeKanbanIssueComposer(issueComposerKey);
      }
      appNavigation.goToProjectIssue(projectId, issueId);
    },
    [kanbanCreateMode, issueComposerKey, appNavigation, projectId]
  );
  const closeKanbanIssuePanel = useCallback(() => {
    if (kanbanCreateMode && issueComposerKey) {
      closeKanbanIssueComposer(issueComposerKey);
    }
    appNavigation.goToProject(projectId);
  }, [kanbanCreateMode, issueComposerKey, appNavigation, projectId]);
  const updateIssueComposerDraft = useCallback(
    (patch: {
      statusId?: string;
      priority?: IssuePriority | null;
      assigneeIds?: string[];
      parentIssueId?: string;
      title?: string;
      description?: string | null;
      tagIds?: string[];
      createDraftWorkspace?: boolean;
      workspaceHostId?: string | null;
    }) => {
      if (!kanbanCreateMode || !issueComposerKey) {
        return;
      }

      patchKanbanIssueComposer(issueComposerKey, patch);
    },
    [kanbanCreateMode, issueComposerKey]
  );
  const { isLoading: orgLoading, membersWithProfilesById } = useOrgContext();

  // Get action methods from actions context
  const { openStatusSelection, openPrioritySelection, openAssigneeSelection } =
    useActions();

  // Find selected issue if in edit mode
  const selectedIssue = useMemo(() => {
    if (kanbanCreateMode || !selectedKanbanIssueId) return null;
    return issues.find((i) => i.id === selectedKanbanIssueId) ?? null;
  }, [issues, selectedKanbanIssueId, kanbanCreateMode]);

  const creatorUserId = selectedIssue?.creator_user_id ?? null;
  const issueCreator = useMemo(() => {
    if (!creatorUserId) return null;
    return membersWithProfilesById.get(creatorUserId) ?? null;
  }, [membersWithProfilesById, creatorUserId]);

  // Find parent issue if current issue has one
  const parentIssue = useMemo(() => {
    if (!selectedIssue?.parent_issue_id) return null;
    const parent = issues.find((i) => i.id === selectedIssue.parent_issue_id);
    if (!parent) return null;
    return { id: parent.id, simpleId: parent.simple_id };
  }, [issues, selectedIssue]);

  // Handler for clicking on parent issue - navigate to that issue
  const handleParentIssueClick = useCallback(() => {
    if (parentIssue) {
      openIssue(parentIssue.id);
    }
  }, [parentIssue, openIssue]);

  const handleRemoveParentIssue = useCallback(() => {
    if (!selectedKanbanIssueId || !selectedIssue?.parent_issue_id) return;
    updateIssue(selectedKanbanIssueId, {
      parent_issue_id: null,
      parent_issue_sort_order: null,
    });
  }, [selectedKanbanIssueId, selectedIssue?.parent_issue_id, updateIssue]);

  // Get all current assignees from issue_assignees
  const currentAssigneeIds = useMemo(() => {
    if (!selectedKanbanIssueId) return [];
    return issueAssignees
      .filter((a) => a.issue_id === selectedKanbanIssueId)
      .map((a) => a.user_id);
  }, [issueAssignees, selectedKanbanIssueId]);

  // Get current tag IDs from issue_tags junction table
  const currentTagIds = useMemo(() => {
    if (!selectedKanbanIssueId) return [];
    const tagLinks = getTagsForIssue(selectedKanbanIssueId);
    return tagLinks.map((it) => it.tag_id);
  }, [getTagsForIssue, selectedKanbanIssueId]);

  // Get linked PRs for the issue
  const linkedPrs = useMemo(() => {
    if (!selectedKanbanIssueId) return [];
    return getPullRequestsForIssue(selectedKanbanIssueId).map((pr) => ({
      id: pr.id,
      number: pr.number,
      url: pr.url,
      status: pr.status,
    }));
  }, [getPullRequestsForIssue, selectedKanbanIssueId]);

  const linkedGithubIssues = useMemo(() => {
    if (!selectedKanbanIssueId) return [];
    return githubIssueLinks
      .filter((link) => link.issue_id === selectedKanbanIssueId)
      .map((link) => ({
        id: link.id,
        number: link.number,
        repository: link.repository,
        url: link.url,
        state: link.github_state,
      }));
  }, [githubIssueLinks, selectedKanbanIssueId]);

  // Determine mode from composer state (create) or issue route (edit).
  const mode = kanbanCreateMode ? 'create' : 'edit';

  // Sort statuses by sort_order
  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order),
    [statuses]
  );

  // Default status: use kanbanCreateDefaultStatusId if set, otherwise first by sort order
  const defaultStatusId =
    kanbanCreateDefaultStatusId ?? sortedStatuses[0]?.id ?? '';

  // Default create form values for the current create-default state + project context
  const createModeDefaults = useMemo<IssueFormData>(
    () => ({
      title: '',
      description: null,
      statusId: defaultStatusId,
      priority: kanbanCreateDefaultPriority ?? null,
      assigneeIds: [...(kanbanCreateDefaultAssigneeIds ?? [])],
      tagIds: [],
      createDraftWorkspace: createDraftWorkspaceByDefault,
      workspaceHostId: defaultWorkspaceHostId,
    }),
    [
      defaultStatusId,
      kanbanCreateDefaultPriority,
      kanbanCreateDefaultAssigneeIds,
      createDraftWorkspaceByDefault,
      defaultWorkspaceHostId,
    ]
  );

  // Track previous issue ID to detect actual issue switches (not just data updates)
  const prevIssueIdRef = useRef<string | null>(null);
  const prevHasPendingAttachmentsRef = useRef(false);
  const hasPendingAttachmentsRef = useRef(false);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);

  const [formState, dispatchFormState] = useReducer(
    kanbanIssuePanelFormReducer,
    undefined,
    createInitialKanbanIssuePanelFormState
  );
  const createFormData = formState.createFormData;

  useEffect(() => {
    if (mode !== 'create') return;

    const titleInput = titleInputRef.current;
    if (!titleInput || document.activeElement === titleInput) return;

    const frameId = requestAnimationFrame(() => {
      const node = titleInputRef.current;
      if (!node || document.activeElement === node) return;

      node.focus();
      const caretIndex = node.value.length;
      node.setSelectionRange(caretIndex, caretIndex);
    });

    return () => cancelAnimationFrame(frameId);
  }, [mode, selectedKanbanIssueId, createFormData?.title]);

  // Display ID: use real simple_id in edit mode, placeholder for create mode
  const displayId = useMemo(() => {
    if (mode === 'edit' && selectedIssue) {
      return selectedIssue.simple_id;
    }
    return t('kanban.newIssue');
  }, [mode, selectedIssue, t]);

  // Compute display values based on mode
  // - Create mode: createFormData is the single source of truth.
  // - Edit mode: text fields come from explicit local edit state, dropdown fields from server.
  const displayData = useMemo((): IssueFormData => {
    return selectDisplayData({
      state: formState,
      mode,
      createModeDefaults,
      selectedIssue,
      currentAssigneeIds,
      currentTagIds,
    });
  }, [
    formState,
    mode,
    createModeDefaults,
    selectedIssue,
    currentAssigneeIds,
    currentTagIds,
  ]);
  const latestDescriptionRef = useRef<string | null>(
    displayData.description ?? null
  );
  latestDescriptionRef.current = displayData.description ?? null;

  // Provenance from a "Generate spec" run, stashed until the card is created.
  // Keyed by composer key so switching/closing the composer resets it.
  const intakeMetadataRef = useRef<JsonValue>(null);
  useEffect(() => {
    intakeMetadataRef.current = null;
  }, [issueComposerKey]);

  // Resolve assignee IDs to full profiles for avatar display
  const displayAssigneeUsers = useMemo(() => {
    return displayData.assigneeIds
      .map((id) => membersWithProfilesById.get(id))
      .filter((m): m is OrganizationMemberWithProfile => m != null);
  }, [displayData.assigneeIds, membersWithProfilesById]);

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Save status for description (shown in WYSIWYG toolbar)
  const [descriptionSaveStatus, setDescriptionSaveStatus] = useState<
    'idle' | 'saved'
  >('idle');

  // Debounced save for title changes
  const { debounced: debouncedSaveTitle, cancel: cancelDebouncedTitle } =
    useDebouncedCallback((title: string) => {
      if (selectedKanbanIssueId && !kanbanCreateMode) {
        updateIssue(selectedKanbanIssueId, { title });
      }
    }, 500);

  // Debounced save for description changes
  const {
    debounced: debouncedSaveDescription,
    cancel: cancelDebouncedDescription,
  } = useDebouncedCallback((description: string | null) => {
    if (selectedKanbanIssueId && !kanbanCreateMode) {
      updateIssue(selectedKanbanIssueId, { description });
      setDescriptionSaveStatus('saved');
      setTimeout(() => setDescriptionSaveStatus('idle'), 1500);
    }
  }, 500);

  // Reset save status only when switching to a different issue or mode
  useEffect(() => {
    setDescriptionSaveStatus('idle');
  }, [selectedKanbanIssueId, kanbanCreateMode]);

  const createFormFallback = useMemo(
    () =>
      createBlankCreateFormData(defaultStatusId, createDraftWorkspaceByDefault),
    [defaultStatusId, createDraftWorkspaceByDefault]
  );

  // --- Image attachment upload integration ---

  // Callback to insert markdown into the description field
  const handleDescriptionInsert = useCallback(
    (markdown: string, options?: { persist?: boolean }) => {
      const currentDesc = latestDescriptionRef.current ?? '';
      const separator = currentDesc.length > 0 ? '\n' : '';
      const newDesc = currentDesc + separator + markdown;
      latestDescriptionRef.current = newDesc;

      if (kanbanCreateMode || !selectedKanbanIssueId) {
        // Create mode: update form data
        dispatchFormState({
          type: 'patchCreateFormData',
          patch: { description: newDesc },
          fallback: createFormFallback,
        });
      } else {
        // Edit mode: update local state + debounced save
        dispatchFormState({
          type: 'setEditDescription',
          description: newDesc,
        });
        if (options?.persist !== false && !hasPendingAttachmentsRef.current) {
          debouncedSaveDescription(newDesc);
        }
      }
    },
    [
      kanbanCreateMode,
      selectedKanbanIssueId,
      createFormFallback,
      debouncedSaveDescription,
    ]
  );

  const handleDescriptionSourceReplace = useCallback(
    (previousSrc: string, nextSrc: string, options?: { persist?: boolean }) => {
      const currentDesc = latestDescriptionRef.current ?? '';
      const { content: nextDesc, replaced } = replaceAttachmentSource(
        currentDesc,
        previousSrc,
        nextSrc
      );

      if (!replaced) {
        return false;
      }
      latestDescriptionRef.current = nextDesc;

      if (kanbanCreateMode || !selectedKanbanIssueId) {
        dispatchFormState({
          type: 'patchCreateFormData',
          patch: { description: nextDesc },
          fallback: createFormFallback,
        });
      } else {
        dispatchFormState({
          type: 'setEditDescription',
          description: nextDesc,
        });
        if (options?.persist !== false && !hasPendingAttachmentsRef.current) {
          debouncedSaveDescription(nextDesc);
        }
      }

      return true;
    },
    [
      kanbanCreateMode,
      selectedKanbanIssueId,
      createFormFallback,
      debouncedSaveDescription,
    ]
  );

  const handleDescriptionSourceRemove = useCallback(
    (src: string, options?: { persist?: boolean }) => {
      const currentDesc = latestDescriptionRef.current ?? '';
      const { content: nextDesc, removed } = removeAttachmentMarkdownBySource(
        currentDesc,
        src
      );

      if (!removed) {
        return false;
      }
      latestDescriptionRef.current = nextDesc || null;

      if (kanbanCreateMode || !selectedKanbanIssueId) {
        dispatchFormState({
          type: 'patchCreateFormData',
          patch: { description: nextDesc || null },
          fallback: createFormFallback,
        });
      } else {
        dispatchFormState({
          type: 'setEditDescription',
          description: nextDesc || null,
        });
        if (options?.persist !== false && !hasPendingAttachmentsRef.current) {
          debouncedSaveDescription(nextDesc || null);
        }
      }

      return true;
    },
    [
      kanbanCreateMode,
      selectedKanbanIssueId,
      createFormFallback,
      debouncedSaveDescription,
    ]
  );

  // Azure attachment upload hook
  const {
    uploadFiles,
    getAttachmentIds,
    clearAttachments,
    isUploading,
    hasPendingAttachments,
    uploadError,
    clearUploadError,
    localAttachments,
  } = useAzureAttachments({
    projectId,
    issueId: kanbanCreateMode
      ? undefined
      : (selectedKanbanIssueId ?? undefined),
    onMarkdownInsert: handleDescriptionInsert,
    onAttachmentSourceReplace: handleDescriptionSourceReplace,
    onAttachmentSourceRemove: handleDescriptionSourceRemove,
    onError: (msg) => console.error('[attachment]', msg),
  });
  hasPendingAttachmentsRef.current = hasPendingAttachments;

  // Dropzone for drag-drop image upload on description area
  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
    onDrop: (acceptedFiles) => {
      if (acceptedFiles.length > 0) uploadFiles(acceptedFiles);
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
  });

  // Paste handler for images
  const onPasteFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0) uploadFiles(files);
    },
    [uploadFiles]
  );

  // Reset local state when switching issues or modes.
  useEffect(() => {
    const currentIssueId = selectedKanbanIssueId;
    const isNewIssue = currentIssueId !== prevIssueIdRef.current;
    const shouldSeedCreateForm = mode === 'create' && createFormData === null;

    if (!isNewIssue && !shouldSeedCreateForm) {
      // Same issue - no reset needed
      // (dropdown fields derive from server state, text fields preserve local edits)
      return;
    }

    // Track the new issue ID
    prevIssueIdRef.current = currentIssueId;

    // Cancel any pending debounced saves when switching issues
    cancelDebouncedTitle();
    cancelDebouncedDescription();

    let nextCreateFormData: IssueFormData | null = null;
    let restoredFromScratch = false;

    if (mode === 'create') {
      // Check if the composer store has a saved draft (e.g., restored from
      // localStorage on remote-web). Use it to seed the form instead of defaults.
      const composerDraft =
        useKanbanIssueComposerStore.getState().byKey[issueComposerKey]?.draft;
      const hasSavedDraft =
        composerDraft != null &&
        (composerDraft.title !== '' || composerDraft.description != null);

      if (hasSavedDraft) {
        nextCreateFormData = {
          title: composerDraft.title,
          description: composerDraft.description ?? null,
          statusId: composerDraft.statusId ?? createModeDefaults.statusId,
          priority:
            composerDraft.priority === undefined
              ? createModeDefaults.priority
              : composerDraft.priority,
          assigneeIds:
            composerDraft.assigneeIds ?? createModeDefaults.assigneeIds,
          tagIds: composerDraft.tagIds ?? createModeDefaults.tagIds,
          createDraftWorkspace:
            composerDraft.createDraftWorkspace ??
            createModeDefaults.createDraftWorkspace,
          workspaceHostId:
            composerDraft.workspaceHostId === undefined
              ? createModeDefaults.workspaceHostId
              : composerDraft.workspaceHostId,
        };
        restoredFromScratch = true;
      } else {
        nextCreateFormData = createModeDefaults;
      }
    }

    dispatchFormState({
      type: 'resetForIssueChange',
      mode,
      createFormData: nextCreateFormData,
      hasRestoredFromScratch: restoredFromScratch,
    });
  }, [
    mode,
    createFormData,
    selectedKanbanIssueId,
    cancelDebouncedTitle,
    cancelDebouncedDescription,
    createModeDefaults,
    issueComposerKey,
  ]);

  useEffect(() => {
    const wasPending = prevHasPendingAttachmentsRef.current;
    prevHasPendingAttachmentsRef.current = hasPendingAttachments;

    if (kanbanCreateMode || !selectedKanbanIssueId) {
      return;
    }

    if (!wasPending || hasPendingAttachments) {
      return;
    }

    const currentDescription = displayData.description ?? null;
    const persistedDescription = selectedIssue?.description ?? null;

    if (currentDescription === persistedDescription) {
      return;
    }

    debouncedSaveDescription(currentDescription);
  }, [
    kanbanCreateMode,
    selectedKanbanIssueId,
    hasPendingAttachments,
    displayData.description,
    selectedIssue?.description,
    debouncedSaveDescription,
  ]);

  // Form change handler - persists changes immediately in edit mode
  const handlePropertyChange = useCallback(
    async <K extends keyof IssueFormData>(
      field: K,
      value: IssueFormData[K]
    ) => {
      // Create mode: update in-panel form state and composer draft.
      if (kanbanCreateMode) {
        // For statusId, open the status selection dialog with callback
        if (field === 'statusId') {
          const { ProjectSelectionDialog } = await import(
            '@/shared/dialogs/command-bar/selections/ProjectSelectionDialog'
          );
          const result = await ProjectSelectionDialog.show({
            projectId,
            selection: { type: 'status', issueIds: [], isCreateMode: true },
          });
          if (result && typeof result === 'object' && 'statusId' in result) {
            const statusId = result.statusId as string;
            updateIssueComposerDraft({ statusId });
            dispatchFormState({
              type: 'patchCreateFormData',
              patch: { statusId },
              fallback: createFormFallback,
            });
          }
          return;
        }

        // For priority, open the priority selection dialog with callback
        if (field === 'priority') {
          const { ProjectSelectionDialog } = await import(
            '@/shared/dialogs/command-bar/selections/ProjectSelectionDialog'
          );
          const result = await ProjectSelectionDialog.show({
            projectId,
            selection: { type: 'priority', issueIds: [], isCreateMode: true },
          });
          if (result && typeof result === 'object' && 'priority' in result) {
            const priority = (result as { priority: IssuePriority | null })
              .priority;
            updateIssueComposerDraft({ priority });
            dispatchFormState({
              type: 'patchCreateFormData',
              patch: { priority },
              fallback: createFormFallback,
            });
          }
          return;
        }

        // For assigneeIds, open the assignee selection dialog with callback
        if (field === 'assigneeIds') {
          const { AssigneeSelectionDialog } = await import(
            '@/shared/dialogs/kanban/AssigneeSelectionDialog'
          );
          await AssigneeSelectionDialog.show({
            projectId,
            issueIds: [],
            isCreateMode: true,
            createModeAssigneeIds: createFormData?.assigneeIds ?? [],
            onCreateModeAssigneesChange: (assigneeIds: string[]) => {
              updateIssueComposerDraft({ assigneeIds });
              dispatchFormState({
                type: 'setCreateAssigneeIds',
                assigneeIds,
              });
            },
          });
          return;
        }

        // For other fields, just update the form data
        dispatchFormState({
          type: 'patchCreateFormData',
          patch: { [field]: value } as Partial<IssueFormData>,
          fallback: createFormFallback,
        });
        updateIssueComposerDraft({ [field]: value } as Partial<IssueFormData>);
        if (field === 'createDraftWorkspace') {
          setCreateDraftWorkspaceByDefault(value as boolean);
        }
        return;
      }

      if (!selectedKanbanIssueId) {
        return;
      }

      // Edit mode: handle text fields vs dropdown fields differently
      if (field === 'title') {
        // Text field: update local state, then debounced save
        dispatchFormState({
          type: 'setEditTitle',
          title: value as string,
        });
        debouncedSaveTitle(value as string);
      } else if (field === 'description') {
        // Text field: update local state, then debounced save
        dispatchFormState({
          type: 'setEditDescription',
          description: value as string | null,
        });
        if (!hasPendingAttachments) {
          debouncedSaveDescription(value as string | null);
        }
      } else if (field === 'statusId') {
        // Status changes go through the command bar status selection
        openStatusSelection(projectId, [selectedKanbanIssueId]);
      } else if (field === 'priority') {
        // Priority changes go through the command bar priority selection
        openPrioritySelection(projectId, [selectedKanbanIssueId]);
      } else if (field === 'assigneeIds') {
        // Assignee changes go through the assignee selection dialog
        openAssigneeSelection(projectId, [selectedKanbanIssueId], false);
      } else if (field === 'tagIds') {
        // Handle tag changes via junction table
        const newTagIds = value as string[];
        const currentIssueTags = issueTags.filter(
          (it) => it.issue_id === selectedKanbanIssueId
        );
        const currentTagIdSet = new Set(
          currentIssueTags.map((it) => it.tag_id)
        );
        const newTagIdSet = new Set(newTagIds);

        // Remove tags that are no longer selected
        for (const issueTag of currentIssueTags) {
          if (!newTagIdSet.has(issueTag.tag_id)) {
            removeIssueTag(issueTag.id);
          }
        }

        // Add newly selected tags
        for (const tagId of newTagIds) {
          if (!currentTagIdSet.has(tagId)) {
            insertIssueTag({
              issue_id: selectedKanbanIssueId,
              tag_id: tagId,
            });
          }
        }
      }
    },
    [
      kanbanCreateMode,
      selectedKanbanIssueId,
      projectId,
      createFormFallback,
      createFormData,
      hasPendingAttachments,
      debouncedSaveTitle,
      debouncedSaveDescription,
      openStatusSelection,
      openPrioritySelection,
      openAssigneeSelection,
      updateIssueComposerDraft,
      setCreateDraftWorkspaceByDefault,
      issueTags,
      insertIssueTag,
      removeIssueTag,
    ]
  );

  // Fill the title/description from a generated spec and stash its provenance
  // so it lands in the issue's extension_metadata when the card is created.
  const handleSpecGenerated = useCallback(
    (title: string, description: string, intakeMetadata: JsonValue) => {
      intakeMetadataRef.current = intakeMetadata;
      latestDescriptionRef.current = description;
      void handlePropertyChange('title', title);
      void handlePropertyChange(
        'description',
        description as IssueFormData['description']
      );
    },
    [handlePropertyChange]
  );

  // Submit handler
  const handleSubmit = useCallback(async () => {
    if (!displayData.title.trim() || hasPendingAttachments) return;

    setIsSubmitting(true);
    try {
      if (mode === 'create') {
        // Create new issue at the top of the column
        const statusIssues = issues.filter(
          (i) => i.status_id === displayData.statusId
        );
        const minSortOrder =
          statusIssues.length > 0
            ? Math.min(...statusIssues.map((i) => i.sort_order))
            : 0;

        const { persisted } = insertIssue({
          project_id: projectId,
          status_id: displayData.statusId,
          title: displayData.title,
          description: displayData.description,
          priority: displayData.priority,
          sort_order: minSortOrder - 1,
          start_date: null,
          target_date: null,
          completed_at: null,
          parent_issue_id: kanbanCreateDefaultParentIssueId,
          parent_issue_sort_order: null,
          extension_metadata: intakeMetadataRef.current ?? {},
        });

        // Wait for the issue to be confirmed by the backend and get the synced entity
        const syncedIssue = await persisted;
        // Provenance consumed; clear it so a subsequent card doesn't inherit it.
        intakeMetadataRef.current = null;

        // Commit only attachments still referenced in the description
        const allUploadedIds = getAttachmentIds();
        if (allUploadedIds.length > 0) {
          const referencedIds = extractAttachmentIds(
            displayData.description ?? ''
          );
          const idsToCommit = allUploadedIds.filter((id) =>
            referencedIds.has(id)
          );
          const idsToDelete = allUploadedIds.filter(
            (id) => !referencedIds.has(id)
          );

          if (idsToCommit.length > 0) {
            await commitIssueAttachments(syncedIssue.id, {
              attachment_ids: idsToCommit,
            });
          }
          for (const id of idsToDelete) {
            deleteAttachment(id).catch((err) =>
              console.error('Failed to delete abandoned attachment:', err)
            );
          }
          clearAttachments();
        }

        // Create assignee records for all selected assignees
        displayData.assigneeIds.forEach((userId) => {
          insertIssueAssignee({
            issue_id: syncedIssue.id,
            user_id: userId,
          });
        });

        // Create tag records if tags were selected
        for (const tagId of displayData.tagIds) {
          insertIssueTag({
            issue_id: syncedIssue.id,
            tag_id: tagId,
          });
        }

        if (issueComposerKey) {
          closeKanbanIssueComposer(issueComposerKey);
        }

        if (displayData.createDraftWorkspace) {
          const initialPrompt = buildWorkspaceCreatePrompt(
            displayData.title,
            displayData.description
          );

          // Get defaults from most recent workspace
          const defaults = await getWorkspaceDefaults(
            workspaces,
            localWorkspaceIds,
            projectId,
            displayData.workspaceHostId
          );

          const createState = buildWorkspaceCreateInitialState({
            prompt: initialPrompt,
            defaults,
            linkedIssue: buildLinkedIssueCreateState(syncedIssue, projectId),
          });
          const draftId = await openWorkspaceCreateFromState(createState, {
            issueId: syncedIssue.id,
            hostId: displayData.workspaceHostId,
          });
          if (!draftId) {
            await ConfirmDialog.show({
              title: t('common:error'),
              message: t(
                'workspaces.createDraftError',
                'Failed to prepare workspace draft. Please try again.'
              ),
              confirmText: t('common:ok'),
              showCancelButton: false,
            });
            onExpectIssueOpen?.(syncedIssue.id);
            openIssue(syncedIssue.id);
          }
          return; // Don't open issue panel since we're navigating away
        }

        // Open the newly created issue
        onExpectIssueOpen?.(syncedIssue.id);
        openIssue(syncedIssue.id);
      } else {
        // Update existing issue - would use update mutation
        // For now, just close the panel
        closeKanbanIssuePanel();
      }
    } catch (error) {
      console.error('Failed to save issue:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    mode,
    displayData,
    projectId,
    issues,
    insertIssue,
    insertIssueAssignee,
    insertIssueTag,
    openIssue,
    kanbanCreateDefaultParentIssueId,
    openWorkspaceCreateFromState,
    workspaces,
    localWorkspaceIds,
    closeKanbanIssuePanel,
    issueComposerKey,
    getAttachmentIds,
    clearAttachments,
    hasPendingAttachments,
    onExpectIssueOpen,
    t,
  ]);

  const handleCreateWorkspace = useCallback(async () => {
    if (!selectedIssue) return;

    // Cmd/Ctrl+Enter can run before the debounced text saves have fired.
    // Persist safe editor values before navigating so the issue and workspace
    // prompt cannot lose or use stale edits. Attachment-backed descriptions
    // remain on the existing upload-completion save path.
    cancelDebouncedTitle();
    cancelDebouncedDescription();
    const issuePatch: { title?: string; description?: string | null } = {};
    if (displayData.title !== selectedIssue.title) {
      issuePatch.title = displayData.title;
    }
    if (
      !hasPendingAttachments &&
      displayData.description !== selectedIssue.description
    ) {
      issuePatch.description = displayData.description;
    }
    if (Object.keys(issuePatch).length > 0) {
      updateIssue(selectedIssue.id, issuePatch);
    }

    const hostId = await selectWorkspaceHost();
    if (hostId === undefined) return;

    const defaults = await getWorkspaceDefaults(
      workspaces,
      localWorkspaceIds,
      projectId,
      hostId
    );
    const createState = buildWorkspaceCreateInitialState({
      prompt: buildWorkspaceCreatePrompt(
        displayData.title,
        hasPendingAttachments
          ? selectedIssue.description
          : displayData.description
      ),
      defaults,
      linkedIssue: buildLinkedIssueCreateState(selectedIssue, projectId),
    });
    const draftId = await openWorkspaceCreateFromState(createState, {
      issueId: selectedIssue.id,
      hostId,
    });
    if (!draftId) {
      await ConfirmDialog.show({
        title: t('common:error'),
        message: t(
          'workspaces.createDraftError',
          'Failed to prepare workspace draft. Please try again.'
        ),
        confirmText: t('common:ok'),
        showCancelButton: false,
      });
    }
  }, [
    selectedIssue,
    displayData.title,
    displayData.description,
    hasPendingAttachments,
    cancelDebouncedTitle,
    cancelDebouncedDescription,
    updateIssue,
    workspaces,
    localWorkspaceIds,
    projectId,
    openWorkspaceCreateFromState,
    t,
  ]);

  const handleCmdEnterSubmit = useCallback(() => {
    if (mode === 'create') {
      void handleSubmit();
      return;
    }

    void handleCreateWorkspace();
  }, [mode, handleSubmit, handleCreateWorkspace]);

  // Tag create callback - returns the new tag ID so it can be auto-selected
  const handleCreateTag = useCallback(
    (data: { name: string; color: string }): string => {
      const { data: newTag } = insertTag({
        project_id: projectId,
        name: data.name,
        color: data.color,
      });
      return newTag.id;
    },
    [insertTag, projectId]
  );

  // Copy link callback - copies issue URL to clipboard
  const handleCopyLink = useCallback(() => {
    if (!selectedKanbanIssueId || !projectId) return;
    const url = `${window.location.origin}/projects/${projectId}/issues/${selectedKanbanIssueId}`;
    navigator.clipboard.writeText(url);
  }, [projectId, selectedKanbanIssueId]);

  const handleOpenInNewTab = useCallback(() => {
    if (!selectedKanbanIssueId || !projectId) return;
    openInSplitPane(
      `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(selectedKanbanIssueId)}`
    );
  }, [projectId, selectedKanbanIssueId]);

  // More actions callback - opens command bar with issue actions
  const handleMoreActions = useCallback(async () => {
    if (!selectedKanbanIssueId || !projectId) return;
    await CommandBarDialog.show({
      page: 'issueActions',
      projectId,
      issueIds: [selectedKanbanIssueId],
    });
  }, [selectedKanbanIssueId, projectId]);

  // Link PR callback - opens link PR dialog
  const handleLinkPr = useCallback(async () => {
    if (!selectedKanbanIssueId) return;
    const { LinkPrToIssueDialog } = await import(
      '@/shared/dialogs/command-bar/LinkPrToIssueDialog'
    );
    await LinkPrToIssueDialog.show({
      projectId,
      issueId: selectedKanbanIssueId,
    });
  }, [selectedKanbanIssueId, projectId]);

  const handleLinkGithubIssue = useCallback(async () => {
    if (!selectedIssue) return;
    const { LinkGithubIssueDialog } = await import(
      '@/shared/dialogs/command-bar/LinkGithubIssueDialog'
    );
    await LinkGithubIssueDialog.show({
      runtime,
      hostId: githubIssueAutomationHostId,
      projectId,
      hosts: availableWorkspaceHosts
        .filter((host) => host.status === 'online')
        .map((host) => ({ id: host.id, name: host.name })),
      issueId: selectedIssue.id,
      title: selectedIssue.title,
      description: selectedIssue.description,
      statusId: selectedIssue.status_id,
      updatedAt: selectedIssue.updated_at,
    });
  }, [
    availableWorkspaceHosts,
    githubIssueAutomationHostId,
    projectId,
    runtime,
    selectedIssue,
  ]);

  const handleRemoveGithubIssue = useCallback(
    (linkId: string) => {
      void (async () => {
        const result = await ConfirmDialog.show({
          title: 'Unlink GitHub issue?',
          message:
            'This removes synchronization. The GitHub issue itself is not affected.',
          confirmText: 'Unlink',
          variant: 'destructive',
        });
        if (result === 'confirmed') removeGithubIssueLink(linkId);
      })();
    },
    [removeGithubIssueLink]
  );

  const handleRemovePr = useCallback(
    (prId: string) => {
      if (!selectedKanbanIssueId) return;
      // The badge is keyed by PR id, but the link row (pull_request_issues) is
      // what actually attaches the PR to this issue — resolve it before deleting.
      const link = pullRequestIssues.find(
        (l) =>
          l.issue_id === selectedKanbanIssueId && l.pull_request_id === prId
      );
      if (!link) return;
      void (async () => {
        const result = await ConfirmDialog.show({
          title: t('kanban.unlinkPrTitle', 'Unlink pull request?'),
          message: t(
            'kanban.unlinkPrMessage',
            'This removes the link between the pull request and this issue. The pull request itself is not affected.'
          ),
          confirmText: t('kanban.unlinkPrConfirm', 'Unlink'),
          variant: 'destructive',
        });
        if (result !== 'confirmed') return;
        removePullRequestIssue(link.id);
      })();
    },
    [selectedKanbanIssueId, pullRequestIssues, removePullRequestIssue, t]
  );

  // Loading state
  const isLoading = projectLoading || orgLoading;
  const isResolvingExpectedIssue =
    mode === 'edit' &&
    selectedKanbanIssueId !== null &&
    issueResolution === 'resolving';
  const hasMissingIssueDataInEditMode =
    mode === 'edit' && selectedKanbanIssueId !== null && selectedIssue === null;

  if (isLoading || isResolvingExpectedIssue || hasMissingIssueDataInEditMode) {
    return (
      <div className="flex items-center justify-center h-full bg-secondary">
        <p className="text-low">{t('states.loading')}</p>
      </div>
    );
  }

  return (
    <KanbanIssuePanel
      mode={mode}
      displayId={displayId}
      formData={displayData}
      assigneeUsers={displayAssigneeUsers}
      onFormChange={handlePropertyChange}
      statuses={sortedStatuses}
      tags={tags}
      workspaceHosts={workspaceHosts}
      issueId={selectedKanbanIssueId}
      creatorUser={issueCreator}
      parentIssue={parentIssue}
      onParentIssueClick={handleParentIssueClick}
      onRemoveParentIssue={handleRemoveParentIssue}
      linkedPrs={linkedPrs}
      linkedGithubIssues={linkedGithubIssues}
      onLinkPr={mode === 'edit' ? handleLinkPr : undefined}
      onRemovePr={mode === 'edit' ? handleRemovePr : undefined}
      onLinkGithubIssue={mode === 'edit' ? handleLinkGithubIssue : undefined}
      onRemoveGithubIssue={
        mode === 'edit' ? handleRemoveGithubIssue : undefined
      }
      onClose={closeKanbanIssuePanel}
      onSubmit={handleSubmit}
      onCmdEnterSubmit={handleCmdEnterSubmit}
      onCreateTag={handleCreateTag}
      renderAddTagControl={({
        tags,
        selectedTagIds,
        onTagToggle,
        onCreateTag,
        disabled,
        trigger,
      }) => (
        <SearchableTagDropdownContainer
          tags={tags}
          selectedTagIds={selectedTagIds}
          onTagToggle={onTagToggle}
          onCreateTag={onCreateTag}
          disabled={disabled}
          contentClassName=""
          trigger={trigger}
        />
      )}
      isSubmitting={isSubmitting}
      descriptionSaveStatus={
        mode === 'edit' ? descriptionSaveStatus : undefined
      }
      titleInputRef={titleInputRef}
      onCopyLink={mode === 'edit' ? handleCopyLink : undefined}
      onOpenInNewTab={mode === 'edit' ? handleOpenInNewTab : undefined}
      onMoreActions={mode === 'edit' ? handleMoreActions : undefined}
      onPasteFiles={onPasteFiles}
      localAttachments={localAttachments}
      dropzoneProps={{ getRootProps, getInputProps, isDragActive }}
      onBrowseAttachment={openFilePicker}
      isUploading={isUploading}
      attachmentError={uploadError}
      onDismissAttachmentError={clearUploadError}
      renderDescriptionEditor={({ editorRef, ...props }) => (
        <WYSIWYGEditor
          {...props}
          ref={editorRef}
          hostId={displayData.workspaceHostId}
          localAttachments={localAttachments}
        />
      )}
      renderIntake={() => (
        <IssueIntakeSection
          projectId={projectId}
          hostId={displayData.workspaceHostId}
          title={displayData.title}
          description={displayData.description}
          disabled={isSubmitting}
          onGenerated={handleSpecGenerated}
        />
      )}
      renderWorkspacesSection={(issueId) => (
        <IssueWorkspacesSectionContainer issueId={issueId} />
      )}
      renderRelationshipsSection={(issueId) => (
        <IssueRelationshipsSectionContainer issueId={issueId} />
      )}
      renderSubIssuesSection={(issueId) => (
        <IssueSubIssuesSectionContainer issueId={issueId} />
      )}
      renderCommentsSection={(issueId) => (
        <IssueCommentsSectionContainer
          issueId={issueId}
          hostId={displayData.workspaceHostId}
        />
      )}
    />
  );
}
