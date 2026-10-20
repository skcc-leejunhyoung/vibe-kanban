import { describe, expect, it } from 'vitest';
import { getTargetDevPort, transformProxyUrlToDevUrl } from './previewUrl';

describe('getTargetDevPort', () => {
  it('reads the dev server port from a remote preview hostname', () => {
    expect(
      getTargetDevPort(
        new URL('https://4173--host.preview.example.com/page'),
        47824,
        'preview.example.com'
      )
    ).toBe('4173');
  });

  it('reads the dev server port from a protected remote preview hostname', () => {
    expect(
      getTargetDevPort(
        new URL('https://p-4173--host.preview.example.com/page'),
        47824,
        'preview.example.com'
      )
    ).toBe('4173');
  });

  it('reads the dev server port from the local proxy hostname', () => {
    expect(
      getTargetDevPort(new URL('http://4173.localhost:47824/page'), 47824)
    ).toBe('4173');
  });

  // Caddy terminates TLS for `*.vibe-kanban.localhost` and forwards to the
  // preview proxy, so the proxy host gains a label and loses its port.
  it('reads the dev server port from a TLS-fronted proxy hostname', () => {
    expect(
      getTargetDevPort(
        new URL('https://4173.vibe-kanban.localhost/page'),
        47824
      )
    ).toBe('4173');
  });

  it('falls back to the URL port for a plain dev server URL', () => {
    expect(getTargetDevPort(new URL('http://localhost:4173/page'), 47824)).toBe(
      '4173'
    );
  });
});

describe('transformProxyUrlToDevUrl', () => {
  it('maps a proxy URL back to the dev server URL', () => {
    expect(
      transformProxyUrlToDevUrl(
        'http://4173.localhost:47824/page?_refresh=2&q=1',
        '4173'
      )
    ).toBe('http://localhost:4173/page?q=1');
  });

  // The proxy's https is Caddy's TLS, not the dev server's protocol.
  it('maps a TLS-fronted proxy URL back to an http dev server URL', () => {
    expect(
      transformProxyUrlToDevUrl(
        'https://4173.vibe-kanban.localhost/page?_refresh=2',
        '4173',
        'http:'
      )
    ).toBe('http://localhost:4173/page');
  });

  it('keeps the protocol of an https dev server', () => {
    expect(
      transformProxyUrlToDevUrl(
        'https://8443.vibe-kanban.localhost/admin?session=1&_refresh=2',
        '8443',
        'https:'
      )
    ).toBe('https://localhost:8443/admin?session=1');
    expect(
      transformProxyUrlToDevUrl(
        'https://443.vibe-kanban.localhost/page',
        '443',
        'https:'
      )
    ).toBe('https://localhost/page');
  });

  it('ignores hostnames that are not loopback proxies', () => {
    expect(
      transformProxyUrlToDevUrl('https://4173.preview.example.com/page', '4173')
    ).toBeNull();
    // `notlocalhost` merely ends with the same letters — rewriting it to
    // localhost would silently navigate to a different host.
    expect(
      transformProxyUrlToDevUrl('https://4173.notlocalhost/page', '4173')
    ).toBeNull();
  });
});
