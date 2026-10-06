import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { type Transformer } from '@lexical/markdown';
import { $createParagraphNode, $getRoot, type EditorState } from 'lexical';
import { normalizeGitHubImageHtml } from '@vibe/ui/lib/githubImageMarkdown';
import { $editorToMarkdown, $markdownToEditor } from '../lib/markdown';

const IMPORT_TAG = 'markdown-sync-import';

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
      // Lexical invokes update listeners synchronously during editor.update().
      // Set this first, and tag the update so the listener skips it: the
      // round trip may still normalize markers or indentation, and that must
      // not rewrite the issue before the user makes an edit.
      lastSerializedRef.current = parsedValue;
      editor.update(() => {
        if (parsedValue.trim() === '') {
          // Leave a single empty paragraph, not a childless root. A childless
          // root has no selection target, so focus landing on it (autofocus,
          // click, panel activation, or the value being cleared while focused)
          // focuses the element with no caret — the field looks focused but
          // shows no blinking cursor. An empty paragraph keeps the placeholder
          // visible (Lexical treats it as empty) while giving focus a caret.
          const root = $getRoot();
          root.clear();
          root.append($createParagraphNode());
        } else {
          $markdownToEditor(parsedValue, transformers);
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
      }, { tag: IMPORT_TAG });
    } catch (err) {
      lastSerializedRef.current = undefined;
      console.error('Failed to parse markdown', err);
    }
  }, [editor, value, transformers]);

  // Handle editor changes (editor → external)
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      onEditorStateChange?.(editorState);
      if (!onChange || tags.has(IMPORT_TAG)) return;

      const markdown = editorState.read(() =>
        $editorToMarkdown(transformers)
      );

      if (markdown === lastSerializedRef.current) return;

      lastSerializedRef.current = markdown;
      onChange(markdown);
    });
  }, [editor, onChange, onEditorStateChange, transformers]);

  return null;
}
