import { describe, expect, it, vi } from 'vitest';
import { blurFocusedElementOnEscape } from './useEscapeToBlur';

function focusableElement(tagName = 'INPUT') {
  return {
    tagName,
    blur: vi.fn(),
  } as unknown as Element & { blur: ReturnType<typeof vi.fn> };
}

function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
  };
}

describe('blurFocusedElementOnEscape', () => {
  it('blurs the focused element and consumes Escape', () => {
    const element = focusableElement();
    const event = keyEvent('Escape');

    blurFocusedElementOnEscape(event, element);

    expect(element.blur).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does not blur for another key', () => {
    const element = focusableElement();
    const event = keyEvent('Enter');

    blurFocusedElementOnEscape(event, element);

    expect(element.blur).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves Escape to an element that handles it itself', () => {
    const element = {
      tagName: 'SECTION',
      blur: vi.fn(),
      closest: vi.fn(() => ({})),
    } as unknown as Element & { blur: ReturnType<typeof vi.fn> };
    const event = keyEvent('Escape');

    blurFocusedElementOnEscape(event, element);

    expect(element.blur).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each(['BODY', 'HTML'])(
    'leaves Escape available when %s represents the unfocused document',
    (tagName) => {
      const documentRoot = focusableElement(tagName);
      const event = keyEvent('Escape');

      blurFocusedElementOnEscape(event, documentRoot);

      expect(documentRoot.blur).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  );

  it('leaves Escape available when there is no active element', () => {
    const event = keyEvent('Escape');

    blurFocusedElementOnEscape(event, null);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the split pane iframe focused', () => {
    const iframe = focusableElement('IFRAME');
    const event = keyEvent('Escape');

    blurFocusedElementOnEscape(event, iframe);

    expect(iframe.blur).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
