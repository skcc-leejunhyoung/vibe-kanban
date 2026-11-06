import { show } from '@ebay/nice-modal-react';
import { expect, it, vi } from 'vitest';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { configureAuthRuntime } from '@/shared/lib/auth/runtime';

vi.mock('@ebay/nice-modal-react', () => ({
  create: (component: unknown) => component,
  useModal: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  remove: vi.fn(),
}));

// Shared login prompts call OAuthDialog.show; browser shells must redirect
// to central OAuth instead of opening the local handoff dialog.
it('redirects instead of opening the local dialog when the runtime can', async () => {
  const redirectToOAuth = vi.fn().mockResolvedValue(undefined);
  configureAuthRuntime({
    getToken: vi.fn(),
    triggerRefresh: vi.fn(),
    registerShape: vi.fn(),
    getCurrentUser: vi.fn(),
    redirectToOAuth,
  });
  await expect(OAuthDialog.show({ reauthenticate: true })).resolves.toBeNull();
  expect(redirectToOAuth).toHaveBeenCalledExactlyOnceWith(undefined, true);
  expect(show).not.toHaveBeenCalled();
});
