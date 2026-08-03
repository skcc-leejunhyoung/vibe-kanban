import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openExternalUrl, reserveExternalWindow } from '@vibe/ui/lib/open-url';

describe('PWA external window handling', () => {
  const openedWindow = {
    opener: {} as Window | null,
    location: { href: '' },
    close: vi.fn(),
  };
  const open = vi.fn(() => openedWindow);

  beforeEach(() => {
    open.mockClear();
    openedWindow.opener = {} as Window;
    openedWindow.location.href = '';
    vi.stubGlobal('window', {
      location: { href: 'https://app.example.test/' },
      open,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens HTTP links without a feature string so they stay in the PWA', () => {
    expect(openExternalUrl('https://github.com/example/repo/issues/1')).toBe(
      true
    );

    expect(open).toHaveBeenCalledWith(
      'https://github.com/example/repo/issues/1',
      '_blank'
    );
    expect(openedWindow.opener).toBeNull();
  });

  it('navigates a window reserved before asynchronous URL resolution', () => {
    const reservedWindow = reserveExternalWindow();

    expect(openExternalUrl('/attachment/1', reservedWindow)).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(openedWindow.location.href).toBe(
      'https://app.example.test/attachment/1'
    );
  });

  it('rejects executable URL schemes', () => {
    expect(openExternalUrl('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
