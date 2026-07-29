import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $convertToMarkdownString,
  $convertFromMarkdownString,
  type Transformer,
} from '@lexical/markdown';
import { $getRoot, type EditorState } from 'lexical';
import { normalizeGitHubImageHtml } from '@vibe/ui/lib/githubImageMarkdown';

type MarkdownSyncPluginProps = {
  value: string;
  onChange?: (markdown: string) => void;
  onEditorStateChange?: (state: EditorState) => void;
  editable: boolean;
  transformers: Transformer[];
};

/**
 * Handles bidirectional markdown synchronization between Lexical editor and external state.
 *
 * Uses an internal ref to prevent infinite update loops during bidirectional sync.
 */
export function MarkdownSyncPlugin({
  value,
  onChange,
  onEditorStateChange,
  editable,
  transformers,
}: MarkdownSyncPluginProps) {
  const [editor] = useLexicalComposerContext();
  const lastSerializedRef = useRef<string | undefined>(undefined);
  const prevTransformersRef = useRef(transformers);

  // Detect transformer changes and force re-parse
  if (transformers !== prevTransformersRef.current) {
    prevTransformersRef.current = transformers;
    lastSerializedRef.current = undefined;
  }

  // Handle editable state
  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  // Handle controlled value changes (external → editor)
  useEffect(() => {
    if (value === lastSerializedRef.current) return;
    const parsedValue = normalizeGitHubImageHtml(value);

    try {
      editor.update(() => {
        if (parsedValue.trim() === '') {
          $getRoot().clear();
        } else {
          $convertFromMarkdownString(parsedValue, transformers);
        }

        // Only position cursor at end if editor already has focus (user is actively editing)
        // This prevents unwanted focus when value changes externally (e.g., panel opening)
        const rootElement = editor.getRootElement();
        if (rootElement?.contains(document.activeElement)) {
          const root = $getRoot();
          const lastNode = root.getLastChild();
          if (lastNode) {
            lastNode.selectEnd();
          }
        }
      });
      // Avoid rewriting imported GitHub HTML until the user actually edits it.
      // The editor serializes the normalized representation as Markdown.
      lastSerializedRef.current = parsedValue;
    } catch (err) {
      console.error('Failed to parse markdown', err);
    }
  }, [editor, value, transformers]);

  // Handle editor changes (editor → external)
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      onEditorStateChange?.(editorState);
      if (!onChange) return;

      const markdown = editorState.read(() =>
        $convertToMarkdownString(transformers)
      );

      if (markdown === lastSerializedRef.current) return;

      lastSerializedRef.current = markdown;
      onChange(markdown);
    });
  }, [editor, onChange, onEditorStateChange, transformers]);

  return null;
}
