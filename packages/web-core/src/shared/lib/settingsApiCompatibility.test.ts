import { describe, expect, it } from 'vitest';
import type { Config, UserSystemInfo } from 'shared/types';
import {
  getCompatibleConfigSaveBody,
  getCompatibleProfilesSaveBody,
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
});
