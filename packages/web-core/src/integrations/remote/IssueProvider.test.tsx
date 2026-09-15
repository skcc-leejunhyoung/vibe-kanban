import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTestAuthRuntime,
  emitChange,
  emitSnapshotsByTable,
  installDomlessReact,
  lastSessionFor,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import {
  useIssueContext,
  type IssueContextValue,
} from '@/shared/hooks/useIssueContext';
import { IssueProvider } from './IssueProvider';

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));

let dom: ReturnType<typeof installDomlessReact>;
let issueCounter = 0;

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

async function renderProvider() {
  const issueId = `i${++issueCounter}`;
  const values: IssueContextValue[] = [];
  let bump: () => void = () => {};
  function Probe() {
    values.push(useIssueContext());
    return null;
  }
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return (
      <IssueProvider issueId={issueId}>
        <Probe />
      </IssueProvider>
    );
  }
  await dom.render(<Host />);
  await act(() =>
    emitSnapshotsByTable({
      issue_comments: [{ id: 'c1', issue_id: issueId, message: 'hi' }],
      issue_comment_reactions: [
        { id: 'r1', issue_id: issueId, comment_id: 'c1', emoji: '👍' },
      ],
    })
  );

  return {
    issueId,
    latest: () => values[values.length - 1],
    rerenderParent: () => act(() => bump()),
  };
}

describe('IssueProvider context stability', () => {
  it('keeps the context value when the parent re-renders without changes', async () => {
    const provider = await renderProvider();
    const settled = provider.latest();
    expect(settled.isLoading).toBe(false);
    expect(settled.getReactionsForComment('c1')).toHaveLength(1);

    await provider.rerenderParent();

    expect(provider.latest()).toBe(settled);
  });

  it('updates the value when a comment changes', async () => {
    const provider = await renderProvider();
    const before = provider.latest();

    await act(() =>
      emitChange(
        lastSessionFor(`issue_comments-${provider.issueId}`),
        'insert',
        { id: 'c2', issue_id: provider.issueId, message: 'more' }
      )
    );

    expect(provider.latest()).not.toBe(before);
    expect(provider.latest().comments).toHaveLength(2);
  });
});
