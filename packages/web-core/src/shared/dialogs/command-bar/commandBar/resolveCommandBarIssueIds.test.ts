import { describe, expect, it } from 'vitest';
import { resolveCommandBarIssueIds } from './resolveCommandBarIssueIds';

describe('resolveCommandBarIssueIds', () => {
  it('uses the focused board issue when no issue is open or selected', () => {
    expect(
      resolveCommandBarIssueIds({
        selectedIssueIds: new Set(),
        cursorIssueId: 'focused-issue',
      })
    ).toEqual(['focused-issue']);
  });

  it('keeps explicit, multi-selected, and opened issue precedence', () => {
    const base = {
      selectedIssueIds: new Set(['selected-issue']),
      routeIssueId: 'opened-issue',
      cursorIssueId: 'focused-issue',
    };

    expect(
      resolveCommandBarIssueIds({
        ...base,
        explicitIssueIds: ['explicit-issue'],
      })
    ).toEqual(['explicit-issue']);
    expect(resolveCommandBarIssueIds(base)).toEqual(['selected-issue']);
    expect(
      resolveCommandBarIssueIds({
        ...base,
        selectedIssueIds: new Set(),
      })
    ).toEqual(['opened-issue']);
  });
});
