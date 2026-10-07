import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestDetail } from 'shared/types';
import { issuePrsApi } from '@/shared/lib/api';
import { prInfoResultQueryOptions } from './LinkPrByUrlDialog';
import { prInfoQueryKey } from './LinkPrToIssueDialog';

vi.mock('@/shared/lib/api', () => ({
  issuePrsApi: { getPrInfo: vi.fn() },
}));

const url = 'https://github.com/owner/repo/pull/1';
const detail = { number: 1n, url, title: 'PR' } as PullRequestDetail;
// Both dialogs resolve hostId to null in the local runtime.
const issueDialogKey = prInfoQueryKey(url, 'local', null);
// Mirrors the app's 5-minute staleTime so cached entries are reused.
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000 } } });

describe('PR info caches shared by the link-PR dialogs', () => {
  beforeEach(() => {
    vi.mocked(issuePrsApi.getPrInfo).mockReset().mockResolvedValue({
      success: true,
      data: detail,
    });
  });

  it('LinkPrByUrlDialog ignores the PullRequestDetail the issue dialog cached', async () => {
    const client = newClient();
    client.setQueryData(issueDialogKey, detail);

    const result = await client.fetchQuery(prInfoResultQueryOptions(url, null));

    expect(result).toEqual({ success: true, data: detail });
    expect(issuePrsApi.getPrInfo).toHaveBeenCalledWith(url, null);
    expect(client.getQueryData(issueDialogKey)).toBe(detail);
  });

  it('LinkPrToIssueDialog does not see the Result LinkPrByUrlDialog cached', async () => {
    const client = newClient();

    await client.fetchQuery(prInfoResultQueryOptions(url, null));

    expect(client.getQueryData(issueDialogKey)).toBeUndefined();
  });
});
