import { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { findRemoteWorkspaceByLocalIdentity } from '@/shared/lib/workspaceHostIdentity';
import { useActions } from '@/shared/hooks/useActions';
import { useSyncErrorContext } from '@/shared/hooks/useSyncErrorContext';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import {
  Navbar,
  type NavbarSectionItem,
  type NavbarBreadcrumbItem,
  type MobileTabId,
} from '@vibe/ui/components/Navbar';
import { useAllOrganizationProjects } from '@/shared/hooks/useAllOrganizationProjects';
import { useShape } from '@/shared/integrations/electric/hooks';
import { PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import { RemoteIssueLink } from './RemoteIssueLink';
import { AppBarUserPopoverContainer } from './AppBarUserPopoverContainer';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { NavbarActionGroups } from '@/shared/actions';
import {
  NavbarDivider,
  type ActionDefinition,
  type NavbarItem as ActionNavbarItem,
  type ActionVisibilityContext,
  isSpecialIcon,
  getActionIcon,
  getActionTooltip,
  isActionActive,
  isActionEnabled,
  isActionVisible,
} from '@/shared/types/actions';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import { useMobileActiveTab } from '@/shared/stores/useUiPreferencesStore';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { useAppBarVisibilityStore } from '@/shared/stores/useAppBarVisibilityStore';
import { effectiveActionShortcut } from '@/shared/keyboard/registry';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  getProjectDestination,
  isWorkspacesDestination,
} from '@/shared/lib/routes/appNavigation';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  openDestinationForActivePane,
  useChromeTargetWorkspace,
} from '@/shared/lib/openInSplitPane';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { getRemoteAuthDegradedMessage } from '@/shared/lib/auth/remoteAuthDegraded';

/**
 * Check if a NavbarItem is a divider
 */
function isDivider(item: ActionNavbarItem): item is typeof NavbarDivider {
  return 'type' in item && item.type === 'divider';
}

/**
 * Filter navbar items by visibility, keeping dividers but removing them
 * if they would appear at the start, end, or consecutively.
 */
function filterNavbarItems(
  items: readonly ActionNavbarItem[],
  ctx: ActionVisibilityContext
): ActionNavbarItem[] {
  // Filter actions by visibility, keep dividers
  const filtered = items.filter((item) => {
    if (isDivider(item)) return true;
    if (!isActionVisible(item, ctx)) return false;
    return !isSpecialIcon(getActionIcon(item, ctx));
  });

  // Remove leading/trailing dividers and consecutive dividers
  const result: ActionNavbarItem[] = [];
  for (const item of filtered) {
    if (isDivider(item)) {
      // Only add divider if we have items before it and last item wasn't a divider
      if (result.length > 0 && !isDivider(result[result.length - 1])) {
        result.push(item);
      }
    } else {
      result.push(item);
    }
  }

  // Remove trailing divider
  if (result.length > 0 && isDivider(result[result.length - 1])) {
    result.pop();
  }

  return result;
}

function toNavbarSectionItems(
  items: readonly ActionNavbarItem[],
  ctx: ActionVisibilityContext,
  overrides: Record<string, string>,
  onExecuteAction: (action: ActionDefinition) => void
): NavbarSectionItem[] {
  return items.reduce<NavbarSectionItem[]>((result, item) => {
    if (isDivider(item)) {
      result.push({ type: 'divider' });
      return result;
    }

    const icon = getActionIcon(item, ctx);
    if (isSpecialIcon(icon)) {
      return result;
    }

    result.push({
      type: 'action',
      id: item.id,
      icon,
      isActive: isActionActive(item, ctx),
      tooltip: getActionTooltip(item, ctx),
      shortcut: effectiveActionShortcut(item.id, item.shortcut, overrides),
      disabled: !isActionEnabled(item, ctx),
      onClick: () => onExecuteAction(item),
    });
    return result;
  }, []);
}

export function NavbarContainer({
  mobileMode = false,
  onOrgSelect,
  onOpenDrawer,
}: {
  mobileMode?: boolean;
  onOrgSelect?: (orgId: string) => void;
  onOpenDrawer?: () => void;
}) {
  const { t } = useTranslation('common');
  const { executeAction } = useActions();
  const appRuntime = useAppRuntime();
  const { workspace: contextWorkspace, isCreateMode: contextIsCreateMode } =
    useWorkspaceContext();
  // The navbar mirrors and acts on the active split pane's workspace when one
  // is focused, falling back to the routed workspace.
  const chromeTargetWorkspace = useChromeTargetWorkspace();
  const { data: chromeTargetRecord } = useWorkspaceRecord(
    chromeTargetWorkspace?.workspaceId,
    {
      enabled: !!chromeTargetWorkspace,
      hostId: chromeTargetWorkspace ? chromeTargetWorkspace.hostId : undefined,
    }
  );
  const selectedWorkspace = chromeTargetWorkspace
    ? chromeTargetRecord
    : contextWorkspace;
  const isCreateMode = chromeTargetWorkspace ? false : contextIsCreateMode;
  const { workspaces } = useUserContext();
  const syncErrorContext = useSyncErrorContext();
  const { remoteAuthDegraded } = useUserSystem();
  const appNavigation = useAppNavigation();
  const destination = useCurrentAppDestination();
  const projectDestination = useMemo(
    () => getProjectDestination(destination),
    [destination]
  );
  const isOnProjectPage = projectDestination !== null;
  const projectId = projectDestination?.projectId ?? null;
  const isOnProjectSubRoute =
    projectDestination !== null && projectDestination.kind !== 'project';
  // Standalone pages (Notifications, Pull Requests, Export) are neither project
  // nor workspace destinations. They render their own page headers, so the
  // mobile workspace tabs (Chat/Diff/Logs…) and the workspace title bar are
  // out of place there and must be suppressed.
  const isWorkspacesDest = isWorkspacesDestination(destination);
  const [mobileActiveTab, setMobileActiveTab] = useMobileActiveTab();
  const workspaceHostId = useHostId();

  // Find remote workspace linked to current local workspace
  const effectiveWorkspaceHostId = chromeTargetWorkspace
    ? chromeTargetWorkspace.hostId
    : workspaceHostId;
  const linkedRemoteWorkspace = useMemo(() => {
    if (!selectedWorkspace?.id) return null;
    return (
      findRemoteWorkspaceByLocalIdentity(
        workspaces,
        selectedWorkspace.id,
        effectiveWorkspaceHostId
      ) ?? null
    );
  }, [workspaces, selectedWorkspace?.id, effectiveWorkspaceHostId]);

  const { data: orgsData } = useUserOrganizations();
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const orgName =
    orgsData?.organizations.find((o) => o.id === selectedOrgId)?.name ?? '';

  // Get action visibility context (includes all state for visibility/active/enabled)
  const actionCtx = useActionVisibilityContext();

  // Subscribe to keyboard overrides so tooltip shortcut hints reflect rebinds.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const isAppBarVisible = useAppBarVisibilityStore((s) => s.isVisible);

  // Action handler - all actions go through the standard executeAction.
  // Workspace-targeted actions act on the active split pane's workspace when
  // one is focused, falling back to the routed workspace.
  const targetWorkspaceId =
    chromeTargetWorkspace?.workspaceId ?? selectedWorkspace?.id;
  const handleExecuteAction = useCallback(
    (action: ActionDefinition) => {
      if (action.requiresTarget && targetWorkspaceId) {
        executeAction(
          action,
          targetWorkspaceId,
          undefined,
          undefined,
          chromeTargetWorkspace ? chromeTargetWorkspace.hostId : undefined
        );
      } else {
        executeAction(action);
      }
    },
    [executeAction, targetWorkspaceId, chromeTargetWorkspace]
  );

  const leftItems = useMemo(
    () =>
      toNavbarSectionItems(
        filterNavbarItems(NavbarActionGroups.left, actionCtx),
        actionCtx,
        overrides,
        handleExecuteAction
      ),
    [actionCtx, overrides, handleExecuteAction]
  );

  const rightItems = useMemo(
    () =>
      toNavbarSectionItems(
        filterNavbarItems(NavbarActionGroups.right, actionCtx),
        actionCtx,
        overrides,
        handleExecuteAction
      ),
    [actionCtx, overrides, handleExecuteAction, isAppBarVisible]
  );

  const navbarTitle = isCreateMode
    ? 'Create Workspace'
    : isOnProjectPage
      ? orgName
      : isWorkspacesDest
        ? selectedWorkspace?.branch
        : undefined;

  // Breadcrumbs: Project / Issue / Workspace (only on workspace pages with linked project)
  const linkedProjectId = linkedRemoteWorkspace?.project_id ?? null;
  const linkedIssueId = linkedRemoteWorkspace?.issue_id ?? null;
  const shouldResolveBreadcrumbData =
    !isOnProjectPage && !isCreateMode && isWorkspacesDest && !!linkedProjectId;
  const shouldResolveIssueBreadcrumb =
    shouldResolveBreadcrumbData && !!linkedIssueId;

  const { data: allProjects, isLoading: isProjectsLoading } =
    useAllOrganizationProjects({
      enabled: shouldResolveBreadcrumbData,
    });
  const { data: projectIssues, isLoading: isProjectIssuesLoading } = useShape(
    PROJECT_ISSUES_SHAPE,
    { project_id: linkedProjectId || '' },
    { enabled: shouldResolveIssueBreadcrumb }
  );
  const linkedProject = allProjects.find((p) => p.id === linkedProjectId);
  const isWaitingForProjectBreadcrumb =
    shouldResolveBreadcrumbData && !linkedProject && isProjectsLoading;
  const isWaitingForIssueBreadcrumb =
    shouldResolveIssueBreadcrumb && isProjectIssuesLoading;
  const isWaitingForBreadcrumbData =
    isWaitingForProjectBreadcrumb || isWaitingForIssueBreadcrumb;

  const breadcrumbs = useMemo((): NavbarBreadcrumbItem[] | undefined => {
    if (
      !shouldResolveBreadcrumbData ||
      !linkedProjectId ||
      isWaitingForBreadcrumbData
    ) {
      return undefined;
    }

    const project = linkedProject;
    if (!project) return undefined;

    const items: NavbarBreadcrumbItem[] = [
      {
        label: project.name,
        onClick: () =>
          openDestinationForActivePane(
            { kind: 'project', projectId: linkedProjectId },
            appNavigation,
            appRuntime,
            () => appNavigation.goToProject(linkedProjectId)
          ),
      },
    ];

    if (linkedIssueId) {
      const issue = projectIssues.find((i) => i.id === linkedIssueId);
      if (issue) {
        items.push({
          label: issue.simple_id,
          onClick: () =>
            openDestinationForActivePane(
              {
                kind: 'project-issue',
                projectId: linkedProjectId,
                issueId: linkedIssueId,
              },
              appNavigation,
              appRuntime,
              () =>
                appNavigation.goToProjectIssue(linkedProjectId, linkedIssueId)
            ),
        });
      }
    }

    const workspaceLabel =
      selectedWorkspace?.name || selectedWorkspace?.branch || '';
    if (workspaceLabel) {
      items.push({ label: workspaceLabel });
    }

    return items.length > 1 ? items : undefined;
  }, [
    shouldResolveBreadcrumbData,
    linkedProjectId,
    linkedIssueId,
    linkedProject,
    isWaitingForBreadcrumbData,
    projectIssues,
    selectedWorkspace?.name,
    selectedWorkspace?.branch,
    appNavigation,
    appRuntime,
  ]);

  // Mobile-specific callbacks
  const handleOpenCommandBar = useCallback(() => {
    CommandBarDialog.show();
  }, []);

  const handleOpenSettings = useCallback(() => {
    SettingsDialog.show();
  }, []);

  const handleNavigateBack = useCallback(() => {
    if (isOnProjectPage && projectId) {
      // On project sub-route: go back to project root (kanban board)
      appNavigation.goToProject(projectId);
    } else {
      // Non-project page: go to workspaces
      appNavigation.goToWorkspaces();
    }
  }, [isOnProjectPage, projectId, appNavigation]);

  const handleNavigateToBoard = useMemo(() => {
    if (!isOnProjectPage || !projectId) return null;
    return () => {
      appNavigation.goToProject(projectId);
    };
  }, [isOnProjectPage, projectId, appNavigation]);

  // Build user popover slot for mobile mode
  const userPopoverSlot = useMemo(() => {
    if (!mobileMode) return undefined;
    return (
      <AppBarUserPopoverContainer
        organizations={orgsData?.organizations ?? []}
        selectedOrgId={selectedOrgId ?? ''}
        onOrgSelect={onOrgSelect ?? (() => {})}
      />
    );
  }, [mobileMode, orgsData?.organizations, selectedOrgId, onOrgSelect]);

  const syncErrors = useMemo(() => {
    const errors = syncErrorContext?.errors ? [...syncErrorContext.errors] : [];

    if (remoteAuthDegraded) {
      errors.push({
        streamId: 'remote-auth-degraded',
        tableName: 'Remote authentication',
        error: {
          message: getRemoteAuthDegradedMessage(remoteAuthDegraded, t),
        },
        retry: () => window.location.reload(),
      });
    }

    return errors;
  }, [remoteAuthDegraded, syncErrorContext?.errors, t]);

  return (
    <Navbar
      workspaceTitle={navbarTitle}
      breadcrumbs={breadcrumbs}
      leftItems={leftItems}
      rightItems={rightItems}
      syncErrors={syncErrors}
      mobileMode={mobileMode}
      mobileUserSlot={userPopoverSlot}
      isOnProjectPage={isOnProjectPage}
      isOnProjectSubRoute={isOnProjectSubRoute}
      onOpenCommandBar={handleOpenCommandBar}
      onOpenSettings={handleOpenSettings}
      onNavigateBack={handleNavigateBack}
      onNavigateToBoard={handleNavigateToBoard}
      onOpenDrawer={onOpenDrawer}
      mobileActiveTab={mobileActiveTab as MobileTabId}
      onMobileTabChange={(tab) => setMobileActiveTab(tab)}
      showMobileTabs={isWorkspacesDest}
      leftSlot={
        isWorkspacesDest &&
        !breadcrumbs &&
        !isWaitingForBreadcrumbData &&
        linkedRemoteWorkspace?.issue_id ? (
          <RemoteIssueLink
            projectId={linkedRemoteWorkspace.project_id}
            issueId={linkedRemoteWorkspace.issue_id}
          />
        ) : null
      }
    />
  );
}
