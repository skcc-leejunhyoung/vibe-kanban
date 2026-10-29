import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ArtifactAutomationRequest,
  ArtifactInteraction,
} from 'shared/types';
import { ApiError, artifactsApi } from '@/shared/lib/api';

// Page memory only. An uncertain request keeps its ID and payload for explicit retry.
const pendingRequests = new Map<string, ArtifactAutomationRequest>();

export function useArtifactAutomation(
  interaction: ArtifactInteraction,
  hostId: string | null
) {
  const active =
    !!interaction.automation && interaction.state === 'input_required';
  const key = `${hostId}:${interaction.owner_id}:${interaction.reference.request_id}`;
  const [pending, setPending] = useState(() => pendingRequests.get(key));
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(!!pending);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const snapshot = useQuery({
    queryKey: ['artifact-automation', key, interaction.automation?.version],
    queryFn: ({ signal }) =>
      artifactsApi.automationSnapshot(interaction, hostId, undefined, signal),
    enabled: active,
    retry: false,
    retryOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (active && !query.state.error ? 2000 : false),
  });
  const current = snapshot.data?.request;
  const busy =
    sending || ['processing', 'accepted'].includes(current?.status ?? '');
  const connected = active && snapshot.isSuccess && !snapshot.isError;
  const send = async (request: ArtifactAutomationRequest) => {
    if (inFlight.current || !active) return;
    inFlight.current = true;
    setSending(true);
    setError(undefined);
    pendingRequests.set(key, request);
    setPending(request);
    try {
      await artifactsApi.automationRequest(interaction, request, hostId);
      setUncertain(false);
      pendingRequests.delete(key);
      setPending(undefined);
    } catch (cause) {
      const rejected =
        cause instanceof ApiError &&
        [400, 403, 409, 422].includes(cause.status ?? 0);
      setUncertain(!rejected);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (rejected) {
        pendingRequests.delete(key);
        setPending(undefined);
      }
    } finally {
      await snapshot.refetch();
      inFlight.current = false;
      setSending(false);
    }
  };
  const check = async () => {
    if (pending) {
      const receipt = await artifactsApi.automationSnapshot(
        interaction,
        hostId,
        pending.request_id
      );
      if (receipt.request) {
        setUncertain(false);
        pendingRequests.delete(key);
        setPending(undefined);
      }
    }
    const response = await snapshot.refetch();
    if (response.error) throw response.error;
    setError(undefined);
  };
  return {
    snapshot: snapshot.data,
    current,
    error: active
      ? (error ??
        (snapshot.error instanceof Error ? snapshot.error.message : undefined))
      : undefined,
    busy,
    uncertain: active && uncertain,
    sending,
    connected,
    editable: connected && !busy && !uncertain && current?.status !== 'unknown',
    request: (action: string, data: unknown) => {
      if (
        !connected ||
        busy ||
        uncertain ||
        inFlight.current ||
        current?.status === 'unknown'
      )
        return;
      if (
        !interaction.automation ||
        !Object.hasOwn(interaction.automation.actions, action)
      )
        return;
      void send({ request_id: crypto.randomUUID(), action, data });
    },
    check,
    retry: active && pending && uncertain ? () => send(pending) : undefined,
  };
}
