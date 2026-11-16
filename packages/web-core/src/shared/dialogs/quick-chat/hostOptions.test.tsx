import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppBarHost } from '@vibe/ui/components/AppBar';
import {
  buildQuickChatHostOptions,
  canOfferAutopilotForm,
  describeUnavailableQuickChatHost,
} from './hostOptions';
import { QuickChatHostSelect } from './QuickChatHostSelect';

const online: AppBarHost = { id: 'host-a', name: 'Studio', status: 'online' };
const offline: AppBarHost = { id: 'host-b', name: 'Laptop', status: 'offline' };

function selectedLabel(markup: string): string | null {
  return /<option[^>]*\sselected=""[^>]*>([^<]*)</.exec(markup)?.[1] ?? null;
}

function render(args: Parameters<typeof buildQuickChatHostOptions>[0]) {
  const built = buildQuickChatHostOptions(args);
  const markup = renderToStaticMarkup(
    <QuickChatHostSelect
      options={built.options}
      selected={built.selected}
      onChange={() => {}}
    />
  );
  return { ...built, markup };
}

describe('quick chat host picker', () => {
  it('names an offline selection instead of falling back to this machine', () => {
    const { selected, options, markup } = render({
      runtime: 'local',
      hosts: [online, offline],
      hostsLoading: false,
      selectedHostId: 'host-b',
    });
    expect(selected).toEqual({
      id: 'host-b',
      label: 'Laptop (offline)',
      state: 'offline',
    });
    expect(options.map((option) => option.id)).toEqual([
      null,
      'host-a',
      'host-b',
    ]);
    // The option the browser shows is the one requests would go to.
    expect(selectedLabel(markup)).toBe('Laptop (offline)');
  });

  it('keeps a removed selection visible when it is the only other option', () => {
    const { selected, options, markup } = render({
      runtime: 'local',
      hosts: [],
      hostsLoading: false,
      selectedHostId: 'host-gone',
    });
    expect(selected?.state).toBe('missing');
    expect(options).toHaveLength(2);
    expect(selectedLabel(markup)).toBe('Unavailable host');
  });

  it('does not call an unlisted host gone while the list is still loading', () => {
    const { selected, markup } = render({
      runtime: 'local',
      hosts: [],
      hostsLoading: true,
      selectedHostId: 'host-b',
    });
    expect(selected?.state).toBe('loading');
    expect(selectedLabel(markup)).toBe('Checking host…');
  });

  it('shows this machine only when this machine is the target', () => {
    const { selected, markup } = render({
      runtime: 'local',
      hosts: [online, offline],
      hostsLoading: false,
      selectedHostId: null,
    });
    expect(selected).toEqual({
      id: null,
      label: 'This machine',
      state: 'online',
    });
    expect(selectedLabel(markup)).toBe('This machine');
  });

  it('lists only reachable hosts besides the current selection', () => {
    const { options } = render({
      runtime: 'local',
      hosts: [
        online,
        offline,
        { id: 'host-c', name: 'Old', status: 'unpaired' },
      ],
      hostsLoading: false,
      selectedHostId: 'host-a',
    });
    expect(options.map((option) => option.id)).toEqual([null, 'host-a']);
  });

  it('has no this-machine option on the remote web and shows a placeholder until a host is chosen', () => {
    const { selected, options, markup } = render({
      runtime: 'remote',
      hosts: [online],
      hostsLoading: false,
      selectedHostId: null,
    });
    expect(selected).toBeNull();
    expect(options.map((option) => option.id)).toEqual(['host-a']);
    expect(selectedLabel(markup)).toBe('Select a host…');
  });

  it('labels a host whose pairing lapsed', () => {
    const { selected } = render({
      runtime: 'remote',
      hosts: [{ id: 'host-c', name: 'Old', status: 'unpaired' }],
      hostsLoading: false,
      selectedHostId: 'host-c',
    });
    expect(selected?.label).toBe('Old (not paired)');
    expect(selected?.state).toBe('offline');
  });
});

describe('quick chat unavailable target', () => {
  const settled = { hostsLoading: false, hostsFailed: false };

  it('allows an online target', () => {
    expect(
      describeUnavailableQuickChatHost(
        { id: null, label: 'This machine', state: 'online' },
        settled
      )
    ).toBeNull();
  });

  it('names the unreachable host rather than the one on screen before', () => {
    expect(
      describeUnavailableQuickChatHost(
        { id: 'host-b', label: 'Laptop (offline)', state: 'offline' },
        settled
      )
    ).toContain('Laptop (offline)');
  });

  it('separates loading, a failed list and a missing host', () => {
    const missing = { id: 'x', label: 'Unavailable host', state: 'missing' };
    const loading = { id: 'x', label: 'Checking host…', state: 'loading' };
    const messages = [
      describeUnavailableQuickChatHost(loading as never, {
        hostsLoading: true,
        hostsFailed: false,
      }),
      describeUnavailableQuickChatHost(missing as never, settled),
      describeUnavailableQuickChatHost(missing as never, {
        hostsLoading: false,
        hostsFailed: true,
      }),
      describeUnavailableQuickChatHost(null, settled),
      describeUnavailableQuickChatHost(null, {
        hostsLoading: true,
        hostsFailed: false,
      }),
    ];
    expect(messages.every(Boolean)).toBe(true);
    expect(new Set(messages).size).toBe(4);
    expect(messages[0]).toBe(messages[4]);
  });
});

describe('offering to start an Autopilot', () => {
  it('offers the form once the host answered that it has none', () => {
    expect(
      canOfferAutopilotForm({ isSuccess: true, hasAutopilot: false })
    ).toBe(true);
  });

  it('never offers it while the lookup is pending or after it failed', () => {
    expect(
      canOfferAutopilotForm({ isSuccess: false, hasAutopilot: false })
    ).toBe(false);
  });

  it('shows the existing Autopilot instead', () => {
    expect(canOfferAutopilotForm({ isSuccess: true, hasAutopilot: true })).toBe(
      false
    );
    // A failed refresh keeps showing the last known one rather than the form.
    expect(
      canOfferAutopilotForm({ isSuccess: false, hasAutopilot: true })
    ).toBe(false);
  });
});
