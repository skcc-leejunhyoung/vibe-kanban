import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BaseCodingAgent,
  type ExecutorConfig,
  type ExecutorProfile,
  type ModelSelectorConfig,
} from 'shared/types';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import {
  applyModelConfigToProfile,
  profileToExecutorConfig,
} from '@/shared/lib/profileModelConfig';
import { ModelSelectorContainer } from './ModelSelectorContainer';

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
  ],
  default_model: 'gpt-5.5',
  agents: [],
  permissions: [],
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/hooks/useExecutorDiscovery', () => ({
  useModelSelectorConfig: () => ({
    config: modelConfig,
    loadingModels: false,
    error: null,
  }),
}));
vi.mock('@/shared/hooks/usePresetOptions', () => ({
  usePresetOptions: () => ({ data: null }),
}));
vi.mock('@/shared/hooks/useUserSystem', () => ({
  useUserSystem: () => ({
    profiles: null,
    profilesRevision: null,
    setProfiles: vi.fn(),
    reloadSystem: vi.fn(),
  }),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({ useHostId: () => null }));
vi.mock('@/shared/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' }),
  getResolvedTheme: () => 'light',
}));
vi.mock('@/shared/stores/useUiPreferencesStore', () => ({
  useHiddenModels: () => ({ hiddenKeys: new Set(), isHidden: () => false }),
}));
vi.mock('@/shared/lib/api', () => ({
  isLegacyUnversionedRevision: () => false,
  profilesApi: {},
}));

// Render no DOM: capture the popover props and dropdown item handlers instead.
type PopoverProps = {
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  onModelSelect: (id: string, providerId?: string) => void;
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
  menuItems.clear();
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

const click = (label: string) => act(() => menuItems.get(label)!());

describe('ModelSelectorContainer with session overrides', () => {
  let current: ExecutorConfig | null = null;
  function Chat({ lastUsed }: { lastUsed: ExecutorConfig }) {
    const ec = useExecutorConfig({ profiles, lastUsedConfig: lastUsed });
    current = ec.executorConfig;
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

  it('keeps Fast and effort when the current model is re-picked', async () => {
    await act(() => root.render(<Chat lastUsed={lastUsed} />));
    await click('modelSelector.fastOn');

    await act(() => popover.onModelSelect('gpt-5.5', undefined));
    expect(current).toMatchObject({
      model_id: 'gpt-5.5-fast',
      reasoning_id: 'high',
    });
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
