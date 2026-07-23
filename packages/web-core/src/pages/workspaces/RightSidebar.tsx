import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTreeContainer } from './FileTreeContainer';
import { ProcessListContainer } from './ProcessListContainer';
import { PreviewControlsContainer } from './PreviewControlsContainer';
import { GitPanelContainer } from './GitPanelContainer';
import { PrPanelContainer, hasLinkedPr } from './PrPanelContainer';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { TerminalPanelContainer } from '@/shared/components/TerminalPanelContainer';
import { WorkspaceNotesContainer } from './WorkspaceNotesContainer';
import { CommitsPanelContainer } from './CommitsPanelContainer';
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import { ArrowsOutSimpleIcon, DesktopTowerIcon } from '@phosphor-icons/react';
import { useLogsPanel } from '@/shared/hooks/useLogsPanel';
import type { RepoWithTargetBranch, Workspace } from 'shared/types';
import {
  PERSIST_KEYS,
  PersistKey,
  RIGHT_MAIN_PANEL_MODES,
  type RightMainPanelMode,
  usePersistedExpanded,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from '@vibe/ui/components/CollapsibleSectionHeader';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { resolveWorkspaceHostPresentation } from '@/shared/lib/workspaceHostPresentation';
import { cn } from '@/shared/lib/utils';
import type { RightSidebarSectionId } from '@/shared/lib/rightSidebarSections';

type SectionDef = {
  id: RightSidebarSectionId | 'active';
  title: string;
  persistKey: PersistKey;
  visible: boolean;
  expanded: boolean;
  content: React.ReactNode;
  actions: SectionAction[];
};

export interface RightSidebarProps {
  rightMainPanelMode: RightMainPanelMode | null;
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
  onOpenCommit: () => void;
}

export const RightSidebar = memo(function RightSidebar({
  rightMainPanelMode,
  selectedWorkspace,
  repos,
  onOpenCommit,
}: RightSidebarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { config } = useUserSystem();
  const hostId = useHostId();
  const { hosts } = useWorkspaceHostOptions();
  const diffs = useDiffs();
  const { data: branchStatus } = useBranchStatus(selectedWorkspace?.id);
  const hasPrs = hasLinkedPr(branchStatus);
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);
  const sectionOrder = useUiPreferencesStore((s) => s.rightSidebarSectionOrder);
  const { expandTerminal, isTerminalExpanded } = useLogsPanel();
  const { name: hostName, status: hostStatus } =
    resolveWorkspaceHostPresentation(
      hostId,
      config?.host_nickname,
      hosts,
      t('common:workspaces.thisMachine', { defaultValue: 'This machine' })
    );

  const [changesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.changesSection,
    true
  );
  const [processesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.processesSection,
    true
  );
  const [devServerExpanded] = usePersistedExpanded(
    PERSIST_KEYS.devServerSection,
    true
  );
  const [gitExpanded] = usePersistedExpanded(
    PERSIST_KEYS.gitPanelRepositories,
    true
  );
  const [commitsExpanded] = usePersistedExpanded(
    PERSIST_KEYS.commitsSection,
    true
  );
  const [prExpanded] = usePersistedExpanded(
    PERSIST_KEYS.pullRequestsSection,
    true
  );
  const [terminalExpanded] = usePersistedExpanded(
    PERSIST_KEYS.terminalSection,
    false
  );
  const [notesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.notesSection,
    false
  );

  const hasUpperContent =
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES ||
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS ||
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW;

  const upperExpanded = (() => {
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES)
      return changesExpanded;
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS)
      return processesExpanded;
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW)
      return devServerExpanded;
    return false;
  })();

  const sections: SectionDef[] = useMemo(() => {
    const result: SectionDef[] = [
      {
        id: 'pullRequests',
        title: 'Pull Requests',
        persistKey: PERSIST_KEYS.pullRequestsSection,
        visible: hasPrs,
        expanded: prExpanded,
        content: (
          <PrPanelContainer
            selectedWorkspace={selectedWorkspace}
            repos={repos}
          />
        ),
        actions: [],
      },
      {
        id: 'git',
        title: 'Git',
        persistKey: PERSIST_KEYS.gitPanelRepositories,
        visible: true,
        expanded: gitExpanded,
        content: (
          <GitPanelContainer
            selectedWorkspace={selectedWorkspace}
            repos={repos}
          />
        ),
        actions: [],
      },
      {
        id: 'commits',
        title: 'Commits',
        persistKey: PERSIST_KEYS.commitsSection,
        visible: !!selectedWorkspace,
        expanded: commitsExpanded,
        content: selectedWorkspace ? (
          <CommitsPanelContainer
            workspaceId={selectedWorkspace.id}
            onOpenCommit={onOpenCommit}
          />
        ) : null,
        actions: [],
      },
      {
        id: 'terminal',
        title: 'Terminal',
        persistKey: PERSIST_KEYS.terminalSection,
        visible: isTerminalVisible && !isTerminalExpanded,
        expanded: terminalExpanded,
        content: <TerminalPanelContainer />,
        actions: [{ icon: ArrowsOutSimpleIcon, onClick: expandTerminal }],
      },
      {
        id: 'notes',
        title: t('common:sections.notes'),
        persistKey: PERSIST_KEYS.notesSection,
        visible: true,
        expanded: notesExpanded,
        content: <WorkspaceNotesContainer />,
        actions: [],
      },
    ];

    switch (rightMainPanelMode) {
      case RIGHT_MAIN_PANEL_MODES.CHANGES:
        if (selectedWorkspace) {
          result.unshift({
            id: 'active',
            title: 'Changes',
            persistKey: PERSIST_KEYS.changesSection,
            visible: hasUpperContent,
            expanded: upperExpanded,
            content: (
              <FileTreeContainer
                key={selectedWorkspace.id}
                workspaceId={selectedWorkspace.id}
                diffs={diffs}
                className=""
              />
            ),
            actions: [],
          });
        }
        break;
      case RIGHT_MAIN_PANEL_MODES.LOGS:
        result.unshift({
          id: 'active',
          title: 'Logs',
          persistKey: PERSIST_KEYS.rightPanelprocesses,
          visible: hasUpperContent,
          expanded: upperExpanded,
          content: <ProcessListContainer />,
          actions: [],
        });
        break;
      case RIGHT_MAIN_PANEL_MODES.PREVIEW:
        if (selectedWorkspace) {
          result.unshift({
            id: 'active',
            title: 'Preview',
            persistKey: PERSIST_KEYS.rightPanelPreview,
            visible: hasUpperContent,
            expanded: upperExpanded,
            content: (
              <PreviewControlsContainer
                workspaceId={selectedWorkspace.id}
                className=""
              />
            ),
            actions: [],
          });
        }
        break;
      case null:
        break;
    }

    const orderById = new Map(
      sectionOrder.map((section, index) => [section, index])
    );
    return result.sort((a, b) => {
      if (a.id === 'active') return -1;
      if (b.id === 'active') return 1;
      return (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0);
    });
  }, [
    rightMainPanelMode,
    selectedWorkspace,
    repos,
    diffs,
    gitExpanded,
    commitsExpanded,
    prExpanded,
    hasPrs,
    terminalExpanded,
    notesExpanded,
    changesExpanded,
    processesExpanded,
    devServerExpanded,
    isTerminalVisible,
    isTerminalExpanded,
    hasUpperContent,
    upperExpanded,
    expandTerminal,
    onOpenCommit,
    sectionOrder,
    t,
  ]);

  return (
    <div className="h-full border-l bg-secondary overflow-y-auto">
      {selectedWorkspace && (
        <div className="border-b bg-panel/60 px-base py-base">
          <p className="mb-half text-xs font-medium uppercase tracking-wide text-low">
            {t('common:sections.host')}
          </p>
          <div className="flex items-center gap-base">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-sm"
              style={{
                color: config?.primary_color,
                backgroundColor: config?.primary_color
                  ? `${config.primary_color}20`
                  : undefined,
              }}
            >
              <DesktopTowerIcon className="size-icon-base" weight="fill" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-high">
                {hostName}
              </p>
              <p className="flex items-center gap-half text-xs text-low">
                <span
                  className={cn(
                    'size-2 rounded-full',
                    hostStatus === 'online'
                      ? 'bg-success'
                      : hostStatus === 'offline'
                        ? 'bg-low'
                        : 'bg-warning'
                  )}
                />
                {t(`common:workspaces.hostStatus.${hostStatus}`, {
                  defaultValue: hostStatus,
                })}
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="divide-y border-b">
        {sections
          .filter((section) => section.visible)
          .map((section) => (
            <div
              key={section.persistKey}
              className="max-h-[max(50vh,400px)] flex flex-col overflow-hidden"
            >
              <CollapsibleSectionHeader
                title={section.title}
                persistKey={section.persistKey}
                defaultExpanded={section.expanded}
                actions={section.actions}
              >
                <div className="flex flex-1 border-t min-h-[200px] w-full overflow-auto">
                  {section.content}
                </div>
              </CollapsibleSectionHeader>
            </div>
          ))}
      </div>
    </div>
  );
});
