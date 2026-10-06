import { describe, expect, it } from 'vitest';
import { removeAttachmentMarkdownBySource } from './attachmentUtils';

describe('removeAttachmentMarkdownBySource', () => {
  it('drops the attachment line and the blank lines around it only', () => {
    const content = '- a\n  - b  \n\n![x](attachment://1)\n\n\n\nc\n\n\n\nd';
    expect(removeAttachmentMarkdownBySource(content, 'attachment://1')).toEqual(
      { content: '- a\n  - b  \n\nc\n\n\n\nd', removed: true }
    );
  });

  it('removes an inline attachment with one of its surrounding spaces', () => {
    expect(
      removeAttachmentMarkdownBySource(
        'see [f](attachment://1) here',
        'attachment://1'
      )
    ).toEqual({ content: 'see here', removed: true });
  });

  it('leaves content alone when the source is absent', () => {
    expect(removeAttachmentMarkdownBySource('a\n\n\nb', 'x')).toEqual({
      content: 'a\n\n\nb',
      removed: false,
    });
  });
});
