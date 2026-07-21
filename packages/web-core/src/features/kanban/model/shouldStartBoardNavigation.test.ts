import { describe, expect, it } from 'vitest';
import { shouldStartBoardNavigation } from './shouldStartBoardNavigation';

describe('shouldStartBoardNavigation', () => {
  it('lets an already-focused board keep navigating', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: true,
        hasCursor: true,
        hasOpenedIssue: true,
        activeElementTagName: 'DIV',
      })
    ).toBe(true);
  });

  it('starts from an unfocused page when no issue context exists', () => {
    for (const activeElementTagName of [null, 'BODY', 'HTML']) {
      expect(
        shouldStartBoardNavigation({
          isBoardFocused: false,
          hasCursor: false,
          hasOpenedIssue: false,
          activeElementTagName,
        })
      ).toBe(true);
    }
  });

  it('does not steal arrows from controls or an opened issue', () => {
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: false,
        hasCursor: false,
        hasOpenedIssue: false,
        activeElementTagName: 'BUTTON',
      })
    ).toBe(false);
    expect(
      shouldStartBoardNavigation({
        isBoardFocused: false,
        hasCursor: false,
        hasOpenedIssue: true,
        activeElementTagName: 'BODY',
      })
    ).toBe(false);
  });
});
