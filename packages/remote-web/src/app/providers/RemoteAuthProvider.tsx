import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { AUTH_CHANGED_EVENT, isLoggedIn } from "@remote/shared/lib/auth";
import { getIdentity } from "@remote/shared/lib/api";
import {
  AuthContext,
  type AuthContextValue,
} from "@/shared/hooks/auth/useAuth";
import { clearLegacyLocalStorageScratch } from "@/shared/hooks/useLocalStorageScratch";

const TOKENS_QUERY_KEY = ["remote-auth", "tokens"] as const;
const IDENTITY_QUERY_KEY = ["remote-auth", "identity"] as const;

export function clearRemoteUserQueryCache(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "remote-auth",
  });
  queryClient.getMutationCache().clear();
}

interface RemoteAuthProviderProps {
  children: ReactNode;
}

export function RemoteAuthProvider({ children }: RemoteAuthProviderProps) {
  const queryClient = useQueryClient();
  const activeUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    clearLegacyLocalStorageScratch();
  }, []);

  const tokensQuery = useQuery({
    queryKey: TOKENS_QUERY_KEY,
    queryFn: () => isLoggedIn(),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const hasTokens = tokensQuery.data === true;

  const identityQuery = useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: () => getIdentity(),
    enabled: hasTokens,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const identityUserId = identityQuery.data?.user_id ?? null;

  useLayoutEffect(() => {
    if (!identityUserId || activeUserIdRef.current === identityUserId) {
      return;
    }
    clearRemoteUserQueryCache(queryClient);
    activeUserIdRef.current = identityUserId;
  }, [identityUserId, queryClient]);

  useEffect(() => {
    const handleAuthChanged = async () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_QUERY_KEY });
      if (await isLoggedIn()) {
        await queryClient.resetQueries({ queryKey: IDENTITY_QUERY_KEY });
        return;
      }

      clearRemoteUserQueryCache(queryClient);
      queryClient.removeQueries({ queryKey: IDENTITY_QUERY_KEY });
      activeUserIdRef.current = null;
    };

    const listener = () => void handleAuthChanged();
    window.addEventListener(AUTH_CHANGED_EVENT, listener);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, listener);
    };
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    if (tokensQuery.status === "pending") {
      return { isSignedIn: false, isLoaded: false, userId: null };
    }

    if (!hasTokens) {
      return { isSignedIn: false, isLoaded: true, userId: null };
    }

    if (identityQuery.status === "pending") {
      return { isSignedIn: false, isLoaded: false, userId: null };
    }

    if (identityUserId) {
      return {
        isSignedIn: true,
        isLoaded: true,
        userId: identityUserId,
      };
    }

    return { isSignedIn: false, isLoaded: true, userId: null };
  }, [tokensQuery.status, hasTokens, identityQuery.status, identityUserId]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
