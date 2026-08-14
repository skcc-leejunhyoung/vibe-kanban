import { describe, expect, it } from 'vitest';
import { shouldStartBoardNavigation } from './shouldStartBoardNavigation';

describe('shouldStartBoardNavigation', () => {
  it('keeps arrow navigation available while the board owns focus', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: true,
        isBoardFocused: true,
        isDocumentUnfocused: false,
        isPaneFocused: false,
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('reclaims navigation when document focus is lost', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: true,
        isBoardFocused: false,
        isDocumentUnfocused: true,
        isPaneFocused: false,
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('does not steal arrows from controls outside the board', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: true,
        isBoardFocused: false,
        isDocumentUnfocused: false,
        isPaneFocused: false,
        isTextEditing: false,
      })
    ).toBe(false);
  });

  it('does not steal arrows while editing text', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: true,
        isBoardFocused: true,
        isDocumentUnfocused: false,
        isPaneFocused: false,
        isTextEditing: true,
      })
    ).toBe(false);
  });

  it('starts navigation when keyboard pane switching focused the pane shell', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: true,
        isBoardFocused: false,
        isDocumentUnfocused: false,
        isPaneFocused: true,
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('does not navigate from an inactive pane even when its board retained focus', () => {
    expect(
      shouldStartBoardNavigation({
        isActivePane: false,
        isBoardFocused: true,
        isDocumentUnfocused: false,
        isPaneFocused: false,
        isTextEditing: false,
      })
    ).toBe(false);
  });
});
