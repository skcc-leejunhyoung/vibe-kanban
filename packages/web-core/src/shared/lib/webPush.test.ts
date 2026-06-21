import { describe, expect, it } from 'vitest';
import { collectDismissiblePushIds } from './webPush';

describe('collectDismissiblePushIds', () => {
  it('seen === true 업데이트의 id만 모은다', () => {
    expect(
      collectDismissiblePushIds([
        { id: 'a', changes: { seen: true } },
        { id: 'b', changes: { seen: false } },
        { id: 'c', changes: { seen: null } },
      ])
    ).toEqual(['a']);
  });

  it('archived === true 업데이트의 id도 모은다', () => {
    expect(
      collectDismissiblePushIds([
        { id: 'a', changes: { archived: true } },
        { id: 'b', changes: { archived: false } },
      ])
    ).toEqual(['a']);
  });

  it('seen과 archived가 섞여 있어도 모두 모으며 입력 순서를 유지한다', () => {
    expect(
      collectDismissiblePushIds([
        { id: 'a', changes: { seen: true } },
        { id: 'b', changes: { archived: true } },
        { id: 'c', changes: { seen: false } },
        { id: 'd', changes: { seen: true, archived: true } },
      ])
    ).toEqual(['a', 'b', 'd']);
  });

  it('읽음/보관과 무관한 변경은 제외한다', () => {
    expect(collectDismissiblePushIds([{ id: 'a', changes: {} }])).toEqual([]);
  });

  it('빈 배열은 빈 배열을 반환한다', () => {
    expect(collectDismissiblePushIds([])).toEqual([]);
  });
});
