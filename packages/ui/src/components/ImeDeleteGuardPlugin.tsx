import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection } from 'lexical';

type ImeDebugWindow = Window & {
  __vibeImeDebugLog?: unknown[];
};

/**
 * Desktop macOS Safari (WebKit). Excludes Chrome/Chromium-based browsers and
 * iOS. Used to scope the `insertReplacementText` workaround below to the only
 * engine where it is needed, so other platforms keep their native behavior.
 */
const IS_MAC_SAFARI =
  typeof navigator !== 'undefined' &&
  /Macintosh/.test(navigator.userAgent) &&
  /Safari/.test(navigator.userAgent) &&
  !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(navigator.userAgent);

function isDeleteBeforeInput(event: InputEvent): boolean {
  return (
    event.inputType === 'deleteContentBackward' ||
    event.inputType === 'deleteCompositionText' ||
    event.inputType === 'deleteWordBackward' ||
    event.inputType === 'deleteSoftLineBackward' ||
    event.inputType === 'deleteHardLineBackward'
  );
}

function isCompositionInput(event: InputEvent): boolean {
  return (
    event.inputType === 'insertCompositionText' ||
    event.inputType === 'deleteCompositionText'
  );
}

function isDeleteKeyDown(event: KeyboardEvent): boolean {
  return (
    event.key === 'Backspace' &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

function stopLexicalEvent(event: Event): void {
  (event as Event & { _lexicalHandled?: boolean })._lexicalHandled = true;
  event.stopImmediatePropagation();
}

function logImeDebug(
  label: string,
  details: Record<string, unknown> = {}
): void {
  try {
    if (window.localStorage.getItem('vibeImeDebug') !== '1') {
      return;
    }

    const entry = {
      label,
      time: Math.round(performance.now()),
      ...details,
    };
    const debugWindow = window as ImeDebugWindow;
    debugWindow.__vibeImeDebugLog ??= [];
    debugWindow.__vibeImeDebugLog.push(entry);
    console.debug('[vibe-ime]', entry);
  } catch {
    // Debug logging must never affect editor input handling.
  }
}

/**
 * IME composition guard for Hangul (and other CJK) input.
 *
 * Lexical is a controlled contentEditable: it reconciles the DOM on every input.
 * During an active IME composition that reconciliation rewrites the composing
 * text node and desyncs the OS-level composition buffer, which breaks the
 * browser's native jamo-level backspace and re-composition.
 *
 * Rather than re-implementing Hangul syllable math in JS (which can never resume
 * the OS composition buffer anyway), this plugin simply gets out of the way while
 * a composition is active: it stops Lexical's own handlers from processing the
 * delete / composition input events, letting the browser edit the DOM natively
 * (native jamo deletion, native re-composition). It never calls preventDefault,
 * so the browser still performs its default action; Lexical reconciles its state
 * from the DOM on `compositionend`.
 *
 * Outside of composition the plugin does nothing, so committed text deletes one
 * whole syllable at a time — the platform-native behavior.
 */
export function ImeDeleteGuardPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let removeRootListeners: (() => void) | undefined;

    return editor.registerRootListener((rootElement) => {
      removeRootListeners?.();
      removeRootListeners = undefined;

      if (!rootElement) {
        return;
      }

      let isNativeComposing = false;

      const isComposing = (event: KeyboardEvent | InputEvent): boolean => {
        return (
          isNativeComposing ||
          editor.isComposing() ||
          ('isComposing' in event && event.isComposing)
        );
      };

      const handleCompositionStart = () => {
        logImeDebug('compositionstart');
        isNativeComposing = true;
      };

      const handleCompositionUpdate = (event: CompositionEvent) => {
        logImeDebug('compositionupdate', { data: event.data });
      };

      const handleCompositionEnd = (event: CompositionEvent) => {
        logImeDebug('compositionend', { data: event.data });
        isNativeComposing = false;
      };

      const handleKeyDownCapture = (event: KeyboardEvent) => {
        logImeDebug('keydown', {
          editorIsComposing: editor.isComposing(),
          isComposing: event.isComposing,
          isNativeComposing,
          key: event.key,
        });

        if (!isDeleteKeyDown(event)) {
          return;
        }

        if (IS_MAC_SAFARI && !isComposing(event)) {
          // macOS Apple 두벌식 in jamo-delete mode delivers Backspace as a
          // follow-up `insertReplacementText` (한→하) that we apply in
          // handleBeforeInputCapture. If we let Lexical's own
          // KEY_BACKSPACE_COMMAND run on this keydown it deletes the whole
          // syllable first, so the replacement then lands on an already-removed
          // node and the syllable vanishes. Suppress Lexical here and let the
          // follow-up beforeinput drive the edit. In syllable-delete mode this
          // simply defers to the native `deleteContentBackward` beforeinput,
          // which Lexical still handles, so whole-syllable deletion is intact.
          logImeDebug('keydown:mac-safari-defer-to-beforeinput');
          stopLexicalEvent(event);
          return;
        }

        if (isComposing(event)) {
          logImeDebug('keydown:let-browser-delete');
          stopLexicalEvent(event);
        }
      };

      /**
       * Apply an `insertReplacementText` using the replacement string the IME
       * provides in `event.dataTransfer` (falling back to `event.data`), over
       * the event's target range.
       *
       * On desktop macOS Safari, Hangul/CJK input in this Lexical
       * contentEditable never surfaces composition events; instead every
       * syllable transition — including jamo-level backspace (한→하) — arrives
       * as an `insertReplacementText` whose replacement lives in
       * `dataTransfer.getData('text/plain')`. Lexical's built-in handler fails
       * to read it and ends up replacing the target syllable with an empty
       * string, so the whole syllable is deleted. We instead apply the
       * IME-provided string ourselves, reproducing the correct native
       * <textarea> behavior without any Hangul math.
       *
       * Returns true when it took over handling so the caller can prevent the
       * default action and stop Lexical.
       */
      const applyReplacementText = (event: InputEvent): boolean => {
        const targetRange = event.getTargetRanges?.()[0];
        if (!targetRange) {
          return false;
        }

        const replacement =
          event.dataTransfer?.getData('text/plain') || event.data || '';

        let applied = false;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.applyDOMRange(targetRange);
          selection.insertText(replacement);
          applied = true;
        });
        return applied;
      };

      const handleBeforeInputCapture = (event: InputEvent) => {
        logImeDebug('beforeinput', {
          data: event.data,
          editorIsComposing: editor.isComposing(),
          inputType: event.inputType,
          isComposing: event.isComposing,
          isNativeComposing,
        });

        if (
          IS_MAC_SAFARI &&
          event.inputType === 'insertReplacementText' &&
          !isComposing(event)
        ) {
          if (applyReplacementText(event)) {
            logImeDebug('beforeinput:apply-replacement', { data: event.data });
            event.preventDefault();
            stopLexicalEvent(event);
          }
          return;
        }

        if (!isDeleteBeforeInput(event)) {
          return;
        }

        if (isComposing(event)) {
          logImeDebug('beforeinput:let-browser-delete');
          stopLexicalEvent(event);
        }
      };

      const handleInputCapture = (event: Event) => {
        if (!(event instanceof InputEvent)) {
          return;
        }

        logImeDebug('input', {
          data: event.data,
          inputType: event.inputType,
          isComposing: event.isComposing,
          isNativeComposing,
        });

        if (isCompositionInput(event) && isComposing(event)) {
          stopLexicalEvent(event);
        }
      };

      const handleBlurCapture = () => {
        isNativeComposing = false;
      };

      rootElement.addEventListener('compositionstart', handleCompositionStart);
      rootElement.addEventListener(
        'compositionupdate',
        handleCompositionUpdate
      );
      rootElement.addEventListener('compositionend', handleCompositionEnd);
      rootElement.addEventListener('blur', handleBlurCapture, {
        capture: true,
      });
      rootElement.addEventListener('keydown', handleKeyDownCapture, {
        capture: true,
      });
      rootElement.addEventListener('beforeinput', handleBeforeInputCapture, {
        capture: true,
      });
      rootElement.addEventListener('input', handleInputCapture, {
        capture: true,
      });

      removeRootListeners = () => {
        rootElement.removeEventListener(
          'compositionstart',
          handleCompositionStart
        );
        rootElement.removeEventListener(
          'compositionupdate',
          handleCompositionUpdate
        );
        rootElement.removeEventListener('compositionend', handleCompositionEnd);
        rootElement.removeEventListener('blur', handleBlurCapture, {
          capture: true,
        });
        rootElement.removeEventListener('keydown', handleKeyDownCapture, {
          capture: true,
        });
        rootElement.removeEventListener(
          'beforeinput',
          handleBeforeInputCapture,
          { capture: true }
        );
        rootElement.removeEventListener('input', handleInputCapture, {
          capture: true,
        });
      };
    });
  }, [editor]);

  return null;
}
