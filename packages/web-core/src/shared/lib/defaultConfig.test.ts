import { describe, expect, it } from 'vitest';
import { ThemeMode } from 'shared/types';
import { DEFAULT_CONFIG, mergeRemoteConfig } from './defaultConfig';

describe('mergeRemoteConfig', () => {
  it('returns a full default config when the stored blob is null', () => {
    const merged = mergeRemoteConfig(null);
    expect(merged).toEqual(DEFAULT_CONFIG);
    // A fresh object, not the shared constant, so callers can mutate safely.
    expect(merged).not.toBe(DEFAULT_CONFIG);
  });

  it('returns defaults for a non-object blob', () => {
    expect(mergeRemoteConfig('nonsense')).toEqual(DEFAULT_CONFIG);
    expect(mergeRemoteConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it('overlays stored fields on top of the defaults', () => {
    const merged = mergeRemoteConfig({
      theme: ThemeMode.DARK,
      primary_color: '#123456',
    });
    expect(merged.theme).toBe(ThemeMode.DARK);
    expect(merged.primary_color).toBe('#123456');
    // Untouched fields keep their defaults so every field is always present.
    expect(merged.git_branch_prefix).toBe(DEFAULT_CONFIG.git_branch_prefix);
    expect(merged.language).toBe(DEFAULT_CONFIG.language);
  });
});
