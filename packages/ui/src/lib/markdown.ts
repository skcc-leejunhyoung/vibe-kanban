import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  type Transformer,
} from '@lexical/markdown';
import type { ElementNode } from 'lexical';

/**
 * Markdown ⇄ editor with newlines kept as typed. Lexical's default mode drops
 * blank lines and merges adjacent lines on import and re-spaces blocks on
 * export, so saved text and the re-opened document drift from what was typed.
 * Import and export must use the same mode, so both live here.
 */
export function $markdownToEditor(
  markdown: string,
  transformers: Transformer[],
  node?: ElementNode
): void {
  $convertFromMarkdownString(markdown, transformers, node, true);
}

export function $editorToMarkdown(transformers: Transformer[]): string {
  return $convertToMarkdownString(transformers, undefined, true);
}
