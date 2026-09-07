import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { oauthApi } from '@/shared/lib/api';

interface UseAuthMutationsOptions {
  onInitSuccess?: (data: { handoff_id: string; authorize_url: string }) => void;
  onInitError?: (err: unknown) => void;
}

export function useAuthMutations(options?: UseAuthMutationsOptions) {
  const handoffId = useRef<string | null>(null);
  const generation = useRef(0);
  const cancelHandoff = useCallback(() => {
    generation.current += 1;
    const id = handoffId.current;
    handoffId.current = null;
    if (id) {
      void oauthApi.handoffCancel(id).catch((error) => {
        console.error('Failed to cancel OAuth handoff:', error);
      });
    }
  }, []);
  useEffect(() => cancelHandoff, [cancelHandoff]);

  const initHandoff = useMutation({
    mutationKey: ['auth', 'init'],
    mutationFn: async ({
      provider,
      returnTo,
      reauthenticate = false,
    }: {
      provider: string;
      returnTo: string;
      reauthenticate?: boolean;
    }) => {
      cancelHandoff();
      const attempt = generation.current;
      try {
        const data = await oauthApi.handoffInit(
          provider,
          returnTo,
          reauthenticate
        );
        // Closing/back/retry can happen while initialization is still in flight.
        // Release the late handoff instead of opening a popup after cancellation.
        if (attempt !== generation.current) {
          await oauthApi.handoffCancel(data.handoff_id);
          return null;
        }
        handoffId.current = data.handoff_id;
        return data;
      } catch (error) {
        if (attempt !== generation.current) return null;
        throw error;
      }
    },
    onSuccess: (data) => {
      if (data && handoffId.current === data.handoff_id) {
        options?.onInitSuccess?.(data);
      }
    },
    onError: (err) => {
      console.error('Failed to initialize OAuth handoff:', err);
      options?.onInitError?.(err);
    },
  });

  return {
    initHandoff,
    cancelHandoff,
  };
}
