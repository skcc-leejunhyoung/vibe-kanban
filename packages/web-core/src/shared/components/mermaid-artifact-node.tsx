import { CodeNode } from '@lexical/code';
import type {
  MultilineElementTransformer,
  Transformer,
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  type ElementNode,
} from 'lexical';
import { createDecoratorNode } from '@vibe/ui/components/create-decorator-node';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { MermaidDiagram } from './MermaidDiagram';

function MermaidArtifact({ data: chart }: { data: string }) {
  const { theme } = useTheme();
  return (
    <MermaidDiagram chart={chart} theme={getResolvedTheme(theme)} isolated />
  );
}

const mermaidArtifact = createDecoratorNode<string>({
  type: 'mermaid-artifact',
  serialization: {
    format: 'fenced',
    language: 'mermaid vibe-artifact',
    serialize: (chart) => chart,
    deserialize: (chart) => chart,
    validate: (chart) => chart.trim().length > 0,
  },
  component: MermaidArtifact,
  domStyle: { display: 'block' },
  keyboardSelectable: false,
});

export const MermaidArtifactNode = mermaidArtifact.Node;
export const $isMermaidArtifactNode = mermaidArtifact.isNode;

function delimiter(line: string) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  return line.startsWith('    ') ? line : line.replace(/^ {0,3}/, '');
}

function markerCount(line: string, marker: string) {
  let count = 0;
  while (line[count] === marker) count++;
  return count;
}

function appendCodeBlock(rootNode: ElementNode, info: string, source: string) {
  const language = info.split(/\s+/, 1)[0] || undefined;
  const node = new CodeNode(language);
  if (source) node.append($createTextNode(source));
  rootNode.append(node);
}

const FENCE_TRANSFORMER: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [MermaidArtifactNode, CodeNode],
  regExpStart: /^( {0,3})(`{3,}|~{3,})(.*?)\r?$/,
  replace: () => false,
  handleImportAfterStartMatch: ({
    lines,
    rootNode,
    startLineIndex,
    startMatch,
  }) => {
    const opening = startMatch[2];
    const marker = opening[0];
    const info = startMatch[3].trim();
    let endLineIndex = startLineIndex + 1;
    while (endLineIndex < lines.length) {
      const closing = delimiter(lines[endLineIndex]);
      const count = markerCount(closing, marker);
      if (count >= opening.length && count === closing.length) break;
      endLineIndex++;
    }

    const closed = endLineIndex < lines.length;
    const source = lines
      .slice(startLineIndex + 1, closed ? endLineIndex : lines.length)
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .join('\n');
    const artifactLanguage = info.endsWith(' vibe-artifact')
      ? info.slice(0, -' vibe-artifact'.length).toLowerCase()
      : '';

    if (closed && artifactLanguage === 'mermaid' && source.trim()) {
      const paragraph = $createParagraphNode();
      paragraph.append(mermaidArtifact.createNode(source.trim()));
      rootNode.append(paragraph);
    } else {
      appendCodeBlock(rootNode, info, source);
    }

    return [true, closed ? endLineIndex : lines.length - 1];
  },
};

export const MERMAID_ARTIFACT_TRANSFORMERS: Transformer[] = [
  mermaidArtifact.transformers[0],
  FENCE_TRANSFORMER,
];
