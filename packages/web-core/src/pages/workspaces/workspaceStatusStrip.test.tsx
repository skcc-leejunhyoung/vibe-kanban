import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  StatusNoteChip,
  WorkspaceStatusStrip,
  type WorkspaceStatusStripProps,
} from '@vibe/ui/components/WorkspaceStatusStrip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const base: WorkspaceStatusStripProps = {
  headline: '로그인 직후 화면이 비는 문제를 고치고 있어요.',
  paragraphs: [
    [
      { kind: 'text', text: '원인은 ' },
      {
        kind: 'link',
        label: '응답 지연',
        target: 'notes/a.html',
        artifact: true,
      },
      { kind: 'text', text: '이에요.' },
    ],
    [{ kind: 'text', text: '이대로 진행할지 알려 주세요.' }],
  ],
  state: 'running',
  timeLabel: 'just now',
  open: false,
  onToggle: () => {},
  canPrev: false,
  canNext: false,
  onPrev: () => {},
  onNext: () => {},
  onOpenLink: () => {},
};

describe('WorkspaceStatusStrip', () => {
  it('collapsed: shows the first sentence, running dots and the time', () => {
    const html = renderToStaticMarkup(<WorkspaceStatusStrip {...base} />);
    expect(html).toContain(base.headline);
    expect(html).toContain('animate-running-dot-1');
    expect(html).toContain('border-l-brand');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('이대로 진행할지');
    const streaming = renderToStaticMarkup(
      <WorkspaceStatusStrip {...base} streaming />
    );
    expect(streaming).toContain('aria-busy="true"');
  });

  it('expanded: hides the headline, renders paragraphs and link buttons', () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatusStrip {...base} open state="idle" canPrev />
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain(`>${base.headline}<`);
    expect(html).toContain('원인은 ');
    expect(html).toContain('>응답 지연<');
    expect(html).toContain('이대로 진행할지 알려 주세요.');
    expect(html).toContain('border-l-low');
    expect(html).toContain('aria-label="status.prev"');
    // Only "next" is disabled when the latest summary is shown.
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });

  it('past: labels the time and dims the body', () => {
    const html = renderToStaticMarkup(
      <WorkspaceStatusStrip
        {...base}
        open
        isPast
        state="pending"
        timeLabel="16:40"
        canNext
      />
    );
    expect(html).toContain('status.past · 16:40');
    expect(html).toContain('text-low');
    expect(html).toContain('border-l-warning');
    const undated = renderToStaticMarkup(
      <WorkspaceStatusStrip {...base} open isPast timeLabel="" canNext />
    );
    expect(undated).toContain('>status.past<');
    expect(undated).not.toContain('status.past ·');
  });
});

describe('StatusNoteChip', () => {
  it('distinguishes a block still streaming from a finished one', () => {
    const writing = renderToStaticMarkup(
      <StatusNoteChip headline="" writing />
    );
    expect(writing).toContain('status.writing');
    expect(writing).toContain('animate-running-dot-1');
    const done = renderToStaticMarkup(
      <StatusNoteChip headline="첫 문장이에요." writing={false} time="15:28" />
    );
    expect(done).toContain('status.updated');
    expect(done).toContain('첫 문장이에요.');
    expect(done).toContain('15:28');
    expect(done).not.toContain('animate-running-dot-1');
  });
});
