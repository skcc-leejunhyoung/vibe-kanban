import { describe, expect, it } from 'vitest';
import type { ArtifactReference } from 'shared/types';
import { deduplicateManagedImages } from './artifact-preview';

describe('managed tool image copies', () => {
  it('hides a base64 copy without merging different file or execution origins', () => {
    const original: ArtifactReference = {
      id: 'original',
      execution_id: 'execution',
      name: 'screenshot.png',
      path: 'screenshot.png',
      mime: 'image/png',
      content_hash: 'a'.repeat(64),
      source_entry: 3,
      source: 'tool_or_message',
      url: null,
      size_bytes: 100,
      status: 'ready',
      error: null,
    };
    const copy = {
      ...original,
      id: 'copy',
      path: `repo/.vibe-attachments/agent-${'a'.repeat(16)}.png`,
    };
    const otherFile = { ...original, id: 'other', path: 'other.png' };
    expect(deduplicateManagedImages([original, copy, otherFile])).toEqual([
      original,
      otherFile,
    ]);
    expect(deduplicateManagedImages([copy])).toEqual([copy]);
    for (const different of [
      { ...original, execution_id: 'other-execution' },
      { ...original, source_scope: 'codex:another-child' },
      { ...original, source_entry: 4 },
    ]) {
      expect(deduplicateManagedImages([copy, different])).toEqual([
        copy,
        different,
      ]);
    }
  });
});
