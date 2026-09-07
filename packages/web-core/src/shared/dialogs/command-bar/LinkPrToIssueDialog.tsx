import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowSquareOut } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { Input } from '@vibe/ui/components/Input';
import { Label } from '@vibe/ui/components/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { issuePrsApi, repoApi } from '@/shared/lib/api';
import {
  getGitHubPullRequest,
  listGitHubRepositories,
} from '@/shared/lib/remoteApi';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { SearchableDropdownContainer } from '@/shared/components/ui-new/containers/SearchableDropdownContainer';
import { fuzzySearchMatchAny } from '@vibe/ui/lib/search';
import type { GitRemote, PullRequestDetail } from 'shared/types';
import type { PullRequestStatus } from 'shared/remote-types';
import { pullRequestSummariesQueryOptions } from '@/pages/pull-requests/pullRequestSummariesQuery';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { GitHubApiErrorAlert } from '@/shared/components/GitHubApiErrorAlert';

export interface LinkPrToIssueDialogProps {
  projectId: string;
  issueId: string;
}

type TabMode = 'url' | 'browse';

function LinkPrToIssueContent({ issueId }: { issueId: string }) {
  const modal = useModal();
  const { t } = useTranslation('tasks');
  const runtime = useAppRuntime();
  const hostId = useHostId();

  const [activeTab, setActiveTab] = useState<TabMode>('url');

  // URL mode state
  const [prUrl, setPrUrl] = useState('');
  const [debouncedUrl, setDebouncedUrl] = useState('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browse mode state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);

  const loadPrInfo = useCallback(
    async (url: string): Promise<PullRequestDetail> => {
      if (runtime === 'remote') return getGitHubPullRequest(url);
      const result = await issuePrsApi.getPrInfo(url, hostId);
      if (!result.success) {
        throw new Error(
          result.message || t('createWorkspaceFromPr.errors.failedToLoadPrs')
        );
      }
      return result.data;
    },
    [hostId, runtime, t]
  );

  // Debounce URL changes
  const handleUrlChange = useCallback((value: string) => {
    setPrUrl(value);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedUrl(value.trim());
    }, 500);
  }, []);

  // Also trigger on blur immediately
  const handleUrlBlur = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setDebouncedUrl(prUrl.trim());
  }, [prUrl]);

  // Handle paste: immediately set the debounced URL
  const handleUrlPaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text').trim();
      if (pasted) {
        setPrUrl(pasted);
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        setDebouncedUrl(pasted);
      }
    },
    []
  );

  // Fetch PR info from URL
  const {
    data: prInfo,
    isLoading: isLoadingPrInfo,
    error: prInfoError,
  } = useQuery({
    queryKey: [
      'pr-info',
      debouncedUrl,
      runtime === 'remote' ? 'github' : getHostRequestScopeQueryKey(hostId),
    ],
    queryFn: () => loadPrInfo(debouncedUrl),
    enabled: modal.visible && activeTab === 'url' && debouncedUrl.length > 0,
  });

  // Browse mode queries
  const githubReposQuery = useQuery({
    queryKey: ['github-repositories'],
    queryFn: listGitHubRepositories,
    enabled: runtime === 'remote' && modal.visible && activeTab === 'browse',
    staleTime: 5 * 60_000,
  });
  const localReposQuery = useQuery({
    queryKey: ['repos', getHostRequestScopeQueryKey(hostId)],
    queryFn: () => repoApi.list(hostId),
    enabled: runtime === 'local' && modal.visible && activeTab === 'browse',
  });
  const repos = useMemo(
    () =>
      runtime === 'remote'
        ? (githubReposQuery.data ?? []).map((repo) => ({
            id: repo.full_name,
            label: repo.full_name,
          }))
        : (localReposQuery.data ?? []).map((repo) => ({
            id: repo.id,
            label: repo.display_name || repo.name,
          })),
    [githubReposQuery.data, localReposQuery.data, runtime]
  );
  const isLoadingRepos =
    runtime === 'remote'
      ? githubReposQuery.isLoading
      : localReposQuery.isLoading;
  const reposError =
    runtime === 'remote' ? githubReposQuery.error : localReposQuery.error;

  useEffect(() => {
    if (activeTab !== 'browse' || selectedRepoId) return;
    if (repos.length === 1) {
      setSelectedRepoId(repos[0].id);
    }
  }, [repos, selectedRepoId, activeTab]);

  const remotesQuery = useQuery({
    queryKey: [
      'repo-remotes',
      selectedRepoId,
      getHostRequestScopeQueryKey(hostId),
    ],
    queryFn: async () => {
      if (!selectedRepoId) return [];
      return repoApi.listRemotes(selectedRepoId, hostId);
    },
    enabled:
      runtime === 'local' &&
      modal.visible &&
      activeTab === 'browse' &&
      !!selectedRepoId,
  });
  const remotes = remotesQuery.data ?? [];

  useEffect(() => {
    if (runtime === 'local' && remotes.length > 0 && !selectedRemote) {
      setSelectedRemote(remotes[0].name);
    }
  }, [remotes, runtime, selectedRemote]);

  const githubPrsQuery = useQuery({
    ...pullRequestSummariesQueryOptions(selectedRepoId ?? '', false),
    enabled:
      runtime === 'remote' &&
      modal.visible &&
      activeTab === 'browse' &&
      !!selectedRepoId,
  });
  const localPrsQuery = useQuery({
    queryKey: [
      'open-prs',
      selectedRepoId,
      selectedRemote,
      getHostRequestScopeQueryKey(hostId),
    ],
    queryFn: async () => {
      if (!selectedRepoId || !selectedRemote) return null;
      return repoApi.listOpenPrs(selectedRepoId, selectedRemote, hostId);
    },
    enabled:
      runtime === 'local' &&
      modal.visible &&
      activeTab === 'browse' &&
      !!selectedRepoId &&
      !!selectedRemote,
  });

  const openPrs = useMemo<
    Pick<PullRequestDetail, 'number' | 'url' | 'status' | 'title'>[]
  >(() => {
    const pullRequests =
      runtime === 'remote'
        ? (githubPrsQuery.data?.summaries ?? []).filter(
            (pr) => pr.status === 'open'
          )
        : localPrsQuery.data?.success === true
          ? localPrsQuery.data.data
          : [];
    return pullRequests.map(({ number, url, status, title }) => ({
      number,
      url,
      status,
      title,
    }));
  }, [githubPrsQuery.data, localPrsQuery.data, runtime]);

  const selectedPr = useMemo(
    () => openPrs.find((pr) => Number(pr.number) === selectedPrNumber) ?? null,
    [openPrs, selectedPrNumber]
  );

  let prsErrorMessage: string | null = null;
  if (runtime === 'local' && localPrsQuery.data?.success === false) {
    switch (localPrsQuery.data.error?.type) {
      case 'cli_not_installed':
        prsErrorMessage = t('createWorkspaceFromPr.errors.cliNotInstalled', {
          provider: localPrsQuery.data.error.provider,
        });
        break;
      case 'auth_failed':
        prsErrorMessage = localPrsQuery.data.error.message;
        break;
      case 'unsupported_provider':
        prsErrorMessage = t('createWorkspaceFromPr.errors.unsupportedProvider');
        break;
      default:
        prsErrorMessage =
          localPrsQuery.data.message ||
          t('createWorkspaceFromPr.errors.failedToLoadPrs');
    }
  } else {
    const prsError =
      runtime === 'remote' ? githubPrsQuery.error : localPrsQuery.error;
    if (prsError) {
      prsErrorMessage =
        prsError instanceof Error
          ? prsError.message
          : t('createWorkspaceFromPr.errors.failedToLoadPrs');
    }
  }
  const isLoadingPrs =
    runtime === 'remote'
      ? githubPrsQuery.isLoading
      : localPrsQuery.isLoading || remotesQuery.isLoading;

  const { insertPullRequestIssue } = useProjectContext();
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState<Error | null>(null);

  // Reset state when dialog closes
  useEffect(() => {
    if (!modal.visible) {
      setActiveTab('url');
      setPrUrl('');
      setDebouncedUrl('');
      setSelectedRepoId(null);
      setSelectedRemote(null);
      setSelectedPrNumber(null);
      setLinkError(null);
    }
  }, [modal.visible]);

  // Clean up debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) modal.hide();
  };

  const canLink =
    activeTab === 'url'
      ? !!prInfo && !isLinking
      : !!selectedPr && !isLinking && !isLoadingPrs;

  const handleLink = async () => {
    if (!canLink) return;

    const mergeStatusToApiStatus = (s: string): PullRequestStatus => {
      if (s === 'merged') return 'merged';
      if (s === 'closed') return 'closed';
      return 'open';
    };

    setIsLinking(true);
    setLinkError(null);
    try {
      let pr: PullRequestDetail;
      if (activeTab === 'url') {
        if (!prInfo) return;
        pr = prInfo;
      } else if (runtime === 'local') {
        if (localPrsQuery.data?.success !== true) return;
        const localPr = localPrsQuery.data.data.find(
          (candidate) => Number(candidate.number) === selectedPrNumber
        );
        if (!localPr) return;
        pr = localPr;
      } else {
        if (!selectedPr) return;
        pr = await loadPrInfo(selectedPr.url);
      }

      const { persisted } = insertPullRequestIssue({
        issue_id: issueId,
        url: pr.url,
        number: Number(pr.number),
        status: mergeStatusToApiStatus(pr.status),
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_commit_sha,
        target_branch_name: pr.base_branch,
      });
      await persisted;
      if (runtime === 'local') {
        await issuePrsApi.linkToIssue({
          pr_url: pr.url,
          pr_number: Number(pr.number),
          base_branch: pr.base_branch,
        });
      }
      modal.hide();
    } catch (err) {
      setLinkError(
        err instanceof Error ? err : new Error(t('linkPrToIssue.errors.failed'))
      );
    } finally {
      setIsLinking(false);
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'open':
        return t('linkPrToIssue.status.open', 'Open');
      case 'merged':
        return t('linkPrToIssue.status.merged', 'Merged');
      case 'closed':
        return t('linkPrToIssue.status.closed', 'Closed');
      default:
        return t('linkPrToIssue.status.unknown', 'Unknown');
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'open':
        return 'text-green-600 dark:text-green-400';
      case 'merged':
        return 'text-purple-600 dark:text-purple-400';
      case 'closed':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('linkPrToIssue.title')}</DialogTitle>
          <DialogDescription>
            {t('linkPrToIssue.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Tab switcher */}
          <div className="flex gap-1 rounded-md bg-muted p-1">
            <button
              type="button"
              className={`flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'url'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setActiveTab('url')}
            >
              {t('linkPrToIssue.urlTab')}
            </button>
            <button
              type="button"
              className={`flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'browse'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setActiveTab('browse')}
            >
              {t('linkPrToIssue.browseTab')}
            </button>
          </div>

          {/* URL mode */}
          {activeTab === 'url' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('linkPrToIssue.urlLabel', 'Pull Request URL')}</Label>
                <Input
                  placeholder={t('linkPrToIssue.urlPlaceholder')}
                  value={prUrl}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  onBlur={handleUrlBlur}
                  onPaste={handleUrlPaste}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.nativeEvent.isComposing &&
                      canLink
                    ) {
                      e.preventDefault();
                      void handleLink();
                    }
                  }}
                />
              </div>

              {isLoadingPrInfo && (
                <div className="text-sm text-muted-foreground">
                  {t('linkPrToIssue.loadingPrInfo')}
                </div>
              )}

              {prInfoError && debouncedUrl.length > 0 && (
                <GitHubApiErrorAlert
                  error={prInfoError}
                  fallback={t('linkPrToIssue.invalidUrl')}
                />
              )}

              {prInfo && (
                <div className="rounded-md border p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">
                      #{String(prInfo.number)}
                      {prInfo.title ? `: ${prInfo.title}` : ''}
                    </span>
                    <a
                      href={prInfo.url}
                      onClick={(e) => {
                        e.preventDefault();
                        openExternalUrl(prInfo.url);
                      }}
                      className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ArrowSquareOut className="size-4" />
                    </a>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={statusColor(prInfo.status)}>
                      {statusLabel(prInfo.status)}
                    </span>
                    {prInfo.base_branch && (
                      <span className="text-muted-foreground">
                        {t('linkPrToIssue.baseBranch', 'Base:')}{' '}
                        {prInfo.base_branch}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Browse mode */}
          {activeTab === 'browse' && (
            <div className="space-y-3">
              {/* Repository selector */}
              <div className="space-y-2">
                <Label>{t('linkPrToIssue.repositoryLabel')}</Label>
                {isLoadingRepos ? (
                  <div className="text-sm text-muted-foreground">
                    {t('createWorkspaceFromPr.loadingRepositories')}
                  </div>
                ) : reposError ? (
                  <GitHubApiErrorAlert
                    error={reposError}
                    fallback={t('createWorkspaceFromPr.noRepositoriesFound')}
                  />
                ) : repos.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    {t('createWorkspaceFromPr.noRepositoriesFound')}
                  </div>
                ) : (
                  <Select
                    value={selectedRepoId ?? undefined}
                    onValueChange={(value) => {
                      setSelectedRepoId(value);
                      setSelectedRemote(null);
                      setSelectedPrNumber(null);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={t(
                          'createWorkspaceFromPr.selectRepository'
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {repos.map((repo) => (
                        <SelectItem key={repo.id} value={repo.id}>
                          {repo.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {runtime === 'local' && selectedRepoId && remotes.length > 1 && (
                <div className="space-y-2">
                  <Label>{t('linkPrToIssue.remoteLabel')}</Label>
                  {remotesQuery.isLoading ? (
                    <div className="text-sm text-muted-foreground">
                      {t('createWorkspaceFromPr.loadingRemotes')}
                    </div>
                  ) : (
                    <Select
                      value={selectedRemote ?? undefined}
                      onValueChange={(value) => {
                        setSelectedRemote(value);
                        setSelectedPrNumber(null);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t('createWorkspaceFromPr.selectRemote')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {remotes.map((remote: GitRemote, index: number) => (
                          <SelectItem key={remote.name} value={remote.name}>
                            {remote.name}
                            {index === 0 &&
                              ` (${t('createWorkspaceFromPr.default')})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* PR searchable dropdown */}
              <div className="space-y-2">
                <Label>{t('linkPrToIssue.pullRequestLabel')}</Label>
                {isLoadingPrs ? (
                  <div className="text-sm text-muted-foreground">
                    {t('createWorkspaceFromPr.loadingPullRequests')}
                  </div>
                ) : prsErrorMessage ? (
                  <GitHubApiErrorAlert
                    error={
                      runtime === 'remote'
                        ? githubPrsQuery.error
                        : prsErrorMessage
                    }
                    fallback={prsErrorMessage}
                  />
                ) : !selectedRepoId ? (
                  <div className="text-sm text-muted-foreground">
                    {t('createWorkspaceFromPr.selectRepositoryFirst')}
                  </div>
                ) : openPrs.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    {t('createWorkspaceFromPr.noPullRequestsFound')}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <SearchableDropdownContainer
                      items={openPrs}
                      selectedValue={selectedPrNumber?.toString() ?? null}
                      getItemKey={(pr) => String(pr.number)}
                      getItemLabel={(pr) => `#${pr.number}: ${pr.title}`}
                      filterItem={(pr, query) =>
                        fuzzySearchMatchAny(
                          [String(pr.number), pr.title],
                          query
                        )
                      }
                      onSelect={(pr) => setSelectedPrNumber(Number(pr.number))}
                      trigger={
                        <Button
                          variant="outline"
                          className="flex-1 justify-start font-normal min-w-0"
                        >
                          <span className="truncate">
                            {selectedPr
                              ? `#${selectedPr.number}: ${selectedPr.title}`
                              : t('createWorkspaceFromPr.selectPullRequest')}
                          </span>
                        </Button>
                      }
                      contentClassName="w-[400px]"
                      placeholder={t(
                        'createWorkspaceFromPr.searchPrsPlaceholder'
                      )}
                      emptyMessage={t('createWorkspaceFromPr.noMatchingPrs')}
                      getItemBadge={(pr) => statusLabel(pr.status)}
                      getItemIcon={null}
                    />
                    {selectedPr && (
                      <a
                        href={selectedPr.url}
                        onClick={(e) => {
                          e.preventDefault();
                          openExternalUrl(selectedPr.url);
                        }}
                        className="flex-shrink-0 p-2 text-muted-foreground hover:text-foreground transition-colors"
                        title={t('createWorkspaceFromPr.openPrInBrowser')}
                      >
                        <ArrowSquareOut className="size-4" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error message */}
          {linkError && (
            <GitHubApiErrorAlert
              error={linkError}
              fallback={t('linkPrToIssue.errors.failed')}
            />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => modal.hide()}
            disabled={isLinking}
          >
            {t('common:buttons.cancel')}
          </Button>
          <Button type="submit" onClick={handleLink} disabled={!canLink}>
            {isLinking ? t('linkPrToIssue.linking') : t('linkPrToIssue.linkPr')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkPrToIssueWithContext({
  projectId,
  issueId,
}: LinkPrToIssueDialogProps) {
  if (!projectId) {
    return null;
  }

  return (
    <ProjectProvider projectId={projectId}>
      <LinkPrToIssueContent issueId={issueId} />
    </ProjectProvider>
  );
}

const LinkPrToIssueDialogImpl = create<LinkPrToIssueDialogProps>(
  ({ projectId, issueId }) => {
    return <LinkPrToIssueWithContext projectId={projectId} issueId={issueId} />;
  }
);

export const LinkPrToIssueDialog = defineModal<LinkPrToIssueDialogProps, void>(
  LinkPrToIssueDialogImpl
);
