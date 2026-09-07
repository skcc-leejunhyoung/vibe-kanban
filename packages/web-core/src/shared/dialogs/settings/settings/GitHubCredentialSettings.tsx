import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@vibe/ui/components/Button';
import type { GitHubCredentialStatus } from 'shared/remote-types';
import { SettingsCard } from './SettingsComponents';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { oauthApi } from '@/shared/lib/api';
import {
  deleteGitHubCredential,
  getGitHubCredentialStatus,
} from '@/shared/lib/remoteApi';
import {
  GitHubApiErrorAlert,
  invalidateGitHubReadCaches,
} from '@/shared/components/GitHubApiErrorAlert';

export const GITHUB_CREDENTIAL_QUERY_KEY = ['github-credential'] as const;

export function describeGitHubCredential(
  status: GitHubCredentialStatus
): string {
  switch (status.source) {
    case 'host_gh':
      return `Using the GitHub CLI login ${status.login ?? ''} synced from a host. Scopes: ${status.scopes.join(', ')}.`;
    case 'oauth':
      return `Using the GitHub sign-in${status.login ? ` ${status.login}` : ''}. Organizations that restrict OAuth apps stay hidden until a host's gh login is synced.`;
    default:
      return "No GitHub credential yet. Sign in with GitHub or sync a host's gh login.";
  }
}

/** Lets the server stack act with a host's `gh` login instead of the OAuth app token. */
export function GitHubCredentialSettings() {
  const runtime = useAppRuntime();
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: GITHUB_CREDENTIAL_QUERY_KEY,
    queryFn: getGitHubCredentialStatus,
    enabled: isSignedIn,
    staleTime: 60_000,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: GITHUB_CREDENTIAL_QUERY_KEY,
    });
    await invalidateGitHubReadCaches(queryClient);
  };
  const sync = useMutation({
    mutationFn: () => oauthApi.syncGitHubHostCredential(),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: deleteGitHubCredential,
    onSuccess: refresh,
  });
  const status = statusQuery.data;
  const busy = sync.isPending || remove.isPending;

  return (
    <SettingsCard
      title="GitHub credential"
      description="Which GitHub login the server uses for the Pull Requests page and PR details."
    >
      {status && (
        <p className="text-sm text-normal">
          {describeGitHubCredential(status)}
        </p>
      )}
      <GitHubApiErrorAlert
        error={sync.error ?? remove.error ?? statusQuery.error}
        fallback="Could not update the GitHub credential"
      />
      <div className="flex flex-wrap items-center gap-base">
        {runtime === 'local' ? (
          <Button
            variant="outline"
            disabled={!isSignedIn || busy}
            onClick={() => sync.mutate()}
          >
            Use this host's gh login
          </Button>
        ) : (
          <p className="text-sm text-low">
            Sync from the local app on a host where gh is signed in.
          </p>
        )}
        {status?.source === 'host_gh' && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        )}
      </div>
    </SettingsCard>
  );
}
