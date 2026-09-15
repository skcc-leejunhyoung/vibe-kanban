import { useCallback, useEffect, useRef } from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

const DIALOG_SCOPE = 'dialog';

interface HotkeyScopeControls {
  activeScopes: string[];
  enableScope: (scope: string) => void;
  disableScope: (scope: string) => void;
}

interface ModalLayerOptions {
  /**
   * Radix modal layers set `pointer-events: none` on <body> while open. A
   * non-Radix dialog stacked above one must opt back in on itself (see
   * KeyboardDialog), so the stack records which layers do this.
   */
  blocksOutsidePointer?: boolean;
}

const openModalStack: { id: symbol; blocksOutsidePointer: boolean }[] = [];
let scopesToRestore: string[] = [];

export function registerModalKeyboardLayer(
  id: symbol,
  controls: HotkeyScopeControls,
  { blocksOutsidePointer = false }: ModalLayerOptions = {}
) {
  if (openModalStack.length === 0) {
    scopesToRestore = [...controls.activeScopes];
    scopesToRestore.forEach(controls.disableScope);
    controls.enableScope(DIALOG_SCOPE);
  }

  openModalStack.push({ id, blocksOutsidePointer });

  return () => {
    const index = openModalStack.map((layer) => layer.id).lastIndexOf(id);
    if (index === -1) return;
    openModalStack.splice(index, 1);

    if (openModalStack.length === 0) {
      controls.disableScope(DIALOG_SCOPE);
      scopesToRestore.forEach(controls.enableScope);
      scopesToRestore = [];
    }
  };
}

export function isModalKeyboardActive() {
  return openModalStack.length > 0;
}

export function isTopModalKeyboardLayer(id: symbol) {
  return openModalStack[openModalStack.length - 1]?.id === id;
}

/** Whether a pointer-blocking (Radix modal) layer sits below `id`. */
export function hasPointerBlockingLayerBelow(id: symbol) {
  const index = openModalStack.findIndex((layer) => layer.id === id);
  return openModalStack
    .slice(0, index === -1 ? undefined : index)
    .some((layer) => layer.blocksOutsidePointer);
}

/**
 * Registers an open modal as the exclusive owner of application keyboard
 * shortcuts. Native listeners can use `isModalKeyboardActive`, while
 * react-hotkeys-hook listeners are isolated through the dialog scope.
 */
export function useModalKeyboardLayer(
  open: boolean,
  options?: ModalLayerOptions
) {
  const { activeScopes, enableScope, disableScope } = useHotkeysContext();
  const blocksOutsidePointer = options?.blocksOutsidePointer ?? false;
  const idRef = useRef<symbol>();
  const activeScopesRef = useRef(activeScopes);
  activeScopesRef.current = activeScopes;

  if (!idRef.current) {
    idRef.current = Symbol('modal-keyboard-layer');
  }

  useEffect(() => {
    if (!open) return;
    return registerModalKeyboardLayer(
      idRef.current!,
      {
        activeScopes: activeScopesRef.current,
        enableScope,
        disableScope,
      },
      { blocksOutsidePointer }
    );
  }, [open, enableScope, disableScope, blocksOutsidePointer]);

  const isTopLayer = useCallback(
    () => isTopModalKeyboardLayer(idRef.current!),
    []
  );
  const isOverPointerBlockingLayer = useCallback(
    () => hasPointerBlockingLayerBelow(idRef.current!),
    []
  );

  return { isTopLayer, isOverPointerBlockingLayer };
}
