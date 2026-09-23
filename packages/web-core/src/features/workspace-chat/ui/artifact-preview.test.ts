import { describe, expect, it } from 'vitest';
import type { ArtifactReference } from 'shared/types';
import {
  deduplicateManagedImages,
  findSegmentArtifact,
  inlinePreviewKind,
  splitArtifactSegments,
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
    // services::artifacts::is_office converts these too; both lists must agree.
    expect(inlinePreviewKind({ ...base, mime: 'application/rtf' })).toBe(
      'office'
    );
    expect(inlinePreviewKind({ ...base, mime: 'text/html' })).toBe('frame');
    expect(inlinePreviewKind({ ...base, mime: 'image/png' })).toBe('image');
    expect(inlinePreviewKind({ ...base, mime: 'image/gif' })).toBe('image');
    expect(inlinePreviewKind({ ...base, mime: 'video/mp4' })).toBe('video');
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

describe('artifact segments', () => {
  it('splits only standalone attachment lines, like the backend', () => {
    const text = [
      'Intro [source](src/main.rs)',
      '`[example](secret.txt "vibe-artifact")`',
      '> [quote](secret.txt "vibe-artifact")',
      '    [indented](secret.txt "vibe-artifact")',
      '```markdown',
      '[example](secret.txt "vibe-artifact")',
      '```',
      '[report](<reports/a b.html> "vibe-artifact")',
      'Middle text',
      '- [diagram](reports/diagram.mmd "vibe-artifact")',
      '[site](https://example.com/report "vibe-artifact")',
      '[lines](reports/a%20b.html:4:2 "vibe-artifact")',
      'Outro',
    ].join('\n');
    expect(splitArtifactSegments(text)).toEqual([
      {
        kind: 'markdown',
        text: [
          'Intro [source](src/main.rs)',
          '`[example](secret.txt "vibe-artifact")`',
          '> [quote](secret.txt "vibe-artifact")',
          '    [indented](secret.txt "vibe-artifact")',
          '```markdown',
          '[example](secret.txt "vibe-artifact")',
          '```',
        ].join('\n'),
      },
      {
        kind: 'file',
        raw: '[report](<reports/a b.html> "vibe-artifact")',
        path: 'reports/a b.html',
      },
      { kind: 'markdown', text: 'Middle text' },
      {
        kind: 'file',
        raw: '- [diagram](reports/diagram.mmd "vibe-artifact")',
        path: 'reports/diagram.mmd',
      },
      {
        kind: 'url',
        raw: '[site](https://example.com/report "vibe-artifact")',
        url: 'https://example.com/report',
      },
      {
        kind: 'file',
        raw: '[lines](reports/a%20b.html:4:2 "vibe-artifact")',
        path: 'reports/a b.html',
      },
      { kind: 'markdown', text: 'Outro' },
    ]);
    expect(
      splitArtifactSegments('[bad](file:///etc/passwd "vibe-artifact")')
    ).toEqual([
      { kind: 'markdown', text: '[bad](file:///etc/passwd "vibe-artifact")' },
    ]);
  });

  it('lifts complete marked HTML and SVG fences by backend ordinal', () => {
    const text = [
      '```js',
      'const ordinary = 1;',
      '```',
      '```mermaid vibe-artifact',
      'graph TD',
      'A-->B',
      '```',
      '```html vibe-artifact',
      '<html><body>hi</body></html>',
      '```',
      '```html vibe-artifact',
      '<div>fragment</div>',
      '```',
      '~~~svg vibe-artifact',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '~~~',
      '```html vibe-artifact',
      '<html>unfinished',
    ].join('\n');
    const segments = splitArtifactSegments(text);
    expect(
      segments.map((segment) =>
        segment.kind === 'inline' ? segment.name : segment.kind
      )
    ).toEqual([
      'markdown',
      'block-2.html',
      'markdown',
      'block-4.svg',
      'markdown',
    ]);
    expect(segments[0]).toEqual({
      kind: 'markdown',
      text: [
        '```js',
        'const ordinary = 1;',
        '```',
        '```mermaid vibe-artifact',
        'graph TD',
        'A-->B',
        '```',
      ].join('\n'),
    });
    expect(segments.at(-1)).toEqual({
      kind: 'markdown',
      text: '```html vibe-artifact\n<html>unfinished',
    });
    // A trailing space keeps the fence open, exactly like the backend.
    expect(
      splitArtifactSegments(
        '```html vibe-artifact\n<html><body>x</body></html>\n``` '
      )
    ).toHaveLength(1);
  });

  it('matches segments to registered artifacts by workspace path', () => {
    const base: ArtifactReference = {
      id: 'base',
      execution_id: 'execution',
      name: 'x',
      path: null,
      mime: 'application/pdf',
      content_hash: 'a'.repeat(64),
      source_entry: 1,
      source: 'assistant_attachment',
      url: null,
      size_bytes: 10,
      status: 'ready',
      error: null,
    };
    const file = {
      ...base,
      id: 'file',
      name: 'app/out/report.pdf',
      path: 'app/out/report.pdf',
    };
    const nested = {
      ...file,
      id: 'nested',
      name: 'app/docs/out/report.pdf',
      path: 'app/docs/out/report.pdf',
    };
    const inline = {
      ...base,
      id: 'inline',
      name: 'block-2.html',
      path: null,
      mime: 'text/html',
    };
    // Block names restart in every message of the execution.
    const earlierInline = { ...inline, id: 'earlier', source_entry: 0 };
    const remote = {
      ...base,
      id: 'url',
      path: null,
      url: 'https://example.com/report',
    };
    const artifacts = [nested, file, earlierInline, inline, remote];
    const owned = [file, inline];
    const find = (segment: Parameters<typeof findSegmentArtifact>[0]) =>
      findSegmentArtifact(segment, artifacts, owned)?.id;
    const segment = (path: string) => ({
      kind: 'file' as const,
      raw: '',
      path,
    });
    expect(find(segment('out/report.pdf'))).toBe('file');
    expect(find(segment('./out/report.pdf'))).toBe('file');
    expect(find(segment('/repo/app/out/report.pdf'))).toBe('file');
    expect(find(segment('/repo/app/docs/out/report.pdf'))).toBe('nested');
    expect(find(segment('docs/out/report.pdf'))).toBe('nested');
    expect(find(segment('other.pdf'))).toBeUndefined();
    expect(find({ kind: 'inline', raw: '', name: 'block-2.html' })).toBe(
      'inline'
    );
    expect(
      findSegmentArtifact(
        { kind: 'inline', raw: '', name: 'block-2.html' },
        artifacts,
        [file]
      )
    ).toBeUndefined();
    expect(
      find({ kind: 'url', raw: '', url: 'https://example.com/report' })
    ).toBe('url');
  });
});
