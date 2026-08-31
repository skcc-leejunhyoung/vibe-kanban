import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatSubagentEntry } from '@vibe/ui/components/ChatSubagentEntry';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function render(props: Partial<Parameters<typeof ChatSubagentEntry>[0]> = {}) {
  return renderToStaticMarkup(
    <ChatSubagentEntry
      description="Audit auth flow"
      renderMarkdown={({ content }) => <span>{content}</span>}
      {...props}
    />
  );
}

describe('ChatSubagentEntry activity panel', () => {
  it('shows role, latest activity and elapsed time while running', () => {
    const html = render({
      subagentType: 'Explore',
      status: { status: 'created' },
      lastActivity: 'Reading src/auth.rs',
      durationMs: 65_000,
    });

    expect(html).toContain('Explore');
    expect(html).toContain('Audit auth flow');
    expect(html).toContain('Reading src/auth.rs');
    expect(html).toContain('1m 5s');
  });

  it('renders legacy entries without the new fields as before', () => {
    const html = render({ status: { status: 'success' } });

    expect(html).toContain('Audit auth flow');
    // no elapsed badge markup
    expect(html).not.toContain('tabular-nums');
  });

  it('hides the activity line when it repeats the description', () => {
    const html = render({ lastActivity: 'Audit auth flow' });

    expect(html.match(/Audit auth flow/g)).toHaveLength(1);
  });

  it('styles failed subagents as errors', () => {
    const html = render({ status: { status: 'failed' }, durationMs: 3_000 });

    expect(html).toContain('border-error');
    expect(html).toContain('3s');
  });

  it('formats hour-long runtimes compactly', () => {
    const html = render({ durationMs: 3_720_000 });

    expect(html).toContain('1h 2m');
  });
});
