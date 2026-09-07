import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AuthContext,
  type AuthContextValue,
} from '@/shared/hooks/auth/useAuth';
import { useUserSystem } from '@/shared/hooks/useUserSystem';

interface LocalAuthProviderProps {
  children: ReactNode;
}

export function clearLocalUserQueryCache(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== 'user-system',
  });
  queryClient.getMutationCache().clear();
}

export function LocalAuthProvider({ children }: LocalAuthProviderProps) {
  const queryClient = useQueryClient();
  const { loginStatus } = useUserSystem();
  const userId =
    loginStatus?.status === 'loggedin'
      ? (loginStatus.profile?.user_id ?? null)
      : null;
  const previousUserIdRef = useRef<string | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (
      previousUserIdRef.current !== undefined &&
      previousUserIdRef.current !== userId
    ) {
      clearLocalUserQueryCache(queryClient);
    }
    previousUserIdRef.current = userId;
  }, [queryClient, userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isSignedIn: loginStatus?.status === 'loggedin',
      isLoaded: loginStatus !== null,
      userId,
    }),
    [loginStatus, userId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
