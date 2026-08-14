import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowsOutIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { ExecutionProcessesProvider } from '@/shared/providers/ExecutionProcessesProvider';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import { CreateModeProvider } from '@/features/create-mode/model/CreateModeProvider';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { CreateChatBoxContainer } from '@/shared/components/CreateChatBoxContainer';
import { KanbanIssuePanelContainer } from './KanbanIssuePanelContainer';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import { createWorkspaceWithSession } from '@/shared/types/attempt';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import { findRemoteWorkspaceByLocalIdentity } from '@/shared/lib/workspaceHostIdentity';
import { useOpenInSplitPane } from '@/shared/lib/openInSplitPane';
import { buildWorkspacePath } from '@/shared/lib/routes/appNavigation';
import { useEscapeToClose } from '@/shared/keyboard/useEscapeToClose';
import { useIsActivePane } from '@/shared/components/workspace-panes/PaneActiveContext';
import { resolveUnfocusedChatKeyAction } from '@/pages/workspaces/workspaceChatKeyboard';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  useKanbanIssueComposer,
} from '@/shared/stores/useKanbanIssueComposerStore';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';

interface WorkspaceSessionPanelProps {
  workspaceId: string;
  onClose: () => void;
}

interface WorkspaceCreatePanelProps {
  linkedIssueId: string | null;
  linkedIssueSimpleId: string | null;
  onOpenIssue: (issueId: string) => void;
  onClose: () => void;
  children: ReactNode;
}

type IssuePanelResolution = 'resolving' | 'ready' | 'missing';

type RightPanelState =
  | { kind: 'closed' }
  | { kind: 'create-issue' }
  | { kind: 'issue'; issueId: string; resolution: IssuePanelResolution }
  | { kind: 'issue-workspace'; workspaceId: string }
  | { kind: 'workspace-create'; draftId: string; issueId: string | null };

function resolveIssuePanelResolution({
  issueId,
  hasIssue,
  isProjectLoading,
  expectedIssueId,
}: {
  issueId: string;
  hasIssue: boolean;
  isProjectLoading: boolean;
  expectedIssueId: string | null;
}): IssuePanelResolution {
  if (isProjectLoading) {
    return 'resolving';
  }

  if (hasIssue) {
    return 'ready';
  }

  if (expectedIssueId === issueId) {
    return 'resolving';
  }

  return 'missing';
}

function WorkspaceCreatePanel({
  linkedIssueId,
  linkedIssueSimpleId,
  onOpenIssue,
  onClose,
  children,
}: WorkspaceCreatePanelProps) {
  const { t } = useTranslation('tasks');
  const breadcrumbButtonClass =
    'min-w-0 text-sm text-normal truncate rounded-sm px-1 py-0.5 hover:bg-panel hover:text-high transition-colors';

  const handleOpenIssue = useCallback(() => {
    if (linkedIssueId) {
      onOpenIssue(linkedIssueId);
      return;
    }
    onClose();
  }, [linkedIssueId, onOpenIssue, onClose]);

  return (
    <div className="relative flex h-full flex-1 flex-col bg-primary">
      <div className="flex items-center justify-between px-base py-half border-b shrink-0">
        <div className="flex items-center gap-half min-w-0 font-ibm-plex-mono">
          <button
            type="button"
            onClick={handleOpenIssue}
            className={`${breadcrumbButtonClass} shrink-0`}
            aria-label="Open linked issue"
          >
            {linkedIssueSimpleId ?? 'Issue'}
          </button>
          <span className="text-low text-sm shrink-0">/</span>
          <span className={breadcrumbButtonClass}>
            {t('createWorkspaceFromPr.createWorkspace')}
          </span>
        </div>
        <div className="flex items-center gap-half">
          <button
            type="button"
            onClick={onClose}
            className="p-half rounded-sm text-low hover:text-normal hover:bg-panel transition-colors"
            aria-label="Close create workspace view"
          >
            <XIcon className="size-icon-sm" weight="bold" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function WorkspaceSessionPanel({
  workspaceId,
  onClose,
}: WorkspaceSessionPanelProps) {
  // Escape-to-close is handled once at the container level (see
  // ProjectRightSidebarContainer) so every right panel closes identically.
  const appNavigation = useAppNavigation();
  const openInSplitPane = useOpenInSplitPane();
  const { projectId, getIssue } = useProjectContext();
  const routeState = useCurrentKanbanRouteState();
  const { workspaces: remoteWorkspaces } = useUserContext();
  const {
    activeWorkspaces,
    archivedWorkspaces,
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    isSessionsLoading,
    isNewSessionMode,
    startNewSession,
  } = useWorkspaceContext();
  const isActivePane = useIsActivePane();
  const conversationListRef = useRef<ConversationListHandle>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const { data: workspace, isLoading: isWorkspaceLoading } = useWorkspaceRecord(
    workspaceId,
    { enabled: !!workspaceId }
  );
  const workspaceSummary = useMemo(
    () =>
      [...activeWorkspaces, ...archivedWorkspaces].find(
        (workspace) => workspace.id === workspaceId
      ),
    [activeWorkspaces, archivedWorkspaces, workspaceId]
  );

  const linkedWorkspace = useMemo(() => {
    const workspace = findRemoteWorkspaceByLocalIdentity(
      remoteWorkspaces,
      workspaceId ?? '',
      routeState.hostId
    );
    return workspace?.project_id === projectId ? workspace : null;
  }, [remoteWorkspaces, workspaceId, routeState.hostId, projectId]);

  const linkedIssueId = linkedWorkspace?.issue_id ?? null;
  const breadcrumbIssueId = routeState.issueId ?? linkedIssueId;

  const issueSimpleId = useMemo(() => {
    if (!breadcrumbIssueId) return null;
    return getIssue(breadcrumbIssueId)?.simple_id ?? null;
  }, [breadcrumbIssueId, getIssue]);

  const workspaceBranch = workspace?.branch ?? workspaceSummary?.branch ?? null;

  const handleOpenIssuePanel = useCallback(() => {
    if (projectId && breadcrumbIssueId) {
      appNavigation.goToProjectIssue(projectId, breadcrumbIssueId);
      return;
    }
    onClose();
  }, [projectId, breadcrumbIssueId, appNavigation, onClose]);

  const handleOpenWorkspaceView = useCallback(() => {
    appNavigation.goToWorkspace(workspaceId);
  }, [appNavigation, workspaceId]);

  const handleOpenWorkspaceInNewTab = useCallback(() => {
    openInSplitPane(buildWorkspacePath(workspaceId, routeState.hostId));
  }, [openInSplitPane, routeState.hostId, workspaceId]);

  const breadcrumbButtonClass =
    'min-w-0 text-sm text-normal truncate rounded-sm px-1 py-0.5 hover:bg-panel hover:text-high transition-colors';

  const workspaceWithSession = useMemo(() => {
    if (!workspace) return undefined;
    return createWorkspaceWithSession(workspace, selectedSession);
  }, [workspace, selectedSession]);

  const handleScrollToPreviousMessage = useCallback(() => {
    conversationListRef.current?.scrollToPreviousUserMessage();
  }, []);

  const handleScrollToUserMessage = useCallback((key: string) => {
    // Turns not yet paged in carry a `proc:<id>` key; resolve those by loading
    // history up to that process, then scrolling. Loaded turns keep their real
    // entry patchKey for an instant jump.
    if (key.startsWith('proc:')) {
      conversationListRef.current?.scrollToProcess(key.slice('proc:'.length));
    } else {
      conversationListRef.current?.scrollToEntryByPatchKey(key);
    }
  }, []);

  const handleGetActiveTurnPatchKey = useCallback(() => {
    return conversationListRef.current?.getVisibleUserMessagePatchKey() ?? null;
  }, []);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      conversationListRef.current?.scrollToBottom(behavior);
    },
    []
  );

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
  }, []);

  useEffect(() => {
    if (!isActivePane) return;
    const handleUnfocusedChatKeyDown = (event: KeyboardEvent) => {
      if (isModalKeyboardActive()) return;
      const activeElement = document.activeElement;
      const hasNoFocusedControl =
        activeElement === null ||
        activeElement === document.body ||
        activeElement === document.documentElement;
      if (!hasNoFocusedControl) return;

      const action = resolveUnfocusedChatKeyAction(event);
      if (action?.type === 'scroll') {
        const scrollElement = conversationListRef.current?.getScrollElement();
        if (!scrollElement) return;

        scrollElement.scrollTop += action.delta;
        // Take precedence over kanban board arrow navigation while the workspace
        // panel is open: capture the event and stop it before the board's
        // document-level hotkey listener can also act on the same key.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      if (action?.type === 'focus-composer') {
        const editor = panelRef.current?.querySelector<HTMLElement>(
          '[data-chatbox-container="true"] [contenteditable="true"]'
        );
        if (!editor) return;

        editor.focus();
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    // Capture phase so this runs before the board's document-level navigation
    // listener, letting the open workspace panel win the arrow keys.
    window.addEventListener('keydown', handleUnfocusedChatKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleUnfocusedChatKeyDown, true);
    };
  }, [isActivePane]);

  return (
    <ExecutionProcessesProvider
      key={`${workspaceId}-${selectedSessionId ?? 'new'}`}
      sessionId={selectedSessionId}
    >
      <ApprovalFeedbackProvider>
        <EntriesProvider key={`${workspaceId}-${selectedSessionId ?? 'new'}`}>
          <MessageEditProvider>
            <div
              ref={panelRef}
              className="relative flex h-full flex-1 flex-col bg-primary"
            >
              <div className="flex items-center justify-between px-base py-half border-b shrink-0">
                <div className="flex items-center gap-half min-w-0 font-ibm-plex-mono">
                  <button
                    type="button"
                    onClick={handleOpenIssuePanel}
                    className={`${breadcrumbButtonClass} shrink-0`}
                    aria-label="Open linked issue"
                  >
                    {issueSimpleId ?? 'Issue'}
                  </button>
                  <span className="text-low text-sm shrink-0">/</span>
                  <button
                    type="button"
                    onClick={handleOpenWorkspaceView}
                    className={breadcrumbButtonClass}
                    aria-label="Open workspace"
                  >
                    {workspaceBranch ?? 'Workspace'}
                  </button>
                </div>

                <div className="flex items-center gap-half">
                  <button
                    type="button"
                    onClick={handleOpenWorkspaceView}
                    className="p-half rounded-sm text-low hover:text-normal hover:bg-panel transition-colors"
                    aria-label="Open in workspace view"
                  >
                    <ArrowsOutIcon className="size-icon-sm" weight="bold" />
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenWorkspaceInNewTab}
                    className="p-half rounded-sm text-low hover:text-normal hover:bg-panel transition-colors"
                    aria-label="Open workspace in new tab"
                  >
                    <ArrowSquareOutIcon
                      className="size-icon-sm"
                      weight="bold"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="p-half rounded-sm text-low hover:text-normal hover:bg-panel transition-colors"
                    aria-label="Close conversation view"
                  >
                    <XIcon className="size-icon-sm" weight="bold" />
                  </button>
                </div>
              </div>

              {workspaceWithSession ? (
                <div className="flex flex-1 min-h-0 overflow-hidden justify-center">
                  <div className="w-chat max-w-full h-full">
                    <RetryUiProvider workspaceId={workspaceWithSession.id}>
                      <ConversationList
                        key={`${workspaceId}-${selectedSessionId ?? 'new'}`}
                        ref={conversationListRef}
                        attempt={workspaceWithSession}
                        onAtBottomChange={handleAtBottomChange}
                        sessionScopeId={selectedSessionId}
                      />
                    </RetryUiProvider>
                  </div>
                </div>
              ) : (
                <div className="flex-1" />
              )}

              {workspaceWithSession && !isAtBottom && (
                <div className="flex justify-center pointer-events-none">
                  <div className="w-chat max-w-full relative">
                    <button
                      type="button"
                      onClick={() => handleScrollToBottom('auto')}
                      className="absolute bottom-2 right-4 z-10 pointer-events-auto flex items-center justify-center size-8 rounded-full bg-secondary/80 backdrop-blur-sm border border-secondary text-low hover:text-normal hover:bg-secondary shadow-md transition-all"
                      aria-label="Scroll to bottom"
                      title="Scroll to bottom"
                    >
                      <ArrowDownIcon className="size-icon-base" weight="bold" />
                    </button>
                  </div>
                </div>
              )}

              <div
                className="flex min-h-0 max-h-[50%] justify-center @container pl-px"
                data-chatbox-container="true"
              >
                <SessionChatBoxContainer
                  {...(isSessionsLoading || isWorkspaceLoading
                    ? {
                        mode: 'placeholder' as const,
                      }
                    : isNewSessionMode
                      ? {
                          mode: 'new-session' as const,
                          workspaceId,
                          onSelectSession: selectSession,
                        }
                      : selectedSession
                        ? {
                            mode: 'existing-session' as const,
                            session: selectedSession,
                            onSelectSession: selectSession,
                            onStartNewSession: startNewSession,
                          }
                        : {
                            mode: 'placeholder' as const,
                          })}
                  sessions={sessions}
                  filesChanged={workspaceSummary?.filesChanged ?? 0}
                  linesAdded={workspaceSummary?.linesAdded ?? 0}
                  linesRemoved={workspaceSummary?.linesRemoved ?? 0}
                  disableViewCode
                  showOpenWorkspaceButton
                  onScrollToPreviousMessage={handleScrollToPreviousMessage}
                  onScrollToBottom={handleScrollToBottom}
                  onScrollToUserMessage={handleScrollToUserMessage}
                  getActiveTurnPatchKey={handleGetActiveTurnPatchKey}
                />
              </div>
            </div>
          </MessageEditProvider>
        </EntriesProvider>
      </ApprovalFeedbackProvider>
    </ExecutionProcessesProvider>
  );
}

export function ProjectRightSidebarContainer() {
  const appNavigation = useAppNavigation();
  const {
    projectId,
    getIssue,
    isLoading: isProjectLoading,
    issuesById,
  } = useProjectContext();
  const routeState = useCurrentKanbanRouteState();
  const { issueId, workspaceId, draftId, isWorkspaceCreateMode, hostId } =
    routeState;
  const issueComposerKey = useMemo(() => {
    if (!projectId) {
      return null;
    }

    return buildKanbanIssueComposerKey(hostId, projectId);
  }, [hostId, projectId]);
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const isCreateMode = issueComposer !== null;
  const openIssue = useCallback(
    (targetIssueId: string) => {
      if (!projectId) {
        return;
      }

      if (isCreateMode && issueComposerKey) {
        closeKanbanIssueComposer(issueComposerKey);
      }

      appNavigation.goToProjectIssue(projectId, targetIssueId);
    },
    [projectId, isCreateMode, issueComposerKey, appNavigation]
  );
  const openIssueWorkspace = useCallback(
    (targetIssueId: string, targetWorkspaceId: string) => {
      if (!projectId) {
        return;
      }

      appNavigation.goToProjectIssueWorkspace(
        projectId,
        targetIssueId,
        targetWorkspaceId
      );
    },
    [projectId, appNavigation]
  );
  const closePanel = useCallback(() => {
    if (!projectId) {
      return;
    }

    if (isCreateMode && issueComposerKey) {
      closeKanbanIssueComposer(issueComposerKey);
    }

    appNavigation.goToProject(projectId);
  }, [projectId, isCreateMode, issueComposerKey, appNavigation]);
  const [expectedIssueId, setExpectedIssueId] = useState<string | null>(null);

  const markExpectedIssue = useCallback((nextIssueId: string) => {
    setExpectedIssueId(nextIssueId);
  }, []);

  // Keep transient create expectations scoped to the current issue route only.
  useEffect(() => {
    if (!expectedIssueId) {
      return;
    }

    if (!issueId || issueId !== expectedIssueId) {
      setExpectedIssueId(null);
      return;
    }

    if (issuesById.has(expectedIssueId)) {
      setExpectedIssueId(null);
    }
  }, [expectedIssueId, issueId, issuesById]);

  const issuePanelResolution = useMemo<IssuePanelResolution | null>(() => {
    if (!issueId || isCreateMode || workspaceId || isWorkspaceCreateMode) {
      return null;
    }

    return resolveIssuePanelResolution({
      issueId,
      hasIssue: issuesById.has(issueId),
      isProjectLoading,
      expectedIssueId,
    });
  }, [
    issueId,
    isCreateMode,
    workspaceId,
    isWorkspaceCreateMode,
    issuesById,
    isProjectLoading,
    expectedIssueId,
  ]);

  const rightPanelState = useMemo<RightPanelState>(() => {
    if (isCreateMode) {
      return { kind: 'create-issue' };
    }

    if (isWorkspaceCreateMode) {
      if (draftId) {
        return {
          kind: 'workspace-create',
          draftId,
          issueId,
        };
      }
      return { kind: 'closed' };
    }

    if (workspaceId) {
      return { kind: 'issue-workspace', workspaceId };
    }

    if (issueId) {
      return {
        kind: 'issue',
        issueId,
        resolution: issuePanelResolution ?? 'resolving',
      };
    }

    return { kind: 'closed' };
  }, [
    isWorkspaceCreateMode,
    draftId,
    issueId,
    workspaceId,
    isCreateMode,
    issuePanelResolution,
  ]);

  const handleOpenIssueFromCreate = useCallback(
    (targetIssueId: string) => {
      openIssue(targetIssueId);
    },
    [openIssue]
  );

  const handleWorkspaceCreated = useCallback(
    (createdWorkspaceId: string) => {
      if (issueId) {
        openIssueWorkspace(issueId, createdWorkspaceId);
        return;
      }

      appNavigation.goToWorkspace(createdWorkspaceId);
    },
    [issueId, openIssueWorkspace, appNavigation]
  );

  useEffect(() => {
    if (rightPanelState.kind !== 'issue') {
      return;
    }

    if (rightPanelState.resolution !== 'missing') {
      return;
    }

    closePanel();
  }, [rightPanelState, closePanel]);

  // Close whichever right panel is open on Escape — unified across the issue,
  // create-issue, workspace-session, and workspace-create variants so they all
  // behave like the X button. The issue panel additionally intercepts Escape
  // while one of its own fields is focused (blur first, stopPropagation), so
  // this never closes the panel mid-edit.
  useEscapeToClose(closePanel, {
    enabled: rightPanelState.kind !== 'closed',
  });

  if (rightPanelState.kind === 'workspace-create') {
    const linkedIssueId = rightPanelState.issueId;
    const linkedIssueSimpleId = linkedIssueId
      ? (getIssue(linkedIssueId)?.simple_id ?? null)
      : null;

    return (
      <WorkspaceCreatePanel
        linkedIssueId={linkedIssueId}
        linkedIssueSimpleId={linkedIssueSimpleId}
        onOpenIssue={handleOpenIssueFromCreate}
        onClose={closePanel}
      >
        <CreateModeProvider
          key={rightPanelState.draftId}
          draftId={rightPanelState.draftId}
        >
          <CreateChatBoxContainer onWorkspaceCreated={handleWorkspaceCreated} />
        </CreateModeProvider>
      </WorkspaceCreatePanel>
    );
  }

  if (rightPanelState.kind === 'issue-workspace') {
    return (
      <WorkspaceSessionPanel
        workspaceId={rightPanelState.workspaceId}
        onClose={closePanel}
      />
    );
  }

  if (rightPanelState.kind === 'closed') {
    return null;
  }

  return (
    <KanbanIssuePanelContainer
      issueResolution={
        rightPanelState.kind === 'issue' ? rightPanelState.resolution : null
      }
      onExpectIssueOpen={markExpectedIssue}
    />
  );
}
