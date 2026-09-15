import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from 'shared/remote-types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { KanbanIssueCard, type KanbanIssueCardProps } from './KanbanIssueCard';

const contentRenders = vi.fn();

vi.mock('@vibe/ui/components/KanbanBoard', () => ({
  KanbanCard: ({ children }: { children?: ReactNode }) => children ?? null,
}));
vi.mock('@vibe/ui/components/KanbanCardContent', () => ({
  KanbanCardContent: (props: { displayId: string }) => {
    contentRenders(props.displayId);
    return null;
  },
}));
vi.mock('@vibe/ui/components/IssueWorkspaceCard', () => ({
  IssueWorkspaceCard: () => null,
}));
vi.mock('@/shared/components/SearchableTagDropdownContainer', () => ({
  SearchableTagDropdownContainer: () => null,
}));

let dom: ReturnType<typeof installDomlessReact>;

beforeEach(() => {
  contentRenders.mockClear();
  dom = installDomlessReact();
});

afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

const issue = {
  id: 'i1',
  simple_id: 'VK-1',
  title: 'one',
  description: null,
  priority: null,
  parent_issue_id: null,
} as unknown as Issue;

const noop = () => {};
const EMPTY: never[] = [];

function baseProps(): KanbanIssueCardProps {
  return {
    issue,
    index: 0,
    projectId: 'p1',
    isOpen: false,
    isSelected: false,
    isFocused: false,
    isMobile: false,
    dragDisabled: false,
    tags: EMPTY,
    allTags: EMPTY,
    issueTags: EMPTY,
    assignees: EMPTY,
    milestone: undefined,
    pullRequests: EMPTY,
    githubIssues: EMPTY,
    relationships: EMPTY,
    workspaces: EMPTY,
    onCardClick: noop,
    onPriorityClick: noop,
    onAssigneeClick: noop,
    onMoreActionsClick: noop,
    onOpenInSplitPane: noop,
    onTagToggle: noop,
    onCreateTag: () => 't',
    onWorkspaceClick: noop,
    onCardRef: noop,
  };
}

/**
 * A board stand-in: re-renders on its own (as the container does for every
 * context change) while handing the card the same props unless told to swap.
 */
async function renderBoard() {
  let props = baseProps();
  let bump: () => void = () => {};
  function Board() {
    const [, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    return <KanbanIssueCard {...props} />;
  }
  await dom.render(<Board />);
  return {
    rerender: (patch: Partial<KanbanIssueCardProps> = {}) => {
      props = { ...props, ...patch };
      return act(() => bump());
    },
  };
}

describe('KanbanIssueCard', () => {
  it('skips re-rendering while its props are unchanged', async () => {
    const board = await renderBoard();
    expect(contentRenders).toHaveBeenCalledTimes(1);

    await board.rerender();
    await board.rerender();

    expect(contentRenders).toHaveBeenCalledTimes(1);
  });

  it('re-renders when its own issue changes', async () => {
    const board = await renderBoard();

    await board.rerender({ issue: { ...issue, title: 'renamed' } });

    expect(contentRenders).toHaveBeenCalledTimes(2);
  });

  it('re-renders for selection, cursor and open state', async () => {
    const board = await renderBoard();

    await board.rerender({ isSelected: true });
    await board.rerender({ isFocused: true });
    await board.rerender({ isOpen: true });

    expect(contentRenders).toHaveBeenCalledTimes(4);
  });
});
