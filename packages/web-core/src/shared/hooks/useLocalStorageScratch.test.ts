import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScratchType } from 'shared/types';
import {
  clearLegacyLocalStorageScratch,
  clearLocalStorageScratchForUser,
  computeScratchIsLoading,
  localStorageScratchUpdate,
} from './useLocalStorageScratch';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('user-scoped local scratch storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('isolates drafts by user and clears only the signed-out user', () => {
    const update = {
      payload: {
        type: 'DRAFT_WORKSPACE' as const,
        data: {
          message: '',
          repos: [],
          executor_config: null,
          linked_issue: null,
          attachments: [],
          working_branch: null,
        },
      },
    };

    expect(
      localStorageScratchUpdate(
        'user-a',
        ScratchType.DRAFT_WORKSPACE,
        'draft-1',
        update
      )
    ).toBe(true);
    expect(
      localStorageScratchUpdate(
        'user-b',
        ScratchType.DRAFT_WORKSPACE,
        'draft-1',
        update
      )
    ).toBe(true);

    expect(localStorage.length).toBe(2);
    clearLocalStorageScratchForUser('user-a');

    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toContain('user-b');
  });

  it('removes legacy unscoped scratch without deleting scoped drafts', () => {
    localStorage.setItem('vk-scratch:DRAFT_WORKSPACE:draft-1', '{}');
    localStorageScratchUpdate(
      'user-a',
      ScratchType.DRAFT_WORKSPACE,
      'draft-1',
      {
        payload: {
          type: 'DRAFT_WORKSPACE',
          data: {
            message: '',
            repos: [],
            executor_config: null,
            linked_issue: null,
            attachments: [],
            working_branch: null,
          },
        },
      }
    );

    clearLegacyLocalStorageScratch();

    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toContain('vk-scratch-user:user-a:');
  });
});

describe('computeScratchIsLoading', () => {
  // Regression: while userId is unresolved the hook uses storageKey='' and
  // loadedKey=null, which must still read as "loading" so useUiPreferencesScratch
  // doesn't latch on empty data and clobber persisted preferences on re-entry.
  it('reports loading while the userId is unresolved', () => {
    expect(computeScratchIsLoading(true, null, '')).toBe(true);
  });

  it('is not loading once the effective key has been read', () => {
    expect(
      computeScratchIsLoading(
        true,
        'vk-scratch-user:u:X:1',
        'vk-scratch-user:u:X:1'
      )
    ).toBe(false);
  });

  it('reports loading while transitioning between keys', () => {
    expect(computeScratchIsLoading(true, 'old-key', 'new-key')).toBe(true);
  });

  it('is inactive (not loading) when the caller disables the scratch', () => {
    expect(computeScratchIsLoading(false, null, '')).toBe(false);
    expect(computeScratchIsLoading(false, 'old-key', 'new-key')).toBe(false);
  });
});
