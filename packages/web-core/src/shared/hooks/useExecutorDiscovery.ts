import { useCallback, useEffect, useMemo } from 'react';
import type { BaseCodingAgent, ExecutorDiscoveredOptions } from 'shared/types';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { agentsApi } from '@/shared/lib/api';

type ExecutorDiscoveryStreamState = {
  options: ExecutorDiscoveredOptions | null;
};

interface ExecutorDiscoveryOpts {
  workspaceId?: string;
  sessionId?: string;
  repoId?: string;
  /**
   * Route the discovery stream to this host. Required when the consumer is not
   * on a host-scoped route — e.g. the global Quick chat modal, which picks a
   * host explicitly. Defaults to the current page's host when omitted, so the
   * stream would otherwise never reach the selected host in remote runtime.
   */
  hostId?: string | null;
}

const defaultOptions: ExecutorDiscoveredOptions = {
  model_selector: {
    providers: [],
    models: [],
    default_model: null,
    agents: [],
    permissions: [],
  },
  slash_commands: [],
  loading_models: true,
  loading_agents: true,
  loading_slash_commands: true,
  error: null,
};

function useExecutorDiscovery(
  agent: BaseCodingAgent | null | undefined,
  opts?: ExecutorDiscoveryOpts
) {
  const { workspaceId, sessionId, repoId, hostId } = opts ?? {};
  const endpoint = useMemo(() => {
    if (!agent) return undefined;
    return agentsApi.getDiscoveredOptionsStreamUrl(agent, {
      workspaceId,
      sessionId,
      repoId,
      hostScopeKey: hostId === undefined ? 'current' : (hostId ?? 'local'),
    });
  }, [agent, workspaceId, sessionId, repoId, hostId]);

  const initialData = useCallback(
    (): ExecutorDiscoveryStreamState => ({
      options: { ...defaultOptions },
    }),
    []
  );

  const { data, error, isConnected, isInitialized } =
    useJsonPatchWsStream<ExecutorDiscoveryStreamState>(
      endpoint,
      !!endpoint,
      initialData,
      {
        // Serve the last options for this endpoint on reconnect (live event,
        // resume, transport blip) instead of blanking to `undefined`, which
        // flips consumers to their loading state and flickers the UI.
        keepSnapshotForEndpoint: true,
        ...(hostId !== undefined ? { targetHostId: hostId } : {}),
      }
    );

  // Prefer the backend-reported error from the data payload. Only fall back
  // to the WebSocket transport error when no data has been received yet —
  // transient connection failures (e.g. React StrictMode double-mount or
  // Safari/macOS 26 WebSocket instability) should not persist once data
  // has successfully loaded.
  const combinedError = data?.options?.error ?? (isInitialized ? null : error);

  useEffect(() => {
    if (combinedError) {
      console.error(
        'Failed to fetch executor discovery options',
        combinedError
      );
    }
  }, [combinedError]);

  return {
    options: data?.options ?? null,
    error: combinedError,
    isConnected,
    isInitialized,
  };
}

export function useModelSelectorConfig(
  agent: BaseCodingAgent | null | undefined,
  opts?: ExecutorDiscoveryOpts
) {
  const { options, error, isConnected, isInitialized } = useExecutorDiscovery(
    agent,
    opts
  );

  return {
    config: options?.model_selector ?? null,
    loadingModels: options?.loading_models ?? false,
    loadingAgents: options?.loading_agents ?? false,
    error,
    isConnected,
    isInitialized,
  };
}

export function useSlashCommands(
  agent: BaseCodingAgent | null | undefined,
  opts?: ExecutorDiscoveryOpts
) {
  const { options, error, isConnected, isInitialized } = useExecutorDiscovery(
    agent,
    opts
  );

  return {
    commands: options?.slash_commands ?? [],
    discovering: options?.loading_slash_commands ?? false,
    error,
    isConnected,
    isInitialized,
  };
}
