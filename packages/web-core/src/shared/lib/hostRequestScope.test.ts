import { describe, expect, it } from 'vitest';
import {
  getHostRequestScopeQueryKey,
  resolveHostRequestScope,
} from './hostRequestScope';

describe('host request scope', () => {
  it('keeps current, local/self collapse, and explicit remote scopes distinct', () => {
    expect(resolveHostRequestScope(undefined)).toEqual({ kind: 'current' });
    expect(resolveHostRequestScope(null)).toEqual({ kind: 'local' });
    expect(resolveHostRequestScope('i9-host')).toEqual({
      kind: 'host',
      hostId: 'i9-host',
    });

    expect(getHostRequestScopeQueryKey(undefined)).toBe('current');
    expect(getHostRequestScopeQueryKey(null)).toBe('local');
    expect(getHostRequestScopeQueryKey('i9-host')).toBe('i9-host');
  });
});
