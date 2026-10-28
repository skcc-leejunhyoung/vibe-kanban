import { describe, expect, it } from 'vitest';
import { collectArtifactFormValues } from './artifactInputBridge';

describe('native artifact form values', () => {
  it.each([{ selected: [] }, { selected: ['a'] }, { selected: ['a', 'b'] }])(
    'preserves an array schema with selection $selected',
    ({ selected }) => {
      const form = new FormData();
      for (const value of selected) form.append('choices', value);
      expect(collectArtifactFormValues(form.entries(), ['choices'])).toEqual({
        choices: selected,
      });
    }
  );

  it('keeps repeated names as arrays without changing scalar and number fields', () => {
    expect(
      collectArtifactFormValues([
        ['tag', 'one'],
        ['title', '한글'],
        ['tag', 'two'],
        ['count', 3],
      ])
    ).toEqual({ tag: ['one', 'two'], title: '한글', count: 3 });
  });
});
