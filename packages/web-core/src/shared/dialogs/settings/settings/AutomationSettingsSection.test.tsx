import { act, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAccessConfig, Config } from 'shared/types';
import type { MachineClient } from '@/shared/lib/machineClient';
import { installFakeDomReact } from '@/shared/lib/electric/electricTestKit';
import { SettingsMachineUserSystemProvider } from './SettingsMachineUserSystemProvider';
import { AutomationSettingsSection } from './AutomationSettingsSection';

type CheckboxProps = {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
};
const mock = vi.hoisted(() => ({
  machine: null as MachineClient | null,
  checkboxes: new Map<string, CheckboxProps>(),
  cards: new Map<string, ReactNode>(),
}));
vi.mock('./SettingsHostContext', () => ({
  useSettingsMachineClient: () => mock.machine,
  useSettingsHost: () => ({ selectedHost: mock.machine?.target }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return String(fallback?.defaultValue ?? key).replace(
        /{{(\w+)}}/g,
        (_, name) => String(fallback?.[name] ?? '')
      );
    },
  }),
}));
vi.mock('./SettingsComponents', () => ({
  SettingsCard: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: ReactNode;
  }) => {
    mock.cards.set(title, children);
    return (
      <section>
        <h3>{title}</h3>
        <p>{description}</p>
        {children}
      </section>
    );
  },
  SettingsCheckbox: (props: CheckboxProps) => {
    mock.checkboxes.set(props.id, props);
    return null;
  },
  SettingsField: () => null,
  SettingsInput: () => null,
  SettingsSelect: () => null,
  SettingsTextarea: () => null,
}));
vi.mock('@vibe/ui/components/PrimaryButton', () => ({
  PrimaryButton: () => null,
}));
vi.mock('@/shared/lib/remoteApi', () => ({ listProjectStatuses: vi.fn() }));

const access: AgentAccessConfig = {
  write_issues: true,
  control_sessions: true,
  respond_approvals: false,
  git_write: true,
  git_merge: false,
  delete_workspaces: false,
  update_config: false,
  automation_write: false,
};
function machine(id: string, updateConfig = false) {
  const config = {
    agent_access: { ...access, update_config: updateConfig },
  } as Config;
  return {
    target: { kind: 'remote', id, apiHostId: id, label: `${id}-mbp` },
    getConfig: vi.fn(async () => ({ config, config_revision: `${id}-1` })),
    saveConfig: vi.fn<MachineClient['saveConfig']>(async (next) => ({
      config: next,
      revision: `${id}-2`,
    })),
    getAutomationState: vi.fn(async () => {
      throw new Error('502 automation worker unavailable');
    }),
    getAutomationLogs: vi.fn(async () => []),
    getAgentMemorySyncStatus: vi.fn(async () => ({
      running: false,
      central_targets: [],
    })),
    getAgentMemorySyncLogs: vi.fn(async () => []),
    listAgentMemoryMutations: vi.fn(async () => []),
  };
}

let client: QueryClient;
let dom: ReturnType<typeof installFakeDomReact>;
let i9: ReturnType<typeof machine>;
function tree() {
  return (
    <QueryClientProvider client={client}>
      <SettingsMachineUserSystemProvider>
        <AutomationSettingsSection />
      </SettingsMachineUserSystemProvider>
    </QueryClientProvider>
  );
}
async function mount() {
  await dom.render(tree());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
const updateToggle = () => mock.checkboxes.get('agent-access-update_config')!;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  i9 = machine('i9');
  mock.machine = i9 as unknown as MachineClient;
  mock.checkboxes.clear();
  mock.cards.clear();
  dom = installFakeDomReact();
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Agent access without an Automation Worker', () => {
  it('loads and saves the selected host config despite worker 502', async () => {
    await mount();
    expect(i9.getConfig).toHaveBeenCalledOnce();
    expect(i9.getAutomationState).toHaveBeenCalledOnce();
    expect(updateToggle()).toMatchObject({ checked: false, disabled: false });
    expect(mock.checkboxes.get('automation-master')?.disabled).toBe(true);

    await act(async () => {
      updateToggle().onChange(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(i9.saveConfig).toHaveBeenCalledWith(
      { agent_access: { ...access, update_config: true } },
      'i9-1'
    );
    expect(updateToggle()).toMatchObject({ checked: true, disabled: false });
    expect(i9.getAutomationState).toHaveBeenCalledOnce();
  });

  it('shows the host and worker-independent card before the worker settings', async () => {
    await mount();
    const html = renderToStaticMarkup(tree());
    expect(html).toContain('Target host: i9-mbp (i9)');
    expect(html).toContain(
      'even when no Automation Worker is installed or reachable'
    );
    expect(html.indexOf('Agent access')).toBeLessThan(
      html.indexOf('<h3>Automation Worker')
    );
  });

  it('can save Agent access while the worker request is still pending', async () => {
    i9.getAutomationState.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(updateToggle()).toMatchObject({ checked: false, disabled: false });
    await act(() => updateToggle().onChange(true));
    expect(i9.saveConfig).toHaveBeenCalledWith(
      { agent_access: { ...access, update_config: true } },
      'i9-1'
    );
  });

  it.each(['local', 'remote'] as const)(
    'uses the %s host config and revision after changing hosts',
    async (kind) => {
      await mount();
      const main = machine('main', true);
      mock.machine = {
        ...main,
        target:
          kind === 'local'
            ? { kind: 'local', id: 'local', apiHostId: null, label: 'Main Mac' }
            : main.target,
      } as unknown as MachineClient;
      await mount();
      expect(updateToggle().checked).toBe(true);
      await act(() => updateToggle().onChange(false));
      expect(main.saveConfig).toHaveBeenCalledWith(
        { agent_access: access },
        'main-1'
      );
      expect(i9.saveConfig).not.toHaveBeenCalled();

      mock.machine = i9 as unknown as MachineClient;
      await mount();
      expect(updateToggle().checked).toBe(false);
    }
  );

  it('reports a failed save on the card and restores the stored value', async () => {
    await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    i9.saveConfig.mockRejectedValueOnce(new Error('host disconnected'));
    await act(() => updateToggle().onChange(true));
    await mount();
    expect(updateToggle()).toMatchObject({ checked: false, disabled: false });
    expect(
      renderToStaticMarkup(<>{mock.cards.get('Agent access')}</>)
    ).toContain('Agent access could not be saved on the selected host');
  });

  it('shows a host-specific load error instead of silently hiding the card', async () => {
    i9.getConfig.mockRejectedValue(new Error('host disconnected'));
    await mount();
    const html = renderToStaticMarkup(<>{mock.cards.get('Agent access')}</>);
    expect(html).toContain('Target host: i9-mbp (i9)');
    expect(html).toContain('Could not load Agent access for this host');
    expect(i9.saveConfig).not.toHaveBeenCalled();
  });
});
