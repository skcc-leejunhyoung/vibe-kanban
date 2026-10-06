import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  INLINE_CODE,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';
import {
  $createTextNode,
  TEXT_TYPE_TO_FORMAT,
  TextNode,
  type ElementNode,
} from 'lexical';

const CODE_FORMAT = TEXT_TYPE_TO_FORMAT.code;

const codePoint = (digits: string): string | null => {
  const n = Number(digits);
  return n <= 0x10ffff ? String.fromCodePoint(n) : null;
};

type ImportOptions = {
  /**
   * Keep `\x` and `&#NN;` as typed (editing) instead of resolving them the
   * way a markdown renderer does (read-only display). Defaults to the mode
   * of the enclosing import, so table cells follow their document.
   */
  keepEscapes?: boolean;
};

let currentKeepEscapes = true;

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
  node?: ElementNode,
  options: ImportOptions = {}
): void {
  const previous = currentKeepEscapes;
  const keepEscapes = options.keepEscapes ?? previous;
  currentKeepEscapes = keepEscapes;
  try {
    $convertFromMarkdownString(
      prepareMarkdownForImport(markdown, transformers.includes(CHECK_LIST)),
      [
        ...(keepEscapes ? [KEEP_BACKSLASHES, KEEP_ENTITIES] : [DECODE_ENTITIES]),
        KEEP_INLINE_CODE,
        ...transformers.filter((t) => t !== INLINE_CODE),
      ],
      node,
      true
    );
  } finally {
    currentKeepEscapes = previous;
  }
}

export function $editorToMarkdown(transformers: Transformer[]): string {
  return restoreMarkdownAfterExport(
    $convertToMarkdownString(transformers, undefined, true)
  );
}

/**
 * Lexical's importer turns `\x` into `x` (x in `*_\`~\`) and decodes `&#NN;`
 * after running the text transformers over a node, and it still runs that
 * pass over the node it split off even once we have detached it. So: claim
 * the span first, blank the old node, and swap in a fresh text node that the
 * pass never sees.
 */
function swapIn(node: TextNode, text: string, format = node.getFormat()) {
  const fresh = $createTextNode(text).setFormat(format);
  node.setTextContent('');
  node.replace(fresh);
}

const KEEP_BACKSLASHES: TextMatchTransformer = {
  type: 'text-match',
  dependencies: [TextNode],
  importRegExp: /\\[\s\S]/,
  regExp: /$^/, // never: import only, not while typing
  replace: (node) => swapIn(node, node.getTextContent()),
  export: () => null,
};

/** Typed `&#NN;` stays text while editing. */
const KEEP_ENTITIES: TextMatchTransformer = {
  ...KEEP_BACKSLASHES,
  importRegExp: /&#\d+;/,
};

/** Read-only display decodes `&#NN;` like a renderer; bad ones stay text. */
const DECODE_ENTITIES: TextMatchTransformer = {
  ...KEEP_BACKSLASHES,
  importRegExp: /&#(\d+);/,
  replace: (node, match) => swapIn(node, codePoint(match[1]) ?? match[0]),
};

/**
 * Same for inline code: Lexical's own INLINE_CODE keeps the node it splits
 * off, and when the span opens the line that node is the one the unescape
 * pass runs on. Import through a fresh node instead; export still uses
 * INLINE_CODE. (Markdown never resolves escapes inside code anyway.)
 */
const KEEP_INLINE_CODE: TextMatchTransformer = {
  type: 'text-match',
  dependencies: [TextNode],
  importRegExp: /(?<![\\`])`([^`]*?[^`\s])`(?!`)/,
  regExp: /$^/,
  replace: (node, match) =>
    swapIn(node, match[1], node.getFormat() | CODE_FORMAT),
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
const BEFORE_OPENING = /(^|[\s([{"'])/.source;
const AFTER_CLOSING = /(?=\s|$|[.,;:!?)\]}"'])/.source;
const WHITESPACE_ONLY_SPAN = new RegExp(`(${TAGS})(${ENTITIES})\\1`, 'g');
const OPENING_ENTITIES = new RegExp(
  `${BEFORE_OPENING}(${TAGS})(${ENTITIES})`,
  'g'
);
const CLOSING_ENTITIES = new RegExp(
  `(${ENTITIES})(${TAGS})${AFTER_CLOSING}`,
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
 * Rewrite nested-list indentation to 4-space steps, nesting by the parent's
 * content column as CommonMark does, so 2/3-space nesting keeps its
 * structure; with `checklists`, also accept `[X]` as checked.
 */
export function prepareMarkdownForImport(
  markdown: string,
  checklists = true
): string {
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
    // Cap the marker width: Lexical always exports nesting as 4 spaces, so a
    // child of "100. a" must still count as nested on the way back in.
    columns.push(width + Math.min(list[2].length, INDENT));
    const rest = line.slice(list[1].length);
    return (
      ' '.repeat(level * INDENT) +
      (checklists ? rest.replace(/^((?:-[ \t])?[ \t]?)\[X\]/, '$1[x]') : rest)
    );
  });
}

const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (m, cp: string) => codePoint(cp) ?? m);
// Lexical only ever encodes whitespace; anything else was typed and stays.
const isWhitespaceEntities = (s: string) =>
  [...s.matchAll(/&#(\d+);/g)].every((m) => /^\s$/.test(codePoint(m[1]) ?? ''));
const whitespaceOrSame = (ents: string, replaced: string, same: string) =>
  isWhitespaceEntities(ents) ? replaced : same;

/**
 * Undo Lexical's export-side rewriting: drop the backslashes it adds before
 * `*_\`~\` and `\` outside inline code, and turn the `&#32;` it uses for
 * whitespace at the edges of formatted text back into whitespace — moved
 * outside the format markers so the markdown stays valid, decoded in place
 * inside inline code. Entities anywhere else were typed and stay.
 */
export function restoreMarkdownAfterExport(markdown: string): string {
  return mapOutsideFences(markdown, (line) =>
    unescapeOutsideCode(
      line
        .replace(WHITESPACE_ONLY_SPAN, (m, _tags, ents) =>
          whitespaceOrSame(ents, decodeEntities(ents), m)
        )
        .replace(OPENING_ENTITIES, (m, before, tags, ents) =>
          whitespaceOrSame(ents, `${before}${decodeEntities(ents)}${tags}`, m)
        )
        .replace(CLOSING_ENTITIES, (m, ents, tags) =>
          whitespaceOrSame(ents, `${tags}${decodeEntities(ents)}`, m)
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
        out += line
          .slice(i, end + 1)
          .replace(/^`((?:&#\d+;)+)/, (m, ents) =>
            whitespaceOrSame(ents, '`' + decodeEntities(ents), m)
          )
          .replace(/((?:&#\d+;)+)`$/, (m, ents) =>
            whitespaceOrSame(ents, decodeEntities(ents) + '`', m)
          );
        i = end;
      }
    } else {
      out += ch;
    }
  }
  return out;
}
