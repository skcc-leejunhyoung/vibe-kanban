import { describe, expect, it } from 'vitest';
import type { ArtifactReference } from 'shared/types';
import {
  deduplicateManagedImages,
  inlinePreviewKind,
  subagentScope,
} from './artifact-preview';

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

describe('inline previews', () => {
  const base: ArtifactReference = {
    id: 'report',
    execution_id: 'execution',
    name: 'out/report.pdf',
    path: 'out/report.pdf',
    mime: 'application/pdf',
    content_hash: 'a'.repeat(64),
    source_entry: 1,
    source: 'assistant_attachment',
    url: null,
    size_bytes: 10,
    status: 'ready',
    error: null,
  };

  it('renders documents and images inline and keeps the rest as cards', () => {
    expect(inlinePreviewKind(base)).toBe('pdf');
    expect(
      inlinePreviewKind({
        ...base,
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
    ).toBe('office');
    expect(inlinePreviewKind({ ...base, mime: 'text/html' })).toBe('frame');
    expect(inlinePreviewKind({ ...base, mime: 'image/png' })).toBe('image');
    expect(inlinePreviewKind({ ...base, mime: 'text/vnd.mermaid' })).toBe(
      'mermaid'
    );
    expect(inlinePreviewKind({ ...base, mime: 'text/markdown' })).toBeNull();
    expect(
      inlinePreviewKind({ ...base, status: 'preparing', content_hash: null })
    ).toBeNull();
    expect(
      inlinePreviewKind({ ...base, url: 'https://example.com/report' })
    ).toBeNull();
  });

  it('mirrors the backend subagent scope key', () => {
    expect(subagentScope({ executor: 'codex', thread_id: 't1' })).toBe(
      'codex:t1'
    );
    expect(
      subagentScope({
        executor: 'claude_code',
        task_id: 'k1',
        output_file: null,
      })
    ).toBe('claude:k1');
  });
});
