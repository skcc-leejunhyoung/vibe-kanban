import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  INLINE_CODE,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';
import { $createTextNode, TextNode, type ElementNode } from 'lexical';

/**
 * Markdown ⇄ editor with the text kept as typed. Lexical's defaults rewrite
 * content on every round trip: blank lines are dropped and adjacent lines
 * merged on import, blocks re-spaced on export, `*_\`~\` and backslashes
 * escaped on export and unescaped on import, `- [X]` read as unchecked, and
 * 2/3-space nested lists flattened (only 4-space steps count). The saved
 * markdown is what agents read, so none of that is wanted here. Import and
 * export must agree, so both live in this file.
 */
export function $markdownToEditor(
  markdown: string,
  transformers: Transformer[],
  node?: ElementNode
): void {
  $convertFromMarkdownString(
    prepareMarkdownForImport(markdown),
    [
      KEEP_BACKSLASHES,
      KEEP_INLINE_CODE,
      ...transformers.filter((t) => t !== INLINE_CODE),
    ],
    node,
    true
  );
}

export function $editorToMarkdown(transformers: Transformer[]): string {
  return restoreMarkdownAfterExport(
    $convertToMarkdownString(transformers, undefined, true)
  );
}

/**
 * Lexical's importer turns `\x` into `x` (x in `*_\`~\`) after running the
 * text transformers over a node. Claiming every backslash pair first and
 * swapping in a fresh text node keeps that pass away from it.
 */
const KEEP_BACKSLASHES: TextMatchTransformer = {
  type: 'text-match',
  dependencies: [TextNode],
  importRegExp: /\\[\s\S]/,
  regExp: /$^/, // never: import only, not while typing
  replace: (node) => {
    node.replace(
      $createTextNode(node.getTextContent()).setFormat(node.getFormat())
    );
  },
  export: () => null,
};

/**
 * Same for inline code: Lexical's own INLINE_CODE keeps the node it splits
 * off, and when the span opens the line that node is the one the unescape
 * pass runs on. Import through a fresh node instead; export still uses
 * INLINE_CODE.
 */
const KEEP_INLINE_CODE: TextMatchTransformer = {
  type: 'text-match',
  dependencies: [TextNode],
  importRegExp: /(?<![\\`])`([^`]*?[^`\s])`(?!`)/,
  regExp: /$^/,
  replace: (node, match) => {
    node.replace(
      $createTextNode(match[1])
        .setFormat(node.getFormat())
        .toggleFormat('code')
    );
  },
  export: () => null,
};

// Characters Lexical escapes in plain text on export.
const ESCAPED = '*_`~\\';
const LIST_LINE =
  /^([ \t]*)([-*+][ \t]|\d+\.[ \t]|(?:-[ \t])?[ \t]?\[[ xX]?\][ \t])/;
const INDENT = 4; // Lexical's LIST_INDENT_SIZE
const SINGLE_LINE_FENCE = /^[ \t]*```[^`]+(?:(?:`{1,2}|`{4,})[^`]+)*```(?:[^`]|$)/;
const TAGS = /(?:\*\*|\*|__|_|~~|==)+/.source;
const ENTITIES = /(?:&#\d+;)+/.source;
const OPENING_ENTITIES = new RegExp(`(^|\\s)(${TAGS})(${ENTITIES})`, 'g');
const CLOSING_ENTITIES = new RegExp(
  `(${ENTITIES})(${TAGS})(?=\\s|$|[.,;:!?)\\]])`,
  'g'
);

/** Walk `markdown` line by line, handing only lines outside fenced code to `fn`. */
function mapOutsideFences(
  markdown: string,
  fn: (line: string) => string
): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const opening = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (
          opening &&
          opening[0] === fence[0] &&
          opening.length >= fence.length
        ) {
          fence = null;
        }
        return line;
      }
      if (opening && !SINGLE_LINE_FENCE.test(line)) {
        fence = opening;
        return line;
      }
      return fn(line);
    })
    .join('\n');
}

/**
 * Accept `[X]` as checked and rewrite nested-list indentation to 4-space
 * steps, nesting by the parent's content column as CommonMark does, so
 * 2/3-space nesting keeps its structure.
 */
export function prepareMarkdownForImport(markdown: string): string {
  const columns: number[] = []; // content column of each open list item
  return mapOutsideFences(markdown, (line) => {
    const list = LIST_LINE.exec(line);
    if (!list) {
      if (line.trim() !== '') columns.length = 0;
      return line;
    }
    const width = list[1].replace(/\t/g, ' '.repeat(INDENT)).length;
    while (columns.length > 0 && width < columns[columns.length - 1]) {
      columns.pop();
    }
    const level = columns.length;
    columns.push(width + list[2].length);
    return (
      ' '.repeat(level * INDENT) +
      line.slice(list[1].length).replace(/^((?:- )? ?)\[X\]/, '$1[x]')
    );
  });
}

/**
 * Undo Lexical's export-side rewriting: drop the backslashes it adds before
 * `*_\`~\` and `\` outside inline code, and turn the `&#32;` it uses for
 * whitespace at the edges of formatted text back into whitespace, moved
 * outside the format markers so the markdown stays valid.
 */
export function restoreMarkdownAfterExport(markdown: string): string {
  const decode = (s: string) =>
    s.replace(/&#(\d+);/g, (_, cp: string) =>
      String.fromCodePoint(Number(cp))
    );
  return mapOutsideFences(markdown, (line) =>
    unescapeOutsideCode(
      decode(
        line
          .replace(OPENING_ENTITIES, (_, before, tags, ents) =>
            `${before}${decode(ents)}${tags}`
          )
          .replace(CLOSING_ENTITIES, (_, ents, tags) =>
            `${tags}${decode(ents)}`
          )
      )
    )
  );
}

function unescapeOutsideCode(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && ESCAPED.includes(line[i + 1] ?? '')) {
      out += line[i + 1];
      i++;
    } else if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end === -1) {
        out += ch;
      } else {
        out += line.slice(i, end + 1);
        i = end;
      }
    } else {
      out += ch;
    }
  }
  return out;
}
