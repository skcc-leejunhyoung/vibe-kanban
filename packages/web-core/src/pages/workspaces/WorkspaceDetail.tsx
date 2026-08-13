import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Group, Layout, Panel, Separator } from 'react-resizable-panels';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { ReviewProvider } from '@/shared/hooks/ReviewProvider';
import { ChangesViewProvider } from '@/shared/hooks/ChangesViewProvider';
import { LogsContentContainer } from './LogsContentContainer';
import {
  WorkspacesMainContainer,
  type WorkspacesMainContainerHandle,
} from './WorkspacesMainContainer';
import { RightSidebar } from './RightSidebar';
import { ChangesPanelContainer } from './ChangesPanelContainer';
import { CreateChatBoxContainer } from '@/shared/components/CreateChatBoxContainer';
import { PreviewBrowserContainer } from './PreviewBrowserContainer';
import {
  PERSIST_KEYS,
  usePaneSize,
  useWorkspacePanelState,
  RIGHT_MAIN_PANEL_MODES,
} from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useEscapeToClose } from '@/shared/keyboard/useEscapeToClose';
import { Scope } from '@/shared/keyboard/registry';
import { useUnfocusedChatKeys } from './workspaceChatKeyboard';

export interface WorkspaceDetailHandle {
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
}

interface WorkspaceDetailProps {
  /**
   * Whether this detail view is the active pane. Inactive panes must pass
   * false so several detail views can coexist in one document: it gates
   * window-level keyboard behaviour (Esc closes the right panel, unfocused
   * arrow keys scroll the chat), autofocus, and — since right-sidebar
   * visibility is a global preference — which pane renders the right sidebar.
   */
  isPaneActive?: boolean;
}

/**
 * The workspace detail view (chat + changes/logs/preview panel + right
 * sidebar). Renders from WorkspaceContext, so it works both as the routed
 * primary view and inside a WorkspacePaneScope split pane. Desktop only —
 * the mobile layout composes these containers directly.
 */
export const WorkspaceDetail = forwardRef<
  WorkspaceDetailHandle,
  WorkspaceDetailProps
>(function WorkspaceDetail({ isPaneActive = true }, ref) {
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

  const mainContainerRef = useRef<WorkspacesMainContainerHandle>(null);
  const [lastFocusedMainPanel, setLastFocusedMainPanel] = useState<
    'chat' | 'changes'
  >('chat');

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior: 'auto' | 'smooth' = 'smooth') => {
        mainContainerRef.current?.scrollToBottom(behavior);
      },
    }),
    []
  );

  const handleWorkspaceCreated = useCallback(
    (createdWorkspaceId: string) => {
      appNavigation.goToWorkspace(createdWorkspaceId);
    },
    [appNavigation]
  );

  // Use workspace-specific panel state (pass undefined when in create mode)
  const {
    isLeftMainPanelVisible,
    isRightSidebarVisible,
    rightMainPanelMode,
    setLeftMainPanelVisible,
    setRightMainPanelMode,
  } = useWorkspacePanelState(isCreateMode ? undefined : workspaceId);

  useEffect(() => {
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES) {
      setLastFocusedMainPanel('changes');
    }
  }, [rightMainPanelMode]);

  const handleOpenCommit = useCallback(() => {
    setRightMainPanelMode(RIGHT_MAIN_PANEL_MODES.CHANGES);
  }, [setRightMainPanelMode]);

  // Keep the chat pane open while closing the desktop's secondary panel.
  const closeRightMainPanel = useCallback(() => {
    setRightMainPanelMode(null);
  }, [setRightMainPanelMode]);

  useEscapeToClose(closeRightMainPanel, {
    enabled: isPaneActive && rightMainPanelMode !== null,
    scope: Scope.WORKSPACE,
  });

  useUnfocusedChatKeys(
    mainContainerRef,
    isPaneActive &&
      !isCreateMode &&
      !!selectedWorkspace &&
      isLeftMainPanelVisible
  );

  // Ensure the left main panel stays visible when the right main panel is
  // hidden, so the layout always has visible content.
  useEffect(() => {
    if (rightMainPanelMode === null && !isLeftMainPanelVisible) {
      setLeftMainPanelVisible(true);
    }
  }, [isLeftMainPanelVisible, rightMainPanelMode, setLeftMainPanelVisible]);

  const [rightMainPanelSize, setRightMainPanelSize] = usePaneSize(
    PERSIST_KEYS.rightMainPanel,
    50
  );

  const defaultLayout: Layout =
    typeof rightMainPanelSize === 'number'
      ? {
          'left-main': 100 - rightMainPanelSize,
          'right-main': rightMainPanelSize,
        }
      : { 'left-main': 50, 'right-main': 50 };

  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    };
  }, []);

  const onLayoutChange = useCallback(
    (layout: Layout) => {
      if (isLeftMainPanelVisible && rightMainPanelMode !== null) {
        if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = setTimeout(() => {
          setRightMainPanelSize(layout['right-main']);
        }, 150);
      }
    },
    [isLeftMainPanelVisible, rightMainPanelMode, setRightMainPanelSize]
  );

  return (
    <ReviewProvider workspaceId={selectedWorkspace?.id}>
      <ChangesViewProvider>
        <div className="flex h-full">
          <Group
            orientation="horizontal"
            className="flex-1 min-w-0 h-full"
            defaultLayout={defaultLayout}
            onLayoutChange={onLayoutChange}
          >
            {isLeftMainPanelVisible && (
              <Panel
                id="left-main"
                minSize="20%"
                className="min-w-0 h-full overflow-hidden"
              >
                {isCreateMode ? (
                  <CreateChatBoxContainer
                    onWorkspaceCreated={handleWorkspaceCreated}
                  />
                ) : (
                  <div
                    className="h-full"
                    onFocusCapture={() => setLastFocusedMainPanel('chat')}
                  >
                    <WorkspacesMainContainer
                      ref={mainContainerRef}
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
                      autoFocus={
                        isPaneActive &&
                        lastFocusedMainPanel === 'chat' &&
                        rightMainPanelMode !== RIGHT_MAIN_PANEL_MODES.CHANGES
                      }
                    />
                  </div>
                )}
              </Panel>
            )}

            {isLeftMainPanelVisible && rightMainPanelMode !== null && (
              <Separator
                id="main-separator"
                className="w-1 bg-transparent hover:bg-brand/50 transition-colors cursor-col-resize"
              />
            )}

            {rightMainPanelMode !== null && (
              <Panel
                id="right-main"
                minSize="20%"
                className="min-w-0 h-full overflow-hidden"
              >
                {rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES &&
                  selectedWorkspace?.id && (
                    <ChangesPanelContainer
                      className=""
                      workspaceId={selectedWorkspace.id}
                      autoFocus={
                        isPaneActive && lastFocusedMainPanel === 'changes'
                      }
                      onPanelFocus={() => setLastFocusedMainPanel('changes')}
                    />
                  )}
                {rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS && (
                  <LogsContentContainer className="" />
                )}
                {rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW &&
                  selectedWorkspace?.id && (
                    <PreviewBrowserContainer
                      workspaceId={selectedWorkspace.id}
                      className=""
                    />
                  )}
              </Panel>
            )}
          </Group>

          {/* Right-sidebar visibility is a global preference, so in a split
              only the active pane renders it — toggling it from the navbar
              affects the selected pane rather than every pane at once. */}
          {isRightSidebarVisible && isPaneActive && !isCreateMode && (
            <div className="w-[300px] shrink-0 h-full overflow-hidden">
              <RightSidebar
                rightMainPanelMode={rightMainPanelMode}
                selectedWorkspace={selectedWorkspace}
                repos={repos}
                onOpenCommit={handleOpenCommit}
              />
            </div>
          )}
        </div>
      </ChangesViewProvider>
    </ReviewProvider>
  );
});
