import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { clearLocalUserQueryCache } from './LocalAuthProvider';

describe('clearLocalUserQueryCache', () => {
  it('removes account-scoped queries and mutations while retaining auth state', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['user-system', 'local'], { user: 'next' });
    queryClient.setQueryData(['github-repositories'], ['private']);
    queryClient.setQueryData(
      ['pull-request-summaries', 'acme/repo'],
      ['private']
    );
    queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => undefined,
    });

    clearLocalUserQueryCache(queryClient);

    expect(queryClient.getQueryData(['user-system', 'local'])).toEqual({
      user: 'next',
    });
    expect(queryClient.getQueryData(['github-repositories'])).toBeUndefined();
    expect(
      queryClient.getQueryData(['pull-request-summaries', 'acme/repo'])
    ).toBeUndefined();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});
