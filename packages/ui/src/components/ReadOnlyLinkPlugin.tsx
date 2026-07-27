import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LinkNode } from '@lexical/link';
import { openExternalUrl } from '../lib/open-url';

/**
 * Sanitize href to block dangerous protocols.
 * Returns undefined if the href is blocked.
 */
function sanitizeHref(href?: string): string | undefined {
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  // Block dangerous protocols
  if (/^(javascript|vbscript|data):/i.test(trimmed)) return undefined;
  // Allow anchors and common relative forms (but they'll be disabled)
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/')
  )
    return trimmed;
  // Allow only https
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  // Block everything else by default
  return undefined;
}

/**
 * Check if href is an external HTTPS link.
 */
function isExternalHref(href?: string): boolean {
  if (!href) return false;
  return /^https:\/\//i.test(href);
}

function configureLink(link: HTMLAnchorElement): void {
  const href = link.getAttribute('href');
  const safeHref = sanitizeHref(href ?? undefined);

  // Lexical updates the existing anchor when a LinkNode URL changes. Remove
  // any state that this plugin applied for the previous URL before handling
  // the new one (for example, a relative link becoming an HTTPS link).
  link.onclick = null;
  link.style.cursor = '';
  link.style.pointerEvents = '';
  link.removeAttribute('role');
  link.removeAttribute('aria-disabled');

  if (!safeHref) {
    // Dangerous protocol - remove href entirely
    link.removeAttribute('href');
    link.style.cursor = 'not-allowed';
    link.style.pointerEvents = 'none';
    return;
  }

  if (isExternalHref(safeHref)) {
    // target="_blank" hands installed PWAs off to the system browser. Use
    // the shared helper so issue-body links stay inside the web app.
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openExternalUrl(safeHref);
    };
    return;
  }

  // Internal/relative link - disable clicking
  link.removeAttribute('href');
  link.style.cursor = 'not-allowed';
  link.style.pointerEvents = 'none';
  link.setAttribute('role', 'link');
  link.setAttribute('aria-disabled', 'true');
  link.title = href ?? '';
}

/**
 * Plugin that handles link sanitization and navigation in read-only mode.
 * - Blocks dangerous protocols (javascript:, vbscript:, data:)
 * - External HTTPS links: opened through the web app instead of the system browser
 * - Internal/relative links: rendered but not clickable
 */
export function ReadOnlyLinkPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Register a mutation listener to modify link DOM elements
    const unregister = editor.registerMutationListener(
      LinkNode,
      (mutations) => {
        for (const [nodeKey, mutation] of mutations) {
          if (mutation === 'destroyed') continue;

          const dom = editor.getElementByKey(nodeKey);
          if (!dom || !(dom instanceof HTMLAnchorElement)) continue;

          configureLink(dom);
        }
      }
    );

    // Also handle existing links on mount by triggering a read
    editor.getEditorState().read(() => {
      const root = editor.getRootElement();
      if (!root) return;

      const links = root.querySelectorAll('a');
      links.forEach((link) => {
        configureLink(link);
      });
    });

    return unregister;
  }, [editor]);

  return null;
}
