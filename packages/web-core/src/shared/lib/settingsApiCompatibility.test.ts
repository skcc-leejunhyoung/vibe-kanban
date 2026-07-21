import { describe, expect, it, vi } from 'vitest';
import type { Config, UserSystemInfo } from 'shared/types';
import {
  getCompatibleConfigSaveBody,
  getCompatibleHostAppearance,
  getCompatibleProfilesSaveBody,
  getCompatibleProfilesSaveRevision,
  LEGACY_UNVERSIONED_REVISION,
  withCompatibleProfilesRevision,
  withCompatibleUserSystemRevisions,
} from './api';

describe('settings API rolling-upgrade compatibility', () => {
  const config = { git_branch_prefix: 'vk' } as Config;

  it('marks revision-less responses as legacy', () => {
    const info = withCompatibleUserSystemRevisions({
      config,
    } as UserSystemInfo);
    const profiles = withCompatibleProfilesRevision({
      content: '{}',
      path: '/tmp/profiles.json',
    });

    expect(info.config_revision).toBe(LEGACY_UNVERSIONED_REVISION);
    expect(info.profiles_revision).toBe(LEGACY_UNVERSIONED_REVISION);
    expect(profiles.revision).toBe(LEGACY_UNVERSIONED_REVISION);
  });

  it('uses legacy request bodies only for revision-less hosts', () => {
    expect(
      getCompatibleConfigSaveBody(config, LEGACY_UNVERSIONED_REVISION)
    ).toBe(config);
    expect(getCompatibleConfigSaveBody(config, 'revision-1')).toEqual({
      config,
      revision: 'revision-1',
    });

    const content = '{"executors":{}}';
    expect(
      getCompatibleProfilesSaveBody(content, LEGACY_UNVERSIONED_REVISION)
    ).toBe(content);
    expect(
      JSON.parse(getCompatibleProfilesSaveBody(content, 'revision-1'))
    ).toEqual({ content, revision: 'revision-1' });
  });

  it('keeps the legacy sentinel after a legacy host save response', () => {
    expect(
      getCompatibleProfilesSaveRevision(
        'Executor profiles updated successfully',
        LEGACY_UNVERSIONED_REVISION
      )
    ).toBe(LEGACY_UNVERSIONED_REVISION);
    expect(getCompatibleProfilesSaveRevision('next', 'current')).toBe('next');
  });

  it('uses the lightweight host appearance response when available', async () => {
    const loadLegacy = vi.fn();
    const response = new Response(
      JSON.stringify({
        success: true,
        data: { primary_color: '#123456' },
      }),
      { status: 200 }
    );

    await expect(
      getCompatibleHostAppearance(response, loadLegacy)
    ).resolves.toEqual({ primary_color: '#123456' });
    expect(loadLegacy).not.toHaveBeenCalled();
  });

  it('falls back to legacy user-system info for older hosts', async () => {
    const legacyInfo = {
      config: { ...config, primary_color: '#654321' },
    } as UserSystemInfo;

    await expect(
      getCompatibleHostAppearance(
        new Response(null, { status: 404 }),
        async () => legacyInfo
      )
    ).resolves.toEqual({ primary_color: '#654321' });
  });
});
