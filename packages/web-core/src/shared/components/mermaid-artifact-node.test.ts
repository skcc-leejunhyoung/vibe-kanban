import { CodeNode, $isCodeNode } from '@lexical/code';
import { $convertFromMarkdownString } from '@lexical/markdown';
import {
  $getRoot,
  $isElementNode,
  createEditor,
  type LexicalNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import {
  $isMermaidArtifactNode,
  MERMAID_ARTIFACT_TRANSFORMERS,
  MermaidArtifactNode,
} from './mermaid-artifact-node';

function parse(markdown: string) {
  const editor = createEditor({
    nodes: [CodeNode, MermaidArtifactNode],
    onError: (error) => {
      throw error;
    },
  });
  const result = { charts: [] as string[], code: [] as string[] };
  editor.update(
    () => {
      $convertFromMarkdownString(markdown, MERMAID_ARTIFACT_TRANSFORMERS);
      const visit = (node: LexicalNode) => {
        if ($isMermaidArtifactNode(node)) result.charts.push(node.getData());
        if ($isCodeNode(node)) result.code.push(node.getTextContent());
        if ($isElementNode(node)) node.getChildren().forEach(visit);
      };
      $getRoot().getChildren().forEach(visit);
    },
    { discrete: true }
  );
  return result;
}

describe('selected Mermaid artifact fences', () => {
  it('renders only complete top-level selections using backend fence rules', () => {
    expect(
      parse(
        '```js\r\nconst ordinary = true;\r\n```\r\n\r\n~~~MERMAID vibe-artifact\r\nflowchart LR\r\n A-->B\r\n  ~~~~'
      )
    ).toEqual({
      charts: ['flowchart LR\n A-->B'],
      code: ['const ordinary = true;'],
    });
    for (const markdown of [
      '```mermaid\nflowchart LR\n A-->B\n```',
      '```mermaid vibe-artifact\n```',
      '```mermaid vibe-artifact\nflowchart LR\n A-->B',
      '~~~~text\n```mermaid vibe-artifact\nflowchart LR\n A-->B\n```\n~~~~',
      '```mermaid vibe-artifact\nflowchart LR\n A-->B\n``` ',
    ]) {
      expect(parse(markdown).charts).toEqual([]);
    }
  });
});
