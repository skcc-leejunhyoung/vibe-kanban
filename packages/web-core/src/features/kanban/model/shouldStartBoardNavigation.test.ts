import { describe, expect, it } from 'vitest';
import { shouldStartBoardNavigation } from './shouldStartBoardNavigation';

describe('shouldStartBoardNavigation', () => {
  it('keeps arrow navigation available while the board owns focus', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: true,
        isDocumentUnfocused: false,
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('reclaims navigation when document focus is lost', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: false,
        isDocumentUnfocused: true,
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('does not steal arrows from controls outside the board', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: false,
        isDocumentUnfocused: false,
        isTextEditing: false,
      })
    ).toBe(false);
  });

  it('does not steal arrows while editing text', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: true,
        isDocumentUnfocused: false,
        isTextEditing: true,
      })
    ).toBe(false);
  });
});
