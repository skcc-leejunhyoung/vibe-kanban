import {
  GearIcon,
  GitBranchIcon,
  BuildingsIcon,
  CloudIcon,
  CpuIcon,
  PlugIcon,
  BroadcastIcon,
  BellIcon,
  KeyboardIcon,
  RobotIcon,
  DownloadSimpleIcon,
  UserCircleIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { GeneralSettingsSection } from './GeneralSettingsSection';
import { ReposSettingsSection } from './ReposSettingsSection';
import { OrganizationsSettingsSection } from './OrganizationsSettingsSection';
import { RemoteProjectsSettingsSection } from './RemoteProjectsSettingsSection';
import { AgentsSettingsSection } from './AgentsSettingsSection';
import { McpSettingsSection } from './McpSettingsSection';
import { RelaySettingsSectionContent } from './RelaySettingsSection';
import { AccountNotificationsSettingsSection } from './AccountNotificationsSettingsSection';
import { KeyboardShortcutsSettingsSection } from './KeyboardShortcutsSettingsSection';
import { AutomationSettingsSection } from './AutomationSettingsSection';
import { ExportPageContainer } from '@/pages/export/ExportPage';
import { AccountSettingsSection } from './AccountSettingsSection';

export type SettingsSectionType =
  | 'general'
  | 'repos'
  | 'organizations'
  | 'account'
  | 'notifications'
  | 'remote-projects'
  | 'agents'
  | 'mcp'
  | 'relay'
  | 'keyboard-shortcuts'
  | 'automation'
  | 'export';

export type SettingsSectionGroup = 'host' | 'universal';

export type SettingsSectionInitialState = {
  general: undefined;
  repos: { repoId?: string } | undefined;
  organizations: { organizationId?: string } | undefined;
  account: undefined;
  notifications: undefined;
  'remote-projects':
    | { organizationId?: string; projectId?: string }
    | undefined;
  agents: { executor?: string; variant?: string } | undefined;
  mcp: undefined;
  relay: { hostId?: string; accountId?: string } | undefined;
  'keyboard-shortcuts': undefined;
  automation: undefined;
  export: undefined;
};

export interface SettingsSectionDefinition {
  id: SettingsSectionType;
  icon: Icon;
  group: SettingsSectionGroup;
}

export const SETTINGS_SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  { id: 'general', icon: GearIcon, group: 'host' },
  { id: 'repos', icon: GitBranchIcon, group: 'host' },
  { id: 'agents', icon: CpuIcon, group: 'host' },
  { id: 'mcp', icon: PlugIcon, group: 'host' },
  { id: 'automation', icon: RobotIcon, group: 'host' },
  { id: 'organizations', icon: BuildingsIcon, group: 'universal' },
  { id: 'account', icon: UserCircleIcon, group: 'universal' },
  { id: 'notifications', icon: BellIcon, group: 'universal' },
  { id: 'keyboard-shortcuts', icon: KeyboardIcon, group: 'universal' },
  { id: 'remote-projects', icon: CloudIcon, group: 'universal' },
  { id: 'relay', icon: BroadcastIcon, group: 'universal' },
  { id: 'export', icon: DownloadSimpleIcon, group: 'universal' },
];

export function isHostSpecificSettingsSection(
  type: SettingsSectionType
): boolean {
  return (
    SETTINGS_SECTION_DEFINITIONS.find((section) => section.id === type)
      ?.group === 'host'
  );
}

export function renderSettingsSection(
  type: SettingsSectionType,
  initialState?: SettingsSectionInitialState[SettingsSectionType],
  onClose?: () => void,
  onNavigate?: (section: SettingsSectionType) => void
) {
  switch (type) {
    case 'general':
      return <GeneralSettingsSection />;
    case 'repos':
      return (
        <ReposSettingsSection
          initialState={initialState as SettingsSectionInitialState['repos']}
        />
      );
    case 'organizations':
      return <OrganizationsSettingsSection />;
    case 'account':
      return <AccountSettingsSection />;
    case 'notifications':
      return <AccountNotificationsSettingsSection />;
    case 'remote-projects':
      return (
        <RemoteProjectsSettingsSection
          initialState={
            initialState as SettingsSectionInitialState['remote-projects']
          }
        />
      );
    case 'agents':
      return <AgentsSettingsSection />;
    case 'mcp':
      return <McpSettingsSection />;
    case 'relay':
      return (
        <RelaySettingsSectionContent
          initialState={initialState as SettingsSectionInitialState['relay']}
          onClose={onClose}
          onOpenAccount={onNavigate ? () => onNavigate('account') : undefined}
        />
      );
    case 'keyboard-shortcuts':
      return <KeyboardShortcutsSettingsSection />;
    case 'automation':
      return <AutomationSettingsSection />;
    case 'export':
      return <ExportPageContainer embedded />;
    default:
      return <GeneralSettingsSection />;
  }
}
