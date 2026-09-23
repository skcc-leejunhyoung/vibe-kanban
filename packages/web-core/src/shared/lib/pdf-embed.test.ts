import { describe, expect, it } from 'vitest';
import { canEmbedPdf } from './pdf-embed';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// iPadOS asks for desktop sites by default, so only touch points give it away.
const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

describe('canEmbedPdf', () => {
  it('falls back to canvas on iOS and iPadOS', () => {
    expect(canEmbedPdf({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(false);
    expect(canEmbedPdf({ userAgent: IPAD, maxTouchPoints: 5 })).toBe(false);
  });

  it('keeps the native viewer on desktop', () => {
    expect(canEmbedPdf({ userAgent: MAC, maxTouchPoints: 0 })).toBe(true);
  });

  it('falls back when the browser has its PDF viewer turned off', () => {
    expect(
      canEmbedPdf({
        userAgent: MAC,
        maxTouchPoints: 0,
        pdfViewerEnabled: false,
      })
    ).toBe(false);
  });
});
