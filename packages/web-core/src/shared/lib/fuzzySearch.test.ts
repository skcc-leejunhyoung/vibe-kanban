import { describe, expect, it } from 'vitest';
import { fuzzySearchMatch, fuzzySearchMatchAny } from '@vibe/ui/lib/search';

describe('fuzzySearchMatch', () => {
  it('matches ordered non-contiguous characters', () => {
    expect(fuzzySearchMatch('프로젝트', '프젝')).toBe(true);
    expect(fuzzySearchMatch('Command Palette', 'cmdpal')).toBe(true);
  });

  it('normalizes case and compatibility characters', () => {
    expect(fuzzySearchMatch('Workspace', 'WKS')).toBe(true);
    expect(fuzzySearchMatch('ＡＢＣ', 'abc')).toBe(true);
  });

  it('keeps character order significant', () => {
    expect(fuzzySearchMatch('프로젝트', '젝프')).toBe(false);
  });

  it('matches across multiple searchable fields', () => {
    expect(fuzzySearchMatchAny(['title', 'long body text'], 'lgbt')).toBe(true);
  });

  it('matches a Unicode URL preserved in a command label', () => {
    const url = 'https://figma.com/design/123/-공유--WISDOM-개선';
    expect(fuzzySearchMatch(`Goto: ${url}`, url)).toBe(true);
  });
});
