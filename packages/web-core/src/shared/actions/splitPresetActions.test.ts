import { describe, expect, it } from 'vitest';
import { splitPresetActions } from './splitPresetActions';

describe('splitPresetActions', () => {
  it('exposes new/close pane plus focus actions with searchable keywords', () => {
    expect(splitPresetActions[0]).toMatchObject({ id: 'newPane' });
    expect(splitPresetActions[1]).toMatchObject({ id: 'closePane' });
    expect(splitPresetActions[2]).toMatchObject({ id: 'reopenClosedPane' });
    const focusActions = splitPresetActions.slice(3);
    expect(focusActions).toHaveLength(9);
    expect(focusActions[0]).toMatchObject({
      id: 'focusPane1',
      label: 'Focus Pane 1',
    });
    expect(focusActions[3].keywords).toContain('cmd opt shift 4');
  });
});
