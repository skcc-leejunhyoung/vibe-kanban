import { useMemo, useCallback, type ReactNode } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import { USER_WORKSPACES_SHAPE } from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import {
  UserContext,
  type UserContextValue,
} from '@/shared/hooks/useUserContext';
import { foldSelfHostWorkspaces } from '@/shared/lib/workspaceHostIdentity';

interface UserProviderProps {
  children: ReactNode;
}

export function UserProvider({ children }: UserProviderProps) {
  const { isSignedIn } = useAuth();

  // No params needed - backend gets user from auth context
  const params = useMemo(() => ({}), []);
  const enabled = isSignedIn;

  // Shape subscriptions
  const workspacesResult = useShape(USER_WORKSPACES_SHAPE, params, { enabled });
  const { hostId: selfHostId } = useSelfCloudHostId();
  const workspaces = useMemo(
    () => foldSelfHostWorkspaces(workspacesResult.data, selfHostId),
    [workspacesResult.data, selfHostId]
  );

  // Lookup helpers
  const getWorkspacesForIssue = useCallback(
    (issueId: string) => {
      return workspaces.filter((w) => w.issue_id === issueId);
    },
    [workspaces]
  );

  const value = useMemo<UserContextValue>(
    () => ({
      // Data
      workspaces,

      // Loading/error
      isLoading: workspacesResult.isLoading,
      error: workspacesResult.error,
      retry: workspacesResult.retry,

      // Lookup helpers
      getWorkspacesForIssue,
    }),
    [workspacesResult, workspaces, getWorkspacesForIssue]
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
