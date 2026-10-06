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
  const prevEditableRef = useRef(editable);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Detect transformer changes and force re-parse
  if (transformers !== prevTransformersRef.current) {
    prevTransformersRef.current = transformers;
    lastSerializedRef.current = undefined;
  }

  // Handle editable state
  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  // Handle controlled value changes (external → editor). Read-only resolves
  // `\x` and `&#NN;` like a markdown renderer while editing keeps them as
  // typed, so a mode switch re-imports: edit mode must start from the text as
  // stored, not from its rendered form.
  useEffect(() => {
    const modeChanged = editable !== prevEditableRef.current;
    prevEditableRef.current = editable;
    if (!modeChanged && value === lastSerializedRef.current) return;
    const parsedValue = normalizeGitHubImageHtml(value);

    try {
      // Lexical invokes update listeners synchronously during editor.update().
      // Tag the update so the listener skips it, and baseline the ref on what
      // the imported state exports: the round trip may still normalize
      // markers or indentation, and that must not rewrite the issue until the
      // user actually edits (selection-only updates fire the listener too).
      lastSerializedRef.current = parsedValue;
      editor.update(
        () => {
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
            $markdownToEditor(parsedValue, transformers, undefined, {
              keepEscapes: editable,
            });
          }
          // Read-only displays (streamed agent messages re-import on every
          // chunk) have no listener to baseline for, so skip the export there.
          if (onChangeRef.current) {
            lastSerializedRef.current = $editorToMarkdown(transformers);
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
        },
        { tag: IMPORT_TAG }
      );
    } catch (err) {
      lastSerializedRef.current = undefined;
      console.error('Failed to parse markdown', err);
    }
  }, [editor, value, transformers, editable]);

  // Handle editor changes (editor → external)
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      onEditorStateChange?.(editorState);
      if (!onChange || tags.has(IMPORT_TAG)) return;

      const markdown = editorState.read(() => $editorToMarkdown(transformers));

      if (markdown === lastSerializedRef.current) return;

      lastSerializedRef.current = markdown;
      onChange(markdown);
    });
  }, [editor, onChange, onEditorStateChange, transformers]);

  return null;
}
