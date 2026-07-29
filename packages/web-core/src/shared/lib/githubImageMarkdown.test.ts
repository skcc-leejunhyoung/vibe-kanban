import { describe, expect, it } from 'vitest';
import { normalizeGitHubImageHtml } from '@vibe/ui/lib/githubImageMarkdown';

describe('normalizeGitHubImageHtml', () => {
  it('converts GitHub issue attachment HTML into Markdown image syntax', () => {
    expect(
      normalizeGitHubImageHtml(
        '<img width="1920" height="1023" alt="Image" src="https://github.com/user-attachments/assets/83eb7f24-f78a-4127-998c-5b0b1a476afa" />'
      )
    ).toBe(
      '![Image](https://github.com/user-attachments/assets/83eb7f24-f78a-4127-998c-5b0b1a476afa)'
    );
  });

  it('preserves non-GitHub image HTML as text', () => {
    const image = '<img alt="Tracker" src="https://example.com/pixel.png">';
    expect(normalizeGitHubImageHtml(image)).toBe(image);
  });

  it('escapes Markdown syntax in an image alt attribute', () => {
    expect(
      normalizeGitHubImageHtml(
        '<img alt="[Build]" src="https://github.com/user-attachments/assets/example">'
      )
    ).toBe(
      '![\\[Build\\]](https://github.com/user-attachments/assets/example)'
    );
  });
});
