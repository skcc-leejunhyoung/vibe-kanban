import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundledBinaryData } from './pdf-cmaps';

describe('BundledBinaryData', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serves a CJK CMap from the bundle', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetch);
    const data = await new BundledBinaryData().fetch({
      kind: 'cMapUrl',
      filename: 'UniKS-UCS2-H.bcmap',
    });
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(String(fetch.mock.calls[0])).toMatch(/UniKS-UCS2-H.*\.bcmap/);
  });

  it('rejects data it does not bundle', async () => {
    await expect(
      new BundledBinaryData().fetch({
        kind: 'wasmUrl',
        filename: 'openjpeg.wasm',
      })
    ).rejects.toThrow();
  });
});
