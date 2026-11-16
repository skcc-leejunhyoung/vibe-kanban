import type { AppBarHost } from '@vibe/ui/components/AppBar';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';

/**
 * Whether the selected "Run on" target can take requests:
 * `online` yes; `offline` listed but unreachable; `loading` the host list has
 * not answered yet; `missing` the list answered without it (removed, access
 * revoked) or could not be loaded.
 */
export type QuickChatHostState = 'online' | 'offline' | 'loading' | 'missing';

export interface QuickChatHostOption {
  /** `null` is this machine (local web only). */
  id: string | null;
  label: string;
  state: QuickChatHostState;
}

export const THIS_MACHINE_LABEL = 'This machine';

/**
 * Options for the "Run on" picker. The current selection is ALWAYS one of
 * them, even when that host is offline or gone: a `<select>` whose value has
 * no option shows its first option instead, so the picker would name one host
 * while every request went to another.
 *
 * `selected` is `null` only on the remote web before any host is chosen.
 */
export function buildQuickChatHostOptions({
  runtime,
  hosts,
  hostsLoading,
  selectedHostId,
}: {
  runtime: AppRuntime;
  hosts: readonly AppBarHost[];
  hostsLoading: boolean;
  selectedHostId: string | null;
}): { options: QuickChatHostOption[]; selected: QuickChatHostOption | null } {
  const options: QuickChatHostOption[] = [];
  if (runtime === 'local') {
    options.push({ id: null, label: THIS_MACHINE_LABEL, state: 'online' });
  }
  for (const host of hosts) {
    if (host.status === 'online') {
      options.push({ id: host.id, label: host.name, state: 'online' });
    }
  }

  let selected = options.find((option) => option.id === selectedHostId) ?? null;
  if (!selected && selectedHostId !== null) {
    const listed = hosts.find((host) => host.id === selectedHostId);
    selected = listed
      ? {
          id: listed.id,
          label: `${listed.name} (${listed.status === 'unpaired' ? 'not paired' : 'offline'})`,
          state: 'offline',
        }
      : hostsLoading
        ? { id: selectedHostId, label: 'Checking host…', state: 'loading' }
        : { id: selectedHostId, label: 'Unavailable host', state: 'missing' };
    options.push(selected);
  }

  return { options, selected };
}

/** Why nothing can run on the selected target, or `null` when it can. */
export function describeUnavailableQuickChatHost(
  selected: QuickChatHostOption | null,
  { hostsLoading, hostsFailed }: { hostsLoading: boolean; hostsFailed: boolean }
): string | null {
  if (selected?.state === 'online') return null;
  if (!selected) {
    if (hostsLoading) return 'Checking hosts…';
    return hostsFailed
      ? 'Could not load your hosts.'
      : 'No host is online. Bring one online to continue.';
  }
  if (selected.state === 'loading') return 'Checking hosts…';
  if (selected.state === 'offline') {
    return `${selected.label} cannot be reached. Choose another host to continue.`;
  }
  return hostsFailed
    ? 'Could not load your hosts, so this target cannot be confirmed.'
    : 'This host is no longer available. Choose another host to continue.';
}

/**
 * Whether the "start an Autopilot" form may be offered for a host. "None" is
 * only what a successful lookup said: while it is loading or after it failed
 * the host may still have its Autopilot, and the form would start another.
 */
export function canOfferAutopilotForm(lookup: {
  isSuccess: boolean;
  hasAutopilot: boolean;
}): boolean {
  return lookup.isSuccess && !lookup.hasAutopilot;
}
