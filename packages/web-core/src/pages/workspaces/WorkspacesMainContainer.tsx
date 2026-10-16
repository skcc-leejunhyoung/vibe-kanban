import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Workspace, Session, RepoWithTargetBranch } from 'shared/types';
import { createWorkspaceWithSession } from '@/shared/types/attempt';
import { WorkspacesMain } from '@vibe/ui/components/WorkspacesMain';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { ContextBarContainer } from './ContextBarContainer';
import { WorkspaceStatusStripContainer } from '@/features/workspace-chat/ui/WorkspaceStatusStripContainer';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { LiveStatusProvider } from '@/features/workspace-chat/model/hooks/useLiveStatus';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { forwardWheelToScroller } from '@/features/workspace-chat/ui/forwardWheelToScroller';
import { useDiffStats } from '@/shared/stores/useWorkspaceDiffStore';

/**
 * Isolated component that reads diffStats from WorkspaceContext.
 * By pushing the context subscription down to this leaf, the parent
 * WorkspacesMainContainer (and its ConversationList child) no longer
 * rerenders when diffs/comments/repos stream in.
 */
function ChatBoxWithDiffStats({
  session,
  workspaceId,
  isNewSessionMode,
  sessions,
  onSelectSession,
  onStartNewSession,
  onScrollToPreviousMessage,
  onScrollToBottom,
  onScrollToUserMessage,
  getActiveTurnPatchKey,
  autoFocus,
}: {
  session: Session | undefined;
  workspaceId: string | undefined;
  isNewSessionMode: boolean;
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onStartNewSession: () => void;
  onScrollToPreviousMessage: () => void;
  onScrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  onScrollToUserMessage: (patchKey: string) => void;
  getActiveTurnPatchKey: () => string | null;
  autoFocus: boolean;
}) {
  const diffStats = useDiffStats();

  return (
    <SessionChatBoxContainer
      {...(isNewSessionMode && workspaceId
        ? {
            mode: 'new-session' as const,
            workspaceId,
            onSelectSession,
          }
        : session
          ? {
              mode: 'existing-session' as const,
              session,
              onSelectSession,
              onStartNewSession,
            }
          : {
              mode: 'placeholder' as const,
            })}
      sessions={sessions}
      filesChanged={diffStats.files_changed}
      linesAdded={diffStats.lines_added}
      linesRemoved={diffStats.lines_removed}
      disableViewCode={false}
      showOpenWorkspaceButton={false}
      onScrollToPreviousMessage={onScrollToPreviousMessage}
      onScrollToBottom={onScrollToBottom}
      onScrollToUserMessage={onScrollToUserMessage}
      getActiveTurnPatchKey={getActiveTurnPatchKey}
      autoFocus={autoFocus}
    />
  );
}

export interface WorkspacesMainContainerHandle {
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  scrollConversationBy: (delta: number) => boolean;
  focusComposer: () => boolean;
}

interface WorkspacesMainContainerProps {
  selectedWorkspace: Workspace | null;
  selectedSession: Session | undefined;
  selectedSessionId: string | undefined;
  sessions: Session[];
  repos: RepoWithTargetBranch[];
  onSelectSession: (sessionId: string) => void;
  isLoading: boolean;
  isSessionsLoading?: boolean;
  isNewSessionMode: boolean;
  onStartNewSession: () => void;
  autoFocus?: boolean;
}

export const WorkspacesMainContainer = forwardRef<
  WorkspacesMainContainerHandle,
  WorkspacesMainContainerProps
>(function WorkspacesMainContainer(
  {
    selectedWorkspace,
    selectedSession,
    selectedSessionId,
    sessions,
    repos,
    onSelectSession,
    isLoading,
    isSessionsLoading: _isSessionsLoading,
    isNewSessionMode,
    onStartNewSession,
    autoFocus = true,
  },
  ref
) {
  const containerRef = useRef<HTMLElement>(null);
  const conversationListRef = useRef<ConversationListHandle>(null);

  const workspaceWithSession = useMemo(() => {
    if (!selectedWorkspace) return undefined;
    return createWorkspaceWithSession(selectedWorkspace, selectedSession);
  }, [selectedWorkspace, selectedSession]);

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

  const [isAtBottom, setIsAtBottom] = useState(true);
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
  }, []);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      conversationListRef.current?.scrollToBottom(behavior);
    },
    []
  );

  const entriesProviderKey = workspaceWithSession
    ? `${workspaceWithSession.id}-${selectedSessionId ?? 'new'}`
    : 'empty';

  const conversationContent = workspaceWithSession ? (
    <div
      className="flex-1 min-h-0 overflow-hidden flex justify-center"
      onWheel={(e) => forwardWheelToScroller(e, conversationListRef)}
    >
      <div className="w-chat max-w-full h-full">
        <RetryUiProvider workspaceId={workspaceWithSession.id}>
          <ConversationList
            key={entriesProviderKey}
            ref={conversationListRef}
            attempt={workspaceWithSession}
            repos={repos}
            onAtBottomChange={handleAtBottomChange}
            sessionScopeId={selectedSessionId}
          />
        </RetryUiProvider>
      </div>
    </div>
  ) : null;

  const { session } = workspaceWithSession ?? {};

  const chatBoxContent = (
    <ChatBoxWithDiffStats
      session={session}
      workspaceId={workspaceWithSession?.id}
      isNewSessionMode={isNewSessionMode}
      sessions={sessions}
      onSelectSession={onSelectSession}
      onStartNewSession={onStartNewSession}
      onScrollToPreviousMessage={handleScrollToPreviousMessage}
      onScrollToBottom={handleScrollToBottom}
      onScrollToUserMessage={handleScrollToUserMessage}
      getActiveTurnPatchKey={handleGetActiveTurnPatchKey}
      autoFocus={autoFocus}
    />
  );

  const contextBarContent = workspaceWithSession ? (
    <ContextBarContainer containerRef={containerRef} />
  ) : null;

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior = 'smooth') => {
        conversationListRef.current?.scrollToBottom(behavior);
      },
      scrollConversationBy: (delta) =>
        conversationListRef.current?.scrollBy(delta) ?? false,
      focusComposer: () => {
        const editor = containerRef.current?.querySelector<HTMLElement>(
          '[data-chatbox-container="true"] [contenteditable="true"]'
        );
        if (!editor) return false;
        editor.focus();
        return true;
      },
    }),
    []
  );

  return (
    <ApprovalFeedbackProvider>
      <EntriesProvider key={entriesProviderKey}>
        <MessageEditProvider>
          <LiveStatusProvider>
            <WorkspacesMain
              workspaceWithSession={
                workspaceWithSession
                  ? { id: workspaceWithSession.id }
                  : undefined
              }
              isLoading={isLoading}
              containerRef={containerRef}
              conversationContent={conversationContent}
              statusContent={
                workspaceWithSession ? (
                  <WorkspaceStatusStripContainer
                    workspaceId={workspaceWithSession.id}
                    sessionId={selectedSessionId}
                  />
                ) : null
              }
              chatBoxContent={chatBoxContent}
              contextBarContent={contextBarContent}
              isAtBottom={isAtBottom}
              onAtBottomChange={handleAtBottomChange}
              onScrollToBottom={handleScrollToBottom}
            />
          </LiveStatusProvider>
        </MessageEditProvider>
      </EntriesProvider>
    </ApprovalFeedbackProvider>
  );
});
