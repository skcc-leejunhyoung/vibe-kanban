import { describe, it, expect, vi } from 'vitest';

// Pin the platform so glyph mapping and buildCombo's mod/ctrl assignment are
// deterministic (macOS: metaKey -> 'mod', getModifierKey -> '⌘').
vi.mock('@/shared/lib/platform', () => ({
  isMac: () => true,
  getModifierKey: () => '⌘',
}));

import {
  isSequenceKeys,
  resolveSequence,
  resolveModifier,
  effectiveSequentialBindings,
  effectiveFirstKeys,
  effectiveValidSequences,
  displayKeyParts,
  effectiveActionShortcut,
  buildCombo,
  reservedBindings,
  COMMAND_BAR_BINDING_ID,
  NEXT_SPLIT_PANE_BINDING_ID,
  PREVIOUS_SPLIT_PANE_BINDING_ID,
  SPLIT_PRESET_BINDING_IDS,
} from './registry';

// The node test env has no KeyboardEvent constructor; buildCombo only reads the
// boolean modifier flags, so a plain object cast is sufficient.
function evt(mods: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  } as KeyboardEvent;
}

describe('isSequenceKeys', () => {
  it('is true only for two-key sequences', () => {
    expect(isSequenceKeys('w>a')).toBe(true);
    expect(isSequenceKeys('mod+a')).toBe(false);
    expect(isSequenceKeys('x')).toBe(false);
    expect(isSequenceKeys('')).toBe(false);
  });
});

describe('resolveSequence', () => {
  it('returns the registry default when there is no override', () => {
    expect(resolveSequence('seq-go-settings', {})).toBe('g>s');
  });

  it('returns the override, whether a sequence or a rebound combo', () => {
    expect(
      resolveSequence('seq-go-settings', { 'seq-go-settings': 'w>x' })
    ).toBe('w>x');
    expect(
      resolveSequence('seq-go-settings', { 'seq-go-settings': 'mod+s' })
    ).toBe('mod+s');
  });

  it('treats an empty-string override as disabled, distinct from absent', () => {
    // present-but-empty => disabled (''), absent => default ('g>s')
    expect(resolveSequence('seq-go-settings', { 'seq-go-settings': '' })).toBe(
      ''
    );
    expect(resolveSequence('seq-go-settings', {})).toBe('g>s');
  });

  it('returns empty string for an unknown id', () => {
    expect(resolveSequence('does-not-exist', {})).toBe('');
  });
});

describe('resolveModifier', () => {
  it('returns the registry default when there is no override', () => {
    expect(resolveModifier(COMMAND_BAR_BINDING_ID, {})).toBe('mod+k');
  });

  it('honors an override, including an empty (disabled) value', () => {
    expect(
      resolveModifier(COMMAND_BAR_BINDING_ID, {
        [COMMAND_BAR_BINDING_ID]: 'mod+p',
      })
    ).toBe('mod+p');
    expect(
      resolveModifier(COMMAND_BAR_BINDING_ID, { [COMMAND_BAR_BINDING_ID]: '' })
    ).toBe('');
  });

  it('uses the configured default split screen shortcuts', () => {
    expect(resolveModifier(NEXT_SPLIT_PANE_BINDING_ID, {})).toBe('alt+tab');
    expect(resolveModifier(PREVIOUS_SPLIT_PANE_BINDING_ID, {})).toBe(
      'shift+alt+tab'
    );
    expect(resolveModifier(SPLIT_PRESET_BINDING_IDS[1], {})).toBe(
      'mod+alt+shift+1'
    );
    expect(resolveModifier(SPLIT_PRESET_BINDING_IDS[4], {})).toBe(
      'mod+alt+shift+4'
    );
  });
});

describe('effectiveSequentialBindings', () => {
  it('pairs each binding with its effective key string', () => {
    const result = effectiveSequentialBindings({ 'seq-go-settings': 'mod+s' });
    const entry = result.find((b) => b.binding.id === 'seq-go-settings');
    expect(entry?.keys).toBe('mod+s');
  });
});

describe('effectiveFirstKeys', () => {
  it('includes default sequence first keys', () => {
    const keys = effectiveFirstKeys({});
    expect(keys.has('i')).toBe(true);
    expect(keys.has('g')).toBe(true);
  });

  it('reflects a sequence rebound to a new first key', () => {
    expect(effectiveFirstKeys({ 'seq-issue-create': 'q>w' }).has('q')).toBe(
      true
    );
  });

  it('excludes combo and disabled overrides from prefix tracking', () => {
    // 'q' is not a first key of any other binding, so a combo/cleared rebind of
    // seq-issue-create must not contribute it.
    expect(effectiveFirstKeys({ 'seq-issue-create': 'mod+q' }).has('q')).toBe(
      false
    );
  });
});

describe('effectiveValidSequences', () => {
  it('contains the comma-joined default sequence', () => {
    expect(effectiveValidSequences({}).has('g,s')).toBe(true);
  });

  it('drops a sequence rebound to a combo or cleared', () => {
    expect(
      effectiveValidSequences({ 'seq-go-settings': 'mod+s' }).has('g,s')
    ).toBe(false);
    expect(effectiveValidSequences({ 'seq-go-settings': '' }).has('g,s')).toBe(
      false
    );
  });

  it('reflects a rebound sequence', () => {
    const set = effectiveValidSequences({ 'seq-go-settings': 'w>x' });
    expect(set.has('w,x')).toBe(true);
    expect(set.has('g,s')).toBe(false);
  });
});

describe('displayKeyParts', () => {
  it('returns no chips for an empty (disabled) value', () => {
    expect(displayKeyParts('')).toEqual([]);
  });

  it('splits a sequence on ">" and upper-cases each key', () => {
    expect(displayKeyParts('w>a')).toEqual(['W', 'A']);
  });

  it('maps a modifier combo to platform glyphs (mac)', () => {
    expect(displayKeyParts('mod+a')).toEqual(['⌘', 'A']);
    expect(displayKeyParts('mod+shift+k')).toEqual(['⌘', '⇧', 'K']);
    expect(displayKeyParts('mod+escape')).toEqual(['⌘', 'Esc']);
    expect(displayKeyParts('alt+x')).toEqual(['⌥', 'X']);
  });
});

describe('effectiveActionShortcut', () => {
  it('resolves a sequence-bound action to its display string, honoring overrides', () => {
    // default: the registry sequence (v>r) bound to toggle-right-sidebar
    expect(effectiveActionShortcut('toggle-right-sidebar', 'V R', {})).toBe(
      'V R'
    );
    // rebound to another sequence
    expect(
      effectiveActionShortcut('toggle-right-sidebar', 'V R', {
        'seq-view-right-sidebar': 'g>x',
      })
    ).toBe('G X');
    // rebound to a modifier combo -> platform glyphs (mac)
    expect(
      effectiveActionShortcut('toggle-right-sidebar', 'V R', {
        'seq-view-right-sidebar': 'mod+r',
      })
    ).toBe('⌘ R');
  });

  it('hides the hint (undefined) for a cleared sequence, ignoring the static fallback', () => {
    // present-but-empty override => disabled; must not fall back to 'V R'
    expect(
      effectiveActionShortcut('toggle-right-sidebar', 'V R', {
        'seq-view-right-sidebar': '',
      })
    ).toBeUndefined();
  });

  it('resolves a modifier-bound action via the explicit action-id map', () => {
    // open-command-bar (Action.id) maps to the command-bar modifier binding,
    // so the literal '{mod} K' fallback is replaced by the real glyphs.
    expect(effectiveActionShortcut('open-command-bar', '{mod} K', {})).toBe(
      '⌘ K'
    );
    // cleared modifier => hint hidden
    expect(
      effectiveActionShortcut('open-command-bar', '{mod} K', {
        [COMMAND_BAR_BINDING_ID]: '',
      })
    ).toBeUndefined();
  });

  it('falls back to the static shortcut when the action has no rebindable binding', () => {
    expect(effectiveActionShortcut('no-binding-action', 'X Y', {})).toBe('X Y');
    expect(
      effectiveActionShortcut('no-binding-action', undefined, {})
    ).toBeUndefined();
  });
});

describe('buildCombo', () => {
  it('returns null when no modifier is held', () => {
    expect(buildCombo(evt({}), 'a')).toBeNull();
  });

  it('builds a normalized combo string (mac)', () => {
    expect(buildCombo(evt({ metaKey: true }), 'a')).toBe('mod+a');
    expect(buildCombo(evt({ shiftKey: true }), 'j')).toBe('shift+j');
    expect(buildCombo(evt({ metaKey: true, shiftKey: true }), 'k')).toBe(
      'mod+shift+k'
    );
    expect(buildCombo(evt({ metaKey: true }), 'escape')).toBe('mod+escape');
    // on mac, ctrlKey is a distinct 'ctrl' modifier (not 'mod')
    expect(buildCombo(evt({ ctrlKey: true }), 'a')).toBe('ctrl+a');
  });
});

describe('reservedBindings', () => {
  it('every key round-trips through buildCombo (normalized form invariant)', () => {
    // Conflict detection compares a captured override (buildCombo output) by
    // exact string, so each reserved key must itself be reproducible by
    // buildCombo — guards against a malformed entry like 'cmd+a' or 'shift+down'.
    for (const r of reservedBindings) {
      const parts = r.keys.split('+');
      const key = parts.pop()!;
      const combo = buildCombo(
        evt({
          metaKey: parts.includes('mod'),
          ctrlKey: parts.includes('ctrl'),
          shiftKey: parts.includes('shift'),
          altKey: parts.includes('alt'),
        }),
        key
      );
      expect(combo).toBe(r.keys);
    }
  });
});
