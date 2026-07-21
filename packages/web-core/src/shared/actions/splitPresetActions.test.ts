import { describe, expect, it } from 'vitest';
import { splitPresetActions } from './splitPresetActions';

describe('splitPresetActions', () => {
  it('exposes all window presets with searchable shortcut keywords', () => {
    expect(splitPresetActions).toHaveLength(9);
    expect(splitPresetActions[0]).toMatchObject({
      id: 'splitPreset1',
      label: 'Window preset: 1 pane',
    });
    expect(splitPresetActions[8]).toMatchObject({
      id: 'splitPreset9',
      label: 'Window preset: 9 panes',
    });
    expect(splitPresetActions[3].keywords).toContain('cmd opt shift 4');
  });
});
