import { describe, expect, it, vi } from 'vitest';
import { blurFocusedElementOnEscape } from './useEscapeToBlur';

function focusableElement(tagName = 'INPUT') {
  return {
    tagName,
    blur: vi.fn(),
  } as unknown as Element & { blur: ReturnType<typeof vi.fn> };
}

describe('blurFocusedElementOnEscape', () => {
  it('blurs the focused element on Escape', () => {
    const element = focusableElement();

    blurFocusedElementOnEscape({ key: 'Escape' }, element);

    expect(element.blur).toHaveBeenCalledTimes(1);
  });

  it('does not blur for another key', () => {
    const element = focusableElement();

    blurFocusedElementOnEscape({ key: 'Enter' }, element);

    expect(element.blur).not.toHaveBeenCalled();
  });

  it('keeps the split pane iframe focused', () => {
    const iframe = focusableElement('IFRAME');

    blurFocusedElementOnEscape({ key: 'Escape' }, iframe);

    expect(iframe.blur).not.toHaveBeenCalled();
  });
});
