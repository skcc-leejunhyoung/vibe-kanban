import { describe, expect, it } from 'vitest';
import { shouldStartBoardNavigation } from './shouldStartBoardNavigation';

describe('shouldStartBoardNavigation', () => {
  it('keeps arrow navigation available outside text editing', () => {
    expect(
      shouldStartBoardNavigation({
        isTextEditing: false,
      })
    ).toBe(true);
  });

  it('does not steal arrows while editing text', () => {
    expect(
      shouldStartBoardNavigation({
        isTextEditing: true,
      })
    ).toBe(false);
  });
});
