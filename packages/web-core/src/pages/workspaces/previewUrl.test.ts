import { describe, expect, it } from 'vitest';
import { getTargetDevPort } from './previewUrl';

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
});
