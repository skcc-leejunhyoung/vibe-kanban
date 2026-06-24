import { describe, it, expect } from 'vitest';
import {
  shouldUseSavedProject,
  type SavedProjectInput,
} from './savedProjectDestination';

const input = (over: Partial<SavedProjectInput> = {}): SavedProjectInput => ({
  savedOrgId: 'org-1',
  savedProjectId: 'proj-1',
  collectionReady: false,
  savedProjectExists: false,
  ...over,
});

describe('shouldUseSavedProject', () => {
  describe('no usable saved selection → full remote lookup', () => {
    it('returns false when no org is saved', () => {
      expect(shouldUseSavedProject(input({ savedOrgId: null }))).toBe(false);
    });

    it('returns false when no project is saved', () => {
      expect(shouldUseSavedProject(input({ savedProjectId: null }))).toBe(
        false
      );
    });

    it('treats empty strings as missing', () => {
      expect(
        shouldUseSavedProject(input({ savedOrgId: '', savedProjectId: '' }))
      ).toBe(false);
    });
  });

  describe('cold collection (PWA cold start) → optimistic', () => {
    it('uses the saved project without waiting when the collection is not ready', () => {
      // The whole point: skip the multi-second Electric sync on cold start.
      expect(
        shouldUseSavedProject(
          input({ collectionReady: false, savedProjectExists: false })
        )
      ).toBe(true);
    });
  });

  describe('warm collection (normal tab) → verify', () => {
    it('uses the saved project when it still exists', () => {
      expect(
        shouldUseSavedProject(
          input({ collectionReady: true, savedProjectExists: true })
        )
      ).toBe(true);
    });

    it('falls back to full lookup when the saved project is gone (stale)', () => {
      expect(
        shouldUseSavedProject(
          input({ collectionReady: true, savedProjectExists: false })
        )
      ).toBe(false);
    });
  });
});
