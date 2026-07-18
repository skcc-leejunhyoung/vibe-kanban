import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearKanbanIssueComposerScratchForUser,
  clearLegacyKanbanIssueComposerScratch,
  readStoredComposerState,
  writeStoredComposerState,
} from './useKanbanIssueComposerScratch';

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

const entry = {
  initial: { title: '', description: null },
  draft: { title: 'private title', description: 'private description' },
};

describe('user-scoped Kanban issue composer scratch', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it('isolates drafts by user and clears only the signed-out user', () => {
    writeStoredComposerState('user-a', { project: entry });
    writeStoredComposerState('user-b', { project: entry });

    expect(readStoredComposerState('user-a')?.project?.draft.title).toBe(
      'private title'
    );
    clearKanbanIssueComposerScratchForUser('user-a');

    expect(readStoredComposerState('user-a')).toBeNull();
    expect(readStoredComposerState('user-b')).not.toBeNull();
  });

  it('expires old drafts and removes the legacy unscoped key', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    writeStoredComposerState('user-a', { project: entry });
    localStorage.setItem('vk-kanban-issue-composer', '{}');

    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'));
    clearLegacyKanbanIssueComposerScratch();

    expect(readStoredComposerState('user-a')).toBeNull();
    expect(localStorage.getItem('vk-kanban-issue-composer')).toBeNull();
  });
});
