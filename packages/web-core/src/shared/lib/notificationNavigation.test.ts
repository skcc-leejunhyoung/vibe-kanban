import { describe, expect, it } from 'vitest';
import { parseNotificationNavigationPath } from './notificationNavigation';

describe('parseNotificationNavigationPath', () => {
  it('keeps a PR deep-link search parameter separate from the route path', () => {
    expect(
      parseNotificationNavigationPath(
        '/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F42'
      )
    ).toEqual({
      pathname: '/pull-requests',
      search: { prUrl: 'https://github.com/acme/repo/pull/42' },
    });
  });
});
