import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PRESETS,
  DEFAULT_THEME_VARIANT,
  clonePreset,
  generatePresetId,
  getEffectivePresets,
  isValidPresetId,
  loadStoredPresets,
  mergePresets,
  persistStoredPresets,
  presetToCss,
  sanitizePresetTokens,
  type ThemePreset,
  THEME_TOKENS,
  tokenDefFor,
  tokenFromHex,
  tokenToHex,
} from './themePresets';

const navy = () => BUILTIN_PRESETS.find((p) => p.id === 'navy-hud')!;

describe('mergePresets', () => {
  it('returns all built-ins untouched when nothing is stored', () => {
    const merged = mergePresets([]);
    expect(merged.map((p) => p.id)).toEqual(BUILTIN_PRESETS.map((p) => p.id));
    expect(merged.every((p) => p.builtIn)).toBe(true);
  });

  it('layers a built-in override on top of its base tokens', () => {
    const override: ThemePreset = {
      id: 'navy-hud',
      name: 'My Navy',
      builtIn: true,
      colorScheme: 'dark',
      mono: false,
      tokens: { '--brand': '10 90% 50%' },
    };
    const merged = mergePresets([override]);
    const result = merged.find((p) => p.id === 'navy-hud')!;
    expect(result.name).toBe('My Navy');
    expect(result.mono).toBe(false);
    expect(result.builtIn).toBe(true);
    // edited token wins
    expect(result.tokens['--brand']).toBe('10 90% 50%');
    // untouched tokens still come from the base
    expect(result.tokens['--_background']).toBe(navy().tokens['--_background']);
  });

  it('appends custom presets after the built-ins', () => {
    const custom: ThemePreset = {
      id: 'my-theme',
      name: 'My Theme',
      builtIn: false,
      colorScheme: 'light',
      mono: false,
      tokens: {},
    };
    const merged = mergePresets([custom]);
    expect(merged.at(-1)!.id).toBe('my-theme');
    expect(merged.at(-1)!.builtIn).toBe(false);
    expect(merged).toHaveLength(BUILTIN_PRESETS.length + 1);
  });
});

describe('sanitizePresetTokens', () => {
  it('drops unknown keys and invalid values', () => {
    const out = sanitizePresetTokens({
      '--_background': '211 60% 7%',
      '--not-a-token': '0 0% 0%',
      '--brand': 'garbage',
      '--_syntax-keyword': '#ff0000',
    });
    expect(out['--_background']).toBe('211 60% 7%');
    expect(out['--_syntax-keyword']).toBe('#ff0000');
    expect(out['--not-a-token']).toBeUndefined();
    expect(out['--brand']).toBeUndefined();
  });

  it('coerces hex into an HSL triple for hsl tokens', () => {
    const out = sanitizePresetTokens({ '--brand': '#ff0000' });
    expect(out['--brand']).toBe('0 100% 50%');
  });

  it('coerces an HSL triple into hex for syntax (hex) tokens', () => {
    const out = sanitizePresetTokens({ '--_syntax-keyword': '0 100% 50%' });
    expect(out['--_syntax-keyword']).toBe('#ff0000');
  });

  it('rejects CSS-injection-like values (no closing brace leaks)', () => {
    const out = sanitizePresetTokens({
      '--_background': '0 0% 0%; } html { display:none',
    });
    expect(out['--_background']).toBeUndefined();
  });
});

describe('presetToCss', () => {
  it('scopes the rule to the variant selector and emits tokens', () => {
    const css = presetToCss(navy());
    expect(css).toContain('html[data-theme-variant="navy-hud"] {');
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('--_background: 211 60% 7%;');
    expect(css).toContain('--_syntax-keyword: #ff7b9c;');
  });

  it('emits the monospace block only when mono is enabled', () => {
    expect(presetToCss({ ...navy(), mono: true })).toContain('font-family:');
    expect(presetToCss({ ...navy(), mono: false })).not.toContain(
      'font-family:'
    );
  });

  // Regression: the original drop-in themes carried CRT scanline/glow/vignette
  // effects. Presets must be a flat palette swap only — no visual effects.
  it('never emits scanline, glow, or vignette effects', () => {
    for (const preset of BUILTIN_PRESETS) {
      const css = presetToCss(preset);
      expect(css).not.toMatch(/repeating-linear-gradient/i);
      expect(css).not.toMatch(/radial-gradient/i);
      expect(css).not.toMatch(/text-shadow/i);
      expect(css).not.toMatch(/box-shadow/i);
      expect(css).not.toMatch(/mix-blend-mode/i);
      expect(css).not.toMatch(/::before|::after/);
      expect(css).not.toMatch(/scanline/i);
    }
  });
});

describe('generatePresetId / isValidPresetId', () => {
  it('slugifies and avoids collisions with taken ids and "default"', () => {
    const taken = new Set([DEFAULT_THEME_VARIANT, 'my-theme']);
    expect(generatePresetId('My Theme', taken)).toBe('my-theme-2');
    expect(generatePresetId('Brand New!', taken)).toBe('brand-new');
  });

  it('never accepts the reserved default id', () => {
    expect(isValidPresetId('default')).toBe(false);
    expect(isValidPresetId('navy-hud')).toBe(true);
  });
});

describe('tokenToHex / tokenFromHex round-trip', () => {
  it('round-trips hsl tokens through hex within rounding tolerance', () => {
    const def = tokenDefFor('--brand')!;
    expect(def.format).toBe('hsl');
    const hex = tokenToHex(def, '0 100% 50%');
    expect(hex).toBe('#ff0000');
    expect(tokenFromHex(def, hex)).toBe('0 100% 50%');
  });

  it('passes hex tokens through unchanged (lowercased)', () => {
    const def = tokenDefFor('--_syntax-keyword')!;
    expect(def.format).toBe('hex');
    expect(tokenToHex(def, '#AABBCC')).toBe('#AABBCC');
    expect(tokenFromHex(def, '#AABBCC')).toBe('#aabbcc');
  });

  it('covers every catalogue token with a known format', () => {
    expect(THEME_TOKENS.length).toBeGreaterThan(40);
    for (const def of THEME_TOKENS) {
      expect(['hsl', 'hex']).toContain(def.format);
    }
  });
});

describe('clonePreset', () => {
  it('produces a custom preset with a fresh id and copied tokens', () => {
    const taken = new Set([
      DEFAULT_THEME_VARIANT,
      ...BUILTIN_PRESETS.map((p) => p.id),
    ]);
    const clone = clonePreset(navy(), 'Navy HUD copy', taken);
    expect(clone.builtIn).toBe(false);
    expect(clone.id).not.toBe('navy-hud');
    expect(taken.has(clone.id)).toBe(false);
    expect(clone.tokens).toEqual(navy().tokens);
    // mutating the clone must not touch the source
    clone.tokens['--brand'] = '1 2% 3%';
    expect(navy().tokens['--brand']).not.toBe('1 2% 3%');
  });
});

describe('persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips stored presets and sanitizes on load', () => {
    const preset: ThemePreset = {
      id: 'my-theme',
      name: 'My Theme',
      builtIn: false,
      colorScheme: 'light',
      mono: false,
      tokens: { '--brand': '#ff0000', '--bogus': 'x' } as Record<
        string,
        string
      >,
    };
    persistStoredPresets([preset]);
    const loaded = loadStoredPresets();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('my-theme');
    // hex coerced to hsl on load; bogus key dropped
    expect(loaded[0].tokens['--brand']).toBe('0 100% 50%');
    expect(loaded[0].tokens['--bogus']).toBeUndefined();
  });

  it('clears storage when persisting an empty list', () => {
    persistStoredPresets([navy()]);
    persistStoredPresets([]);
    expect(loadStoredPresets()).toEqual([]);
    expect(getEffectivePresets().map((p) => p.id)).toEqual(
      BUILTIN_PRESETS.map((p) => p.id)
    );
  });
});
