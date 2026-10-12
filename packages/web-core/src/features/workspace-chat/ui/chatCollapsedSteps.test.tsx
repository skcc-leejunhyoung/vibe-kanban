import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatCollapsedSteps } from '@vibe/ui/components/ChatCollapsedSteps';

function render(expanded: boolean, headerClassName?: string) {
  return renderToStaticMarkup(
    <ChatCollapsedSteps
      label="12 steps"
      expanded={expanded}
      isHovered={false}
      onToggle={() => {}}
      onHoverChange={() => {}}
      headerClassName={headerClassName}
    >
      <div>inner step</div>
    </ChatCollapsedSteps>
  );
}

describe('ChatCollapsedSteps', () => {
  it('renders a focusable, labelled toggle and hides the steps while folded', () => {
    const html = render(false);
    expect(html).toContain('12 steps');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('inner step');
  });

  it('shows the steps when expanded and dims only the header when asked', () => {
    const html = render(true, 'opacity-50');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('inner step');
    expect(html.indexOf('opacity-50')).toBeGreaterThan(-1);
    expect(html.indexOf('opacity-50')).toBeLessThan(html.indexOf('inner step'));
  });
});
