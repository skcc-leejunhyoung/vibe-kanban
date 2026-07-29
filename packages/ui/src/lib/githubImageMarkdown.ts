const GITHUB_ATTACHMENT_PATH_PREFIX = '/user-attachments/assets/';

function getHtmlAttribute(tag: string, name: string): string | null {
  const attribute = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  );
  const match = tag.match(attribute);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isGitHubAttachmentUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(GITHUB_ATTACHMENT_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

function escapeMarkdownImageAltText(altText: string): string {
  return altText.replace(/[\[\]\\]/g, '\\$&');
}

/**
 * GitHub emits uploaded issue images as raw HTML rather than Markdown. Lexical's
 * Markdown importer deliberately treats raw HTML as text, so normalize only the
 * trusted GitHub attachment form to the image syntax our editor understands.
 */
export function normalizeGitHubImageHtml(markdown: string): string {
  return markdown.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = getHtmlAttribute(tag, 'src');
    if (!src || !isGitHubAttachmentUrl(src)) {
      return tag;
    }

    const altText = getHtmlAttribute(tag, 'alt') ?? 'Image';
    return `![${escapeMarkdownImageAltText(altText)}](${src})`;
  });
}
