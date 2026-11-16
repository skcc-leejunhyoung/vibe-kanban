import type { ActionExecutorContext } from '@/shared/types/actions';

/**
 * The one host an action run acts on, fixed before the action starts: the
 * caller's target, else the dispatching scope's host.
 *
 * An action handed `undefined` passes it on to every request it makes, and
 * each of those — also the ones after a confirmation dialog — would then be
 * sent to whichever pane has focus at that moment.
 *
 * `context` is for actions that read their host from it (git actions): the
 * same context, with the target swapped in when it is another host.
 */
export function resolveActionHost(
  hostId: string | null | undefined,
  context: ActionExecutorContext
): { hostId: string | null; context: ActionExecutorContext } {
  const target = hostId === undefined ? context.currentHostId : hostId;
  return {
    hostId: target,
    context:
      target === context.currentHostId
        ? context
        : { ...context, currentHostId: target },
  };
}
