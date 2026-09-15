import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_MUTATION, PROJECT_ISSUES_SHAPE } from 'shared/remote-types';
import {
  configureTestAuthRuntime,
  emitChange,
  emitSnapshot,
  installDomlessReact,
  lastSessionFor,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import { useShape } from './hooks';

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

let dom: ReturnType<typeof installDomlessReact>;
let projectCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  resetElectricSessions();
  configureTestAuthRuntime();
  dom = installDomlessReact();
});

afterEach(async () => {
  await dom.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const issue = (id: string, title = id) => ({
  id,
  project_id: 'p',
  title,
  status_id: 's1',
  sort_order: 1,
});

/**
 * Renders `useShape` under a parent whose state can change without touching
 * the shape, mirroring a provider re-rendered by unrelated context updates.
 */
async function renderShape(options?: { mutation?: typeof ISSUE_MUTATION }) {
  const projectId = `p${++projectCounter}`;
  const results: Array<ReturnType<typeof useShape>> = [];
  let bump: () => void = () => {};
  function Probe() {
    const [, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    results.push(
      useShape(PROJECT_ISSUES_SHAPE, { project_id: projectId }, options)
    );
    return null;
  }
  await dom.render(<Probe />);
  return {
    results,
    latest: () => results[results.length - 1],
    rerenderParent: () => act(() => bump()),
    session: () => lastSessionFor(`issues-${projectId}`),
  };
}

describe('useShape result identity', () => {
  it('returns the same object across parent re-renders when data is unchanged', async () => {
    const shape = await renderShape();
    await act(() => emitSnapshot(shape.session(), [issue('a')]));
    const settled = shape.latest();
    expect(settled.isLoading).toBe(false);
    expect(settled.data).toHaveLength(1);

    await shape.rerenderParent();
    await shape.rerenderParent();

    expect(shape.latest()).toBe(settled);
    expect(shape.latest().data).toBe(settled.data);
  });

  it('keeps mutation helpers stable while data stays the same', async () => {
    const shape = await renderShape({ mutation: ISSUE_MUTATION });
    await act(() => emitSnapshot(shape.session(), [issue('a')]));
    const settled = shape.latest() as ReturnType<typeof useShape> & {
      insert: unknown;
      update: unknown;
      remove: unknown;
    };

    await shape.rerenderParent();
    const next = shape.latest() as typeof settled;

    expect(next).toBe(settled);
    expect(next.insert).toBe(settled.insert);
    expect(next.update).toBe(settled.update);
    expect(next.remove).toBe(settled.remove);
  });

  it('returns a new object only when the synced data changes', async () => {
    const shape = await renderShape();
    await act(() => emitSnapshot(shape.session(), [issue('a')]));
    const before = shape.latest();

    await act(() =>
      emitChange(shape.session(), 'update', issue('a', 'renamed'))
    );

    const after = shape.latest();
    expect(after).not.toBe(before);
    expect(after.data).not.toBe(before.data);
    expect(after.data.map((row) => row.title)).toEqual(['renamed']);
    expect(after.retry).toBe(before.retry);
  });

  it('keeps untouched rows referentially stable when another row changes', async () => {
    const shape = await renderShape();
    await act(() => emitSnapshot(shape.session(), [issue('a'), issue('b')]));
    const rowB = shape.latest().data.find((row) => row.id === 'b');

    await act(() =>
      emitChange(shape.session(), 'update', issue('a', 'renamed'))
    );

    const data = shape.latest().data;
    expect(data.find((row) => row.id === 'a')?.title).toBe('renamed');
    expect(data.find((row) => row.id === 'b')).toBe(rowB);
  });
});
