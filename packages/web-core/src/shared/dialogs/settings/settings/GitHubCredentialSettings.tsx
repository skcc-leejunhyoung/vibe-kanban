import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@vibe/ui/components/Button';
import type { GitHubCredentialStatus } from 'shared/remote-types';
import { SettingsCard } from './SettingsComponents';
import { useSettingsMachineClient } from './SettingsHostContext';
import { useAuth } from '@/shared/hooks/auth/useAuth';
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
      return `Using the GitHub CLI login ${status.login ?? ''} synced from a machine. Scopes: ${status.scopes.join(', ')}.`;
    case 'oauth':
      return `Using the GitHub sign-in${status.login ? ` ${status.login}` : ''}. Organizations that restrict OAuth apps stay hidden until a machine's gh login is synced.`;
    default:
      return "No GitHub credential yet. Sign in with GitHub or sync a machine's gh login.";
  }
}

/**
 * Lets the server stack act with a machine's `gh` login instead of the OAuth
 * app token. The credential itself is account-wide; only reading `gh auth
 * token` needs a machine, so the sync targets the selected settings host and
 * works from remote web through the relay.
 */
export function GitHubCredentialSettings() {
  const { isSignedIn } = useAuth();
  const machineClient = useSettingsMachineClient();
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
    mutationFn: async () => {
      if (!machineClient) throw new Error('Select a machine first.');
      return machineClient.syncGitHubHostCredential();
    },
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
        <Button
          variant="outline"
          disabled={!isSignedIn || !machineClient || busy}
          onClick={() => sync.mutate()}
        >
          {machineClient
            ? `Use ${machineClient.target.label}'s gh login`
            : "Use this machine's gh login"}
        </Button>
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
      {!machineClient && (
        <p className="text-sm text-low">
          Select a machine above to sync its gh login.
        </p>
      )}
    </SettingsCard>
  );
}
