import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/lib/hostAccountApi', () => ({ accountRequest: vi.fn() }));
vi.mock('@/shared/lib/accountHostTransport', () => ({
  requestAccountHost: vi.fn(),
}));
vi.mock('@/shared/lib/accountHostConnection', () => ({
  watchAccountConnectionCleanup: vi.fn(() => () => {}),
}));

import {
  accountPreviewNextPath,
  canEmbedAccountPreview,
} from './accountPreview';

const page = (hostname: string, protocol = 'https:') => ({
  hostname,
  protocol,
});

describe('canEmbedAccountPreview', () => {
  it('embeds when the preview suffix is the page host or a subdomain of it', () => {
    expect(
      canEmbedAccountPreview('relay.vk.example.test', page('vk.example.test'))
    ).toBe(true);
    expect(
      canEmbedAccountPreview('.relay.vk.example.test', page('VK.example.test'))
    ).toBe(true);
    expect(
      canEmbedAccountPreview('vk.example.test', page('vk.example.test'))
    ).toBe(true);
  });

  it('keeps the new-tab flow on other sites and without a suffix', () => {
    expect(canEmbedAccountPreview('', page('vk.example.test'))).toBe(false);
    expect(
      canEmbedAccountPreview('relay.vk.example.test', page('localhost'))
    ).toBe(false);
    expect(
      canEmbedAccountPreview(
        'relay.vk.example.test',
        page('vibe-kanban.localhost')
      )
    ).toBe(false);
    // Label boundary: `k.example.test` merely ends with the same letters.
    expect(
      canEmbedAccountPreview('relay.vk.example.test', page('k.example.test'))
    ).toBe(false);
    expect(
      canEmbedAccountPreview(
        'relay.vk.example.test',
        page('vk.example.test', 'http:')
      )
    ).toBe(false);
  });
});

describe('accountPreviewNextPath', () => {
  it('keeps the path and query, minus the reload counter', () => {
    expect(
      accountPreviewNextPath(
        'https://p-5173--h.relay.vk.example.test/app/x?_refresh=2&q=1#frag'
      )
    ).toBe('/app/x?q=1');
    expect(accountPreviewNextPath('http://localhost:5173/app?_refresh=3')).toBe(
      '/app'
    );
    expect(
      accountPreviewNextPath('https://p-5173--h.relay.vk.example.test')
    ).toBe('/');
  });

  it('drops paths the relay would reject and unparsable URLs', () => {
    expect(
      accountPreviewNextPath(`https://h.example.test/${'a'.repeat(1024)}`)
    ).toBeUndefined();
    expect(accountPreviewNextPath('not a url')).toBeUndefined();
  });
});
