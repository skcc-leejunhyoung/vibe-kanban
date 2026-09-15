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

/**
 * React without a DOM: probes render no host nodes, so a bare EventTarget is
 * enough for the root container. Effects, memoization, context and Profiler
 * all run for real.
 */
export function installDomlessReact(): {
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
} {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      nodeType: 9,
      visibilityState: 'visible',
      activeElement: null,
    })
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      setTimeout,
      clearTimeout,
      HTMLIFrameElement: class {},
    })
  );
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: document,
  });
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    render: async (node) => {
      await act(() => root.render(node));
    },
    unmount: async () => {
      await act(() => root.unmount());
    },
  };
}
