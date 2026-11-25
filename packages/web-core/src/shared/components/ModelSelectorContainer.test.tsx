import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BaseCodingAgent,
  PermissionPolicy,
  type ExecutorConfig,
  type ExecutorProfile,
  type ModelSelectorConfig,
} from 'shared/types';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import {
  applyModelConfigToProfile,
  profileToExecutorConfig,
} from '@/shared/lib/profileModelConfig';
import { ModelSelectorContainer } from './ModelSelectorContainer';
import { composerSlashCommandOverrides } from '@/shared/lib/composerSlashCommands';

const modelConfig: ModelSelectorConfig = {
  providers: [],
  models: [
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider_id: null,
      supports_fast: true,
      reasoning_options: [
        { id: 'low', label: 'Low', is_default: false },
        { id: 'medium', label: 'Medium', is_default: true },
        { id: 'high', label: 'High', is_default: false },
      ],
    },
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      provider_id: null,
      supports_fast: false,
      reasoning_options: [],
    },
  ],
  default_model: 'gpt-5.5',
  agents: [],
  permissions: [],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const discovery = vi.hoisted(() => ({
  error: null as string | null,
  config: null as ModelSelectorConfig | null,
}));
vi.mock('@/shared/hooks/useExecutorDiscovery', () => ({
  useModelSelectorConfig: () => ({
    config: discovery.error
      ? { ...modelConfig, models: [] }
      : (discovery.config ?? modelConfig),
    loadingModels: false,
    error: discovery.error,
  }),
}));
vi.mock('@/shared/hooks/usePresetOptions', () => ({
  usePresetOptions: () => ({ data: null }),
}));
// Per-host user systems, keyed by host id (`null` = this machine).
const hostSystems = vi.hoisted(() => ({
  byHost: new Map<
    string | null,
    {
      profiles: unknown;
      profilesRevision: string | null;
      setProfiles: (...args: unknown[]) => void;
      reloadSystem: () => void;
    }
  >(),
  contextHostId: null as string | null,
}));
vi.mock('@/shared/hooks/useHostUserSystem', () => ({
  useHostUserSystem: (hostId: string | null) => ({
    value: hostSystems.byHost.get(hostId) ?? {
      profiles: null,
      profilesRevision: null,
      setProfiles: vi.fn(),
      reloadSystem: vi.fn(),
    },
  }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => hostSystems.contextHostId,
}));
vi.mock('@/shared/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' }),
  getResolvedTheme: () => 'light',
}));
const updateRecentModels = vi.hoisted(() =>
  vi.fn(async () => ({ content: '', path: '', revision: 'saved' }))
);
vi.mock('@/shared/lib/api', () => ({
  isLegacyUnversionedRevision: () => false,
  profilesApi: { updateRecentModels },
}));

// Render no DOM: capture the popover props and dropdown item handlers instead.
type PopoverProps = {
  error?: string | null;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  groupByProvider: boolean;
  onGroupByProviderChange: (checked: boolean) => void;
  onModelSelect: (id: string, providerId?: string) => void;
  onReasoningSelect: (id: string | null) => void;
  onOpenChange: (open: boolean) => void;
};
let popover: PopoverProps;
const menuItems = new Map<string, () => void>();
vi.mock('@vibe/ui/components/ModelSelectorPopover', () => ({
  ModelSelectorPopover: (props: PopoverProps) => {
    popover = props;
    return null;
  },
}));
vi.mock('@vibe/ui/components/Dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: string;
    onClick: () => void;
  }) => {
    menuItems.set(children, onClick);
    return null;
  },
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTriggerButton: () => null,
  DropdownTriggerButton: () => null,
}));

const profiles = {
  [BaseCodingAgent.CODEX]: { DEFAULT: { CODEX: {} } },
} as unknown as Record<string, ExecutorProfile>;

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), { nodeType: 9, activeElement: null })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  root = createRoot(container as unknown as HTMLElement);
  useUiPreferencesStore.setState({ expanded: {} });
  menuItems.clear();
  discovery.error = null;
  discovery.config = null;
  hostSystems.byHost.clear();
  hostSystems.contextHostId = null;
  updateRecentModels.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

const click = (label: string) => act(() => menuItems.get(label)!());

describe.each([BaseCodingAgent.OPENCODE_V2, BaseCodingAgent.ZCODE])(
  '%s default model reasoning',
  (agent) => {
    it('sends the actual default provider and model with the chosen effort', async () => {
      discovery.config = {
        ...modelConfig,
        providers: [
          { id: 'first', name: 'First' },
          { id: 'second', name: 'Second' },
        ],
        models: [
          { ...modelConfig.models[0], id: 'other', provider_id: 'first' },
          { ...modelConfig.models[0], id: 'default', provider_id: 'second' },
        ],
        default_model: 'second/default',
      };
      const onChange = vi.fn();
      await act(() =>
        root.render(
          <ModelSelectorContainer
            agent={agent}
            workspaceId={undefined}
            presets={[]}
            selectedPreset={null}
            executorConfig={{ executor: agent }}
            presetOptions={null}
            onOverrideChange={onChange}
          />
        )
      );
      expect(popover.selectedModelId).toBe('default');
      await act(() => popover.onReasoningSelect('high'));
      expect(onChange).toHaveBeenCalledWith({
        model_id: 'second/default',
        reasoning_id: 'high',
      });
    });
  }
);

describe('ModelSelectorContainer with session overrides', () => {
  let current: ExecutorConfig | null = null;
  let applyCommand: (prompt: string) => void;
  const persisted: ExecutorConfig[] = [];
  function Chat({ lastUsed }: { lastUsed: ExecutorConfig }) {
    const ec = useExecutorConfig({
      profiles,
      lastUsedConfig: lastUsed,
      onPersist: (config) => persisted.push(config),
    });
    current = ec.executorConfig;
    applyCommand = (prompt) => {
      const overrides = composerSlashCommandOverrides(
        prompt,
        ec.executorConfig!,
        ec.modelSelectorConfig
      );
      if (overrides) ec.setOverrides(overrides);
    };
    return (
      <ModelSelectorContainer
        agent={ec.effectiveExecutor}
        workspaceId={undefined}
        presets={ec.variantOptions}
        selectedPreset={ec.selectedVariant}
        onOverrideChange={ec.setOverrides}
        executorConfig={ec.executorConfig}
        presetOptions={ec.presetOptions}
      />
    );
  }

  const lastUsed: ExecutorConfig = {
    executor: BaseCodingAgent.CODEX,
    variant: 'DEFAULT',
    model_id: 'gpt-5.5',
    reasoning_id: 'high',
  };

  it('persists slash command settings and reflects them in the same selector state', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    await act(() => applyCommand('/plan on'));
    expect(current?.permission_policy).toBe(PermissionPolicy.PLAN);
    await act(() => applyCommand('/reasoning low'));
    expect(popover.selectedReasoningId).toBe('low');
    await act(() => applyCommand('/model synthetic-model'));
    expect(current).toMatchObject({
      model_id: 'synthetic-model',
      reasoning_id: null,
    });
    expect(persisted.at(-1)).toMatchObject({
      model_id: 'synthetic-model',
      reasoning_id: null,
      permission_policy: PermissionPolicy.PLAN,
    });
  });

  it('exposes an actionable discovery error with an empty model catalogue', async () => {
    discovery.error = 'Install the agent on the execution host.';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await act(() => root.render(<Chat lastUsed={lastUsed} />));
      expect(popover.error).toBe(discovery.error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the effort when Fast is toggled on and off', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    expect(popover.selectedReasoningId).toBe('high');

    await click('modelSelector.fastOn');
    expect(current).toMatchObject({
      model_id: 'gpt-5.5-fast',
      reasoning_id: 'high',
    });
    expect(popover.selectedReasoningId).toBe('high');

    await click('modelSelector.fastOff');
    expect(current).toMatchObject({
      model_id: 'gpt-5.5',
      reasoning_id: 'high',
    });
  });

  it('restores Claude auto effort after a new composer mount', async () => {
    const claude = {
      executor: BaseCodingAgent.CLAUDE_CODE,
      model_id: 'synthetic-claude',
      reasoning_id: 'high',
    };
    await act(() => root.render(<Chat lastUsed={claude} />));
    await act(() => applyCommand('/effort auto'));
    expect(current).toMatchObject({
      model_id: 'synthetic-claude',
      reasoning_id: 'auto',
    });
    const saved = persisted.at(-1)!;
    await act(() => root.render(null));
    await act(() => root.render(<Chat lastUsed={saved} />));
    expect(current?.reasoning_id).toBe('auto');
    await act(() => applyCommand('/settings effort=low model=synthetic-next'));
    expect(current).toMatchObject({
      model_id: 'synthetic-next',
      reasoning_id: 'low',
    });
  });

  it('persists slash Fast changes and restores them when the composer remounts', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    await act(() => applyCommand('/fast on'));
    expect(current).toMatchObject({
      model_id: 'gpt-5.5-fast',
      reasoning_id: 'high',
    });
    await act(() => applyCommand('/fast off'));
    const saved = persisted.at(-1)!;
    expect(saved).toMatchObject({ model_id: 'gpt-5.5', reasoning_id: 'high' });
    await act(() => root.render(null));
    await act(() => root.render(<Chat lastUsed={saved} />));
    expect(current).toMatchObject({
      model_id: 'gpt-5.5',
      reasoning_id: 'high',
    });
  });

  it('keeps Fast and effort when the current model is re-picked', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    await click('modelSelector.fastOn');

    await act(() => popover.onModelSelect('gpt-5.5', undefined));
    expect(current).toMatchObject({
      model_id: 'gpt-5.5-fast',
      reasoning_id: 'high',
    });
  });

  it('remembers the model grouping preference across selector mounts', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    expect(popover.groupByProvider).toBe(true);

    await act(() => popover.onGroupByProviderChange(false));
    await act(() => root.render(null));
    await act(() => root.render(<Chat lastUsed={lastUsed} />));

    expect(popover.groupByProvider).toBe(false);
    expect(current).toEqual(lastUsed);
  });
});

describe('ModelSelectorContainer with a Settings profile', () => {
  let profile: Record<string, unknown> = {};
  function Settings() {
    return (
      <ModelSelectorContainer
        agent={BaseCodingAgent.CODEX}
        workspaceId={undefined}
        presets={[]}
        selectedPreset={null}
        presetOptions={null}
        persistRecent={false}
        executorConfig={profileToExecutorConfig(
          BaseCodingAgent.CODEX,
          'DEFAULT',
          profile
        )}
        onOverrideChange={(partial) => {
          profile = applyModelConfigToProfile(
            BaseCodingAgent.CODEX,
            profile,
            partial
          );
        }}
      />
    );
  }

  it('keeps a stored effort across the Fast toggle', async () => {
    profile = { model: 'gpt-5.5', model_reasoning_effort: 'high' };
    await act(() => root.render(<Settings />));
    await click('modelSelector.fastOn');
    expect(profile).toEqual({
      model: 'gpt-5.5-fast',
      model_reasoning_effort: 'high',
    });
  });

  it('does not pin the displayed default effort into the profile', async () => {
    profile = { model: 'gpt-5.5' };
    await act(() => root.render(<Settings />));
    expect(popover.selectedReasoningId).toBe('medium');
    await click('modelSelector.fastOn');
    expect(profile).toEqual({ model: 'gpt-5.5-fast' });
  });
});

describe('ModelSelectorContainer recently-used models', () => {
  const setProfilesA = vi.fn();
  const setProfilesB = vi.fn();
  function Picker({ hostId }: { hostId?: string | null }) {
    return (
      <ModelSelectorContainer
        agent={BaseCodingAgent.CODEX}
        workspaceId={undefined}
        hostId={hostId}
        presets={[]}
        selectedPreset={null}
        presetOptions={null}
        executorConfig={null}
        onOverrideChange={() => {}}
      />
    );
  }
  beforeEach(() => {
    setProfilesA.mockClear();
    setProfilesB.mockClear();
    hostSystems.byHost.set(null, {
      profiles,
      profilesRevision: 'profiles-this-machine',
      setProfiles: setProfilesA,
      reloadSystem: vi.fn(),
    });
    hostSystems.byHost.set('host-b', {
      profiles,
      profilesRevision: 'profiles-host-b',
      setProfiles: setProfilesB,
      reloadSystem: vi.fn(),
    });
  });
  async function pickModel() {
    await act(() => popover.onOpenChange(true));
    // Not the default model: re-picking the current one saves nothing.
    await act(() => popover.onModelSelect('gpt-5.4', undefined));
    await act(async () => {
      popover.onOpenChange(false);
      await Promise.resolve();
    });
  }

  it('saves a pick for an explicit host with that host’s revision, whatever host surrounds it', async () => {
    // The surrounding scope (document or pane) is on this machine.
    hostSystems.contextHostId = null;
    await act(() => root.render(<Picker hostId="host-b" />));
    await pickModel();
    expect(updateRecentModels).toHaveBeenCalledExactlyOnceWith(
      BaseCodingAgent.CODEX,
      expect.anything(),
      'profiles-host-b',
      'host-b'
    );
    expect(setProfilesB).toHaveBeenCalled();
    expect(setProfilesA).not.toHaveBeenCalled();
  });

  it('saves a pick for this machine under a scope that is on another host', async () => {
    hostSystems.contextHostId = 'host-b';
    await act(() => root.render(<Picker hostId={null} />));
    await pickModel();
    expect(updateRecentModels).toHaveBeenCalledExactlyOnceWith(
      BaseCodingAgent.CODEX,
      expect.anything(),
      'profiles-this-machine',
      null
    );
    expect(setProfilesA).toHaveBeenCalled();
    expect(setProfilesB).not.toHaveBeenCalled();
  });

  it('follows the surrounding scope when no host is given', async () => {
    hostSystems.contextHostId = 'host-b';
    await act(() => root.render(<Picker />));
    await pickModel();
    expect(updateRecentModels).toHaveBeenCalledExactlyOnceWith(
      BaseCodingAgent.CODEX,
      expect.anything(),
      'profiles-host-b',
      'host-b'
    );
  });
});
