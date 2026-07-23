import { describe, expect, it } from 'vitest';
import { nextSettingsSection } from './settingsNavigation';

describe('nextSettingsSection', () => {
  it('moves through enabled sections and wraps at either end', () => {
    const sections = ['general', 'repos', 'organizations'] as const;
    const enabled = new Set<(typeof sections)[number]>(sections);
    const isDisabled = (section: (typeof sections)[number]) =>
      !enabled.has(section);

    expect(
      nextSettingsSection(sections, 'general', 'previous', isDisabled)
    ).toBe('organizations');
    expect(nextSettingsSection(sections, 'repos', 'next', isDisabled)).toBe(
      'organizations'
    );
    expect(
      nextSettingsSection(sections, 'organizations', 'next', isDisabled)
    ).toBe('general');
  });

  it('starts at the nearest end when the current section is disabled', () => {
    const sections = ['general', 'organizations'] as const;
    const isDisabled = (section: (typeof sections)[number]) =>
      section !== 'organizations';

    expect(nextSettingsSection(sections, 'general', 'next', isDisabled)).toBe(
      'organizations'
    );
    expect(
      nextSettingsSection(sections, 'general', 'previous', isDisabled)
    ).toBe('organizations');
  });
});
