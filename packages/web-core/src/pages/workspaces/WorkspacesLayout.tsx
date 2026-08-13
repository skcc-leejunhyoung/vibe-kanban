import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateModeInitialState } from '@/shared/types/createMode';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useMobileActiveTab } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';
import { CreateModeProvider } from '@/features/create-mode/model/CreateModeProvider';
import {
  consumeCreateModeSeedState,
  getCreateModeSeedVersion,
  subscribeCreateModeSeedState,
} from '@/features/create-mode/model/createModeSeedStore';
import { ReviewProvider } from '@/shared/hooks/ReviewProvider';
import { ChangesViewProvider } from '@/shared/hooks/ChangesViewProvider';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { LogsContentContainer } from './LogsContentContainer';
import {
  WorkspacesMainContainer,
  type WorkspacesMainContainerHandle,
} from './WorkspacesMainContainer';
import { RightSidebar } from './RightSidebar';
import { ChangesPanelContainer } from './ChangesPanelContainer';
import { CreateChatBoxContainer } from '@/shared/components/CreateChatBoxContainer';
import { PreviewBrowserContainer } from './PreviewBrowserContainer';
import { WorkspacesGuideDialog } from '@/shared/dialogs/shared/WorkspacesGuideDialog';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useWorkspacePanelState } from '@/shared/stores/useUiPreferencesStore';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useEscapeToClose } from '@/shared/keyboard/useEscapeToClose';
import { Scope } from '@/shared/keyboard/registry';
import { useUnfocusedChatKeys } from './workspaceChatKeyboard';
import { WorkspaceDetail, type WorkspaceDetailHandle } from './WorkspaceDetail';
import { WorkspacePaneGrid } from './WorkspacePaneGrid';

const WORKSPACES_GUIDE_ID = 'workspaces-guide';

interface WorkspacesLayoutProps {
  /**
   * When set, replaces the detail (main) pane while keeping the sidebar list
   * mounted. Remote web uses this to show a host-unavailable notice for an
   * offline host without blanking the unified multi-host list. It takes
   * precedence over both the normal conversation view and create mode, since
   * neither can function while the target host is unreachable.
   */
  detailUnavailable?: ReactNode;
}

export function WorkspacesLayout({
  detailUnavailable,
}: WorkspacesLayoutProps = {}) {
  const appNavigation = useAppNavigation();
  const {
    workspaceId,
    workspace: selectedWorkspace,
    isLoading,
    isCreateMode,
    selectedSession,
    selectedSessionId,
    sessions,
    isSessionsLoading,
    selectSession,
    repos,
    isNewSessionMode,
    startNewSession,
  } = useWorkspaceContext();

  const { t } = useTranslation('common');
  usePageTitle(
    isCreateMode ? t('workspaces.newWorkspace') : selectedWorkspace?.name
  );

  const seedVersion = useSyncExternalStore(
    subscribeCreateModeSeedState,
    getCreateModeSeedVersion,
    getCreateModeSeedVersion
  );
  const consumedSeedVersionRef = useRef(0);
  const [createModeSeed, setCreateModeSeed] = useState<{
    version: number;
    state: CreateModeInitialState | null;
  }>({
    version: 0,
    state: null,
  });

  useEffect(() => {
    if (!isCreateMode) {
      consumedSeedVersionRef.current = 0;
      setCreateModeSeed((current) =>
        current.version === 0 && current.state === null
          ? current
          : { version: 0, state: null }
      );
      return;
    }

    if (seedVersion === 0 || seedVersion === consumedSeedVersionRef.current) {
      return;
    }

    consumedSeedVersionRef.current = seedVersion;
    setCreateModeSeed({
      version: seedVersion,
      state: consumeCreateModeSeedState(),
    });
  }, [isCreateMode, seedVersion]);

  const createModeProviderKey =
    createModeSeed.version > 0
      ? `create-mode-seed-${createModeSeed.version}`
      : 'create-mode-seed-default';

  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useMobileActiveTab();
  const mobileMainRef = useRef<WorkspacesMainContainerHandle>(null);
  const detailRef = useRef<WorkspaceDetailHandle>(null);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      mobileMainRef.current?.scrollToBottom(behavior);
      detailRef.current?.scrollToBottom(behavior);
    },
    []
  );

  const handleWorkspaceCreated = useCallback(
    (createdWorkspaceId: string) => {
      appNavigation.goToWorkspace(createdWorkspaceId);
    },
    [appNavigation]
  );

  // Use workspace-specific panel state (pass undefined when in create mode)
  const { isLeftSidebarVisible, isLeftMainPanelVisible, rightMainPanelMode } =
    useWorkspacePanelState(isCreateMode ? undefined : workspaceId);

  const handleOpenCommit = useCallback(() => {
    setMobileTab('changes');
  }, [setMobileTab]);

  const showMobileWorkspaceList = useCallback(() => {
    setMobileTab('workspaces');
  }, [setMobileTab]);

  useEscapeToClose(showMobileWorkspaceList, {
    enabled: isMobile && mobileTab === 'chat',
    scope: Scope.WORKSPACE,
  });

  const showMobileChat = useCallback(() => {
    setMobileTab('chat');
  }, [setMobileTab]);

  useEscapeToClose(showMobileChat, {
    enabled: isMobile && mobileTab !== 'workspaces' && mobileTab !== 'chat',
    scope: Scope.WORKSPACE,
  });

  useUnfocusedChatKeys(
    mobileMainRef,
    isMobile &&
      mobileTab === 'chat' &&
      !isCreateMode &&
      !!selectedWorkspace &&
      isLeftMainPanelVisible
  );

  const {
    config,
    updateAndSaveConfig,
    loading: configLoading,
  } = useUserSystem();
  const hasAutoShownWorkspacesGuide = useRef(false);

  // Auto-show Workspaces Guide on first visit
  useEffect(() => {
    if (hasAutoShownWorkspacesGuide.current) return;
    if (configLoading || !config) return;

    const seenFeatures = config.showcases?.seen_features ?? [];
    if (seenFeatures.includes(WORKSPACES_GUIDE_ID)) return;

    hasAutoShownWorkspacesGuide.current = true;

    void updateAndSaveConfig({
      showcases: { seen_features: [...seenFeatures, WORKSPACES_GUIDE_ID] },
    });
    WorkspacesGuideDialog.show().finally(() => WorkspacesGuideDialog.hide());
  }, [configLoading, config, updateAndSaveConfig]);

  const secondaryPaneCount = useWorkspacePanesStore((s) => s.panes.length);
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const isPrimaryPaneActive = secondaryPaneCount === 0 || activePaneId === null;

  // ── Mobile layout ──────────────────────────────────────────────────
  // Uses `hidden` CSS class (NOT conditional rendering) to preserve
  // WebSocket connections and scroll positions across tab switches.
  if (isMobile) {
    const mobileContent = (
      <ReviewProvider workspaceId={selectedWorkspace?.id}>
        <ChangesViewProvider>
          <div className="flex flex-col h-full min-h-0">
            {/* Workspaces tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'workspaces' && 'hidden'
              )}
            >
              <WorkspacesSidebarContainer
                onScrollToBottom={handleScrollToBottom}
              />
            </div>

            {/* Chat tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'chat' && 'hidden'
              )}
            >
              {isCreateMode ? (
                <CreateChatBoxContainer
                  onWorkspaceCreated={handleWorkspaceCreated}
                />
              ) : (
                <WorkspacesMainContainer
                  ref={mobileMainRef}
                  selectedWorkspace={selectedWorkspace ?? null}
                  selectedSession={selectedSession}
                  selectedSessionId={selectedSessionId}
                  sessions={sessions}
                  repos={repos}
                  onSelectSession={selectSession}
                  isLoading={isLoading}
                  isSessionsLoading={isSessionsLoading}
                  isNewSessionMode={isNewSessionMode}
                  onStartNewSession={startNewSession}
                  autoFocus={mobileTab === 'chat'}
                />
              )}
            </div>

            {/* Changes tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'changes' && 'hidden'
              )}
            >
              {selectedWorkspace?.id && (
                <ChangesPanelContainer
                  className=""
                  workspaceId={selectedWorkspace.id}
                />
              )}
            </div>

            {/* Logs tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'logs' && 'hidden'
              )}
            >
              <LogsContentContainer className="" />
            </div>

            {/* Preview tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'preview' && 'hidden'
              )}
            >
              {selectedWorkspace?.id && (
                <PreviewBrowserContainer
                  workspaceId={selectedWorkspace.id}
                  className=""
                />
              )}
            </div>

            {/* Git tab */}
            <div
              className={cn(
                'flex-1 min-h-0 overflow-hidden',
                mobileTab !== 'git' && 'hidden'
              )}
            >
              {selectedWorkspace && !isCreateMode && (
                <RightSidebar
                  rightMainPanelMode={rightMainPanelMode}
                  selectedWorkspace={selectedWorkspace}
                  repos={repos}
                  onOpenCommit={handleOpenCommit}
                />
              )}
            </div>
          </div>
        </ChangesViewProvider>
      </ReviewProvider>
    );

    return (
      <div className="flex flex-1 min-h-0 h-full">
        <div className="flex-1 min-w-0 h-full">
          {detailUnavailable ? (
            detailUnavailable
          ) : isCreateMode ? (
            <CreateModeProvider
              key={createModeProviderKey}
              initialState={createModeSeed.state}
            >
              {mobileContent}
            </CreateModeProvider>
          ) : (
            mobileContent
          )}
        </div>
      </div>
    );
  }

  const primaryDetail = (
    <WorkspaceDetail ref={detailRef} isPaneActive={isPrimaryPaneActive} />
  );

  const primaryContent = detailUnavailable ? (
    detailUnavailable
  ) : isCreateMode ? (
    <CreateModeProvider
      key={createModeProviderKey}
      initialState={createModeSeed.state}
    >
      {primaryDetail}
    </CreateModeProvider>
  ) : (
    primaryDetail
  );

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {isLeftSidebarVisible && (
        <div className="w-[300px] shrink-0 h-full overflow-hidden">
          <WorkspacesSidebarContainer onScrollToBottom={handleScrollToBottom} />
        </div>
      )}

      <div className="flex-1 min-w-0 h-full">
        <WorkspacePaneGrid primary={primaryContent} />
      </div>
    </div>
  );
}
