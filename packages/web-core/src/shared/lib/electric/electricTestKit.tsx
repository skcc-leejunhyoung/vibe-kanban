import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { configureAuthRuntime } from '@/shared/lib/auth/runtime';

/**
 * Test kit for the Electric collection layer.
 *
 * `fakeElectricCollectionOptions` replaces `electricCollectionOptions` (via
 * `vi.mock('@tanstack/electric-db-collection', ...)`) with a sync whose
 * begin/write/commit/markReady handles are captured in `electricSessions`, so
 * tests drive "Electric" by hand while the real TanStack collection, cache and
 * hybrid fallback logic run unchanged.
 */

type FakeSyncParams = {
  collection: { isReady: () => boolean };
  begin: () => void;
  write: (message: {
    type: 'insert' | 'update' | 'delete';
    value: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

export interface FakeElectricSession {
  /** Collection id the session belongs to (`<table>-<param values>`). */
  id: string;
  params: FakeSyncParams;
  cleanup: ReturnType<typeof vi.fn>;
}

export const electricSessions: FakeElectricSession[] = [];
/** ShapeStream options handed to Electric, keyed by collection id. */
export const shapeOptionsById = new Map<
  string,
  { params?: Record<string, unknown> }
>();

export function resetElectricSessions(): void {
  electricSessions.length = 0;
  shapeOptionsById.clear();
}

export function fakeElectricCollectionOptions(config: {
  id: string;
  getKey: (item: Record<string, unknown>) => string;
  gcTime?: number;
  shapeOptions?: { params?: Record<string, unknown> };
  onInsert?: unknown;
  onUpdate?: unknown;
  onDelete?: unknown;
}) {
  if (config.shapeOptions) {
    shapeOptionsById.set(config.id, config.shapeOptions);
  }
  return {
    id: config.id,
    getKey: config.getKey,
    gcTime: config.gcTime,
    onInsert: config.onInsert,
    onUpdate: config.onUpdate,
    onDelete: config.onDelete,
    sync: {
      rowUpdateMode: 'partial',
      sync: (params: FakeSyncParams) => {
        const session: FakeElectricSession = {
          id: config.id,
          params,
          cleanup: vi.fn(),
        };
        electricSessions.push(session);
        return { cleanup: session.cleanup };
      },
    },
    utils: {},
  };
}

/** Last session opened for a collection id (a table, or `<table>-<params>`). */
export function lastSessionFor(idPrefix: string): FakeElectricSession {
  const session = [...electricSessions]
    .reverse()
    .find((s) => s.id === idPrefix || s.id.startsWith(`${idPrefix}-`));
  if (!session) {
    throw new Error(`No Electric session for ${idPrefix}`);
  }
  return session;
}

/** Push a full snapshot into a session and mark it ready. */
export function emitSnapshot(
  session: FakeElectricSession,
  rows: Record<string, unknown>[]
): void {
  session.params.begin();
  for (const row of rows) {
    session.params.write({ type: 'insert', value: row, metadata: {} });
  }
  session.params.commit();
  session.params.markReady();
}

export function emitChange(
  session: FakeElectricSession,
  type: 'insert' | 'update' | 'delete',
  row: Record<string, unknown>
): void {
  session.params.begin();
  session.params.write({ type, value: row, metadata: {} });
  session.params.commit();
}

/**
 * Seed every open session from a `table -> rows` map (unknown tables get an
 * empty snapshot). Collection ids are `<table>-<param value>`.
 */
export function emitSnapshotsByTable(
  rowsByTable: Record<string, Record<string, unknown>[]>
): void {
  for (const session of electricSessions) {
    const base = session.id.replace(/-mut$/, '');
    const table = base.slice(0, base.lastIndexOf('-'));
    emitSnapshot(session, rowsByTable[table] ?? []);
  }
}

export function configureTestAuthRuntime(): {
  unregisterShape: ReturnType<typeof vi.fn>;
  registerShape: ReturnType<typeof vi.fn>;
} {
  const unregisterShape = vi.fn();
  const registerShape = vi.fn(() => unregisterShape);
  configureAuthRuntime({
    getToken: async () => 'test-token',
    triggerRefresh: async () => null,
    registerShape,
    getCurrentUser: async () => ({ user_id: 'user-1' }),
  });
  return { unregisterShape, registerShape };
}

interface FakeNode extends EventTarget {
  nodeType: number;
  parentNode: FakeNode | null;
  removeChild?: (child: FakeNode) => FakeNode;
  contains?: (other: FakeNode | null) => boolean;
  [key: string]: unknown;
}

/**
 * Just enough Node/Element for react-dom's commit phase (create, append,
 * insert, remove, attributes, styles, text). No layout, CSS or real events.
 */
function createFakeNode(ownerDocument: object, tagName: string): FakeNode {
  const childNodes: FakeNode[] = [];
  const attributes: Record<string, string> = {};
  const node = new EventTarget() as FakeNode;
  Object.assign(node, {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    nodeName: tagName.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument,
    parentNode: null,
    childNodes,
    style: { setProperty() {}, removeProperty() {} },
    textContent: '',
    setAttribute(name: string, value: unknown) {
      attributes[name] = String(value);
    },
    removeAttribute(name: string) {
      delete attributes[name];
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return name in attributes;
    },
    appendChild(child: FakeNode) {
      child.parentNode?.removeChild?.(child);
      child.parentNode = node;
      childNodes.push(child);
      return child;
    },
    insertBefore(child: FakeNode, before: FakeNode | null) {
      child.parentNode?.removeChild?.(child);
      child.parentNode = node;
      const index = before ? childNodes.indexOf(before) : -1;
      childNodes.splice(index < 0 ? childNodes.length : index, 0, child);
      return child;
    },
    removeChild(child: FakeNode) {
      const index = childNodes.indexOf(child);
      if (index >= 0) childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    contains(other: FakeNode | null): boolean {
      return (
        other === node || childNodes.some((c) => Boolean(c.contains?.(other)))
      );
    },
    focus() {},
    blur() {},
    scrollIntoView() {},
  });
  Object.defineProperties(node, {
    firstChild: { get: () => childNodes[0] ?? null },
    lastChild: { get: () => childNodes[childNodes.length - 1] ?? null },
  });
  return node;
}

function createFakeTextNode(ownerDocument: object, text: string): FakeNode {
  return Object.assign(new EventTarget() as FakeNode, {
    nodeType: 3,
    nodeName: '#text',
    ownerDocument,
    parentNode: null,
    nodeValue: text,
    textContent: text,
    contains: () => false,
  });
}

function installFakeDocument(withElements: boolean): FakeNode {
  const document = Object.assign(new EventTarget() as FakeNode, {
    nodeType: 9,
    nodeName: '#document',
    visibilityState: 'visible',
    activeElement: null,
  });
  if (withElements) {
    Object.assign(document, {
      createElement: (tag: string) => createFakeNode(document, tag),
      createElementNS: (_ns: string, tag: string) =>
        createFakeNode(document, tag),
      createTextNode: (text: string) => createFakeTextNode(document, text),
    });
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      setTimeout,
      clearTimeout,
      HTMLIFrameElement: class {},
    })
  );
  return document;
}

function createReactHarness(container: FakeNode) {
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    render: async (node: ReactNode) => {
      await act(() => root.render(node));
    },
    unmount: async () => {
      await act(() => root.unmount());
    },
  };
}

/**
 * React without a DOM: probes render no host nodes, so a bare EventTarget is
 * enough for the root container. Effects, memoization, context and Profiler
 * all run for real.
 */
export function installDomlessReact(): {
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
} {
  const document = installFakeDocument(false);
  const container = Object.assign(new EventTarget() as FakeNode, {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  return createReactHarness(container);
}

/**
 * React on the fake DOM above, for components that render real host elements
 * (divs, buttons, text) without jsdom.
 */
export function installFakeDomReact(): {
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
} {
  const document = installFakeDocument(true);
  return createReactHarness(createFakeNode(document, 'div'));
}
