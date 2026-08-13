import { describe, expect, it } from 'vitest';
import { splitPresetActions } from './splitPresetActions';

describe('splitPresetActions', () => {
  it('exposes new/close pane plus focus actions with searchable keywords', () => {
    expect(splitPresetActions[0]).toMatchObject({ id: 'newPane' });
    expect(splitPresetActions[1]).toMatchObject({ id: 'closePane' });
    const focusActions = splitPresetActions.slice(2);
    expect(focusActions).toHaveLength(9);
    expect(focusActions[0]).toMatchObject({
      id: 'focusPane1',
      label: 'Focus pane 1',
    });
    expect(focusActions[3].keywords).toContain('cmd opt shift 4');
  });
});
