import { hexToHslTriple, hslTripleToHex, isHslTriple } from './themeColors';

/**
 * Theme presets ("skins") are a local-web-only visual preference applied on top
 * of the Light/Dark/System mode. A preset is a bag of design-token overrides
 * (plus a color-scheme + optional monospace toggle) that is injected as a
 * `<style>` rule scoped to `html[data-theme-variant="<id>"]`.
 *
 * This module is the single source of truth for:
 *   - the editable token catalogue (`THEME_TOKEN_GROUPS`),
 *   - the built-in presets (`BUILTIN_PRESETS`),
 *   - persistence of user-added / user-edited presets (localStorage), and
 *   - turning a preset into the CSS text that `themeVariant.ts` injects.
 *
 * Presets carry no visual *effects* (no scanlines, glow, vignette); they are a
 * pure palette swap so the look stays flat and legible.
 */

// The implicit "no extra skin" selection. Kept here (rather than the UI prefs
// store) so this module has no store dependency and avoids an import cycle.
export type ThemeVariant = string;
export const DEFAULT_THEME_VARIANT: ThemeVariant = 'default';

export type ThemeTokenFormat = 'hsl' | 'hex';

export type ThemeTokenDef = {
  /** CSS custom property name, including the leading `--`. */
  cssVar: string;
  /** Short, human-readable label (English; technical token name). */
  label: string;
  /**
   * Native storage format. `hsl` tokens are consumed via `hsl(var(--token))`
   * and stored as an HSL triple ("211 60% 7%"); `hex` tokens (syntax colors)
   * are stored as "#rrggbb".
   */
  format: ThemeTokenFormat;
};

export type ThemeTokenGroupDef = {
  /** i18n key suffix under `settings.general.themeEditor.groups`. */
  id: string;
  tokens: ThemeTokenDef[];
};

const hsl = (cssVar: string, label: string): ThemeTokenDef => ({
  cssVar,
  label,
  format: 'hsl',
});
const hex = (cssVar: string, label: string): ThemeTokenDef => ({
  cssVar,
  label,
  format: 'hex',
});

/**
 * The catalogue of tokens a preset may override, grouped for the editor UI.
 * This is exactly the set the original drop-in theme CSS files touched.
 */
export const THEME_TOKEN_GROUPS: ThemeTokenGroupDef[] = [
  {
    id: 'surfaces',
    tokens: [
      hsl('--_background', 'Background'),
      hsl('--_bg-primary-default', 'Primary surface'),
      hsl('--_bg-secondary-default', 'Secondary surface'),
      hsl('--_bg-panel-default', 'Panel surface'),
      hsl('--_secondary', 'Secondary'),
      hsl('--_muted', 'Muted'),
      hsl('--_accent', 'Accent'),
      hsl('--_border', 'Border'),
      hsl('--_input', 'Input'),
    ],
  },
  {
    id: 'text',
    tokens: [
      hsl('--_foreground', 'Foreground'),
      hsl('--text-high', 'Text — high'),
      hsl('--text-normal', 'Text — normal'),
      hsl('--text-low', 'Text — low'),
      hsl('--_muted-foreground', 'Muted text'),
      hsl('--_secondary-foreground', 'Secondary text'),
      hsl('--_accent-foreground', 'Accent text'),
    ],
  },
  {
    id: 'brand',
    tokens: [
      hsl('--brand', 'Brand'),
      hsl('--brand-hover', 'Brand — hover'),
      hsl('--brand-secondary', 'Brand — secondary'),
      hsl('--text-on-brand', 'Text on brand'),
      hsl('--_primary', 'Primary'),
      hsl('--_primary-foreground', 'Primary text'),
      hsl('--_ring', 'Focus ring'),
    ],
  },
  {
    id: 'status',
    tokens: [
      hsl('--success', 'Success'),
      hsl('--_success', 'Success — token'),
      hsl('--_success-foreground', 'Success text'),
      hsl('--_warning', 'Warning'),
      hsl('--_warning-foreground', 'Warning text'),
      hsl('--_info', 'Info'),
      hsl('--_info-foreground', 'Info text'),
      hsl('--error', 'Error'),
      hsl('--_destructive', 'Destructive'),
      hsl('--_destructive-foreground', 'Destructive text'),
      hsl('--_neutral', 'Neutral'),
      hsl('--_neutral-foreground', 'Neutral text'),
      hsl('--merged', 'Merged'),
    ],
  },
  {
    id: 'console',
    tokens: [
      hsl('--_console-background', 'Console background'),
      hsl('--_console-foreground', 'Console foreground'),
      hsl('--_console-success', 'Console success'),
      hsl('--_console-error', 'Console error'),
    ],
  },
  {
    id: 'syntax',
    tokens: [
      hex('--_syntax-keyword', 'Keyword'),
      hex('--_syntax-function', 'Function'),
      hex('--_syntax-constant', 'Constant'),
      hex('--_syntax-string', 'String'),
      hex('--_syntax-variable', 'Variable'),
      hex('--_syntax-comment', 'Comment'),
      hex('--_syntax-tag', 'Tag'),
      hex('--_syntax-punctuation', 'Punctuation'),
      hex('--_syntax-deleted', 'Deleted'),
    ],
  },
];

export const THEME_TOKENS: ThemeTokenDef[] = THEME_TOKEN_GROUPS.flatMap(
  (g) => g.tokens
);

const TOKEN_BY_VAR = new Map(THEME_TOKENS.map((t) => [t.cssVar, t]));

export type ThemeColorScheme = 'dark' | 'light';

export type ThemePreset = {
  id: string;
  name: string;
  /** True for the shipped presets (cannot be removed, only reset to default). */
  builtIn: boolean;
  colorScheme: ThemeColorScheme;
  /** Apply a monospace font stack across the app while this preset is active. */
  mono: boolean;
  /** cssVar -> value (native format per the token's `format`). */
  tokens: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Built-in presets (palette only — the original CRT scanline/glow/vignette
// effects were intentionally dropped).
// ---------------------------------------------------------------------------

const NAVY_HUD_TOKENS: Record<string, string> = {
  '--_background': '211 60% 7%',
  '--_foreground': '197 54% 82%',
  '--_primary': '190 86% 58%',
  '--_primary-foreground': '209 57% 8%',
  '--_secondary': '209 57% 12%',
  '--_secondary-foreground': '197 54% 82%',
  '--_muted': '209 57% 10%',
  '--_muted-foreground': '203 24% 48%',
  '--_accent': '207 54% 14%',
  '--_accent-foreground': '197 54% 82%',
  '--_destructive': '352 83% 65%',
  '--_destructive-foreground': '0 0% 100%',
  '--_border': '207 56% 19%',
  '--_input': '209 57% 12%',
  '--_ring': '190 86% 58%',
  '--_success': '155 71% 58%',
  '--_success-foreground': '155 71% 14%',
  '--_warning': '37 88% 62%',
  '--_warning-foreground': '37 88% 14%',
  '--_info': '190 86% 58%',
  '--_info-foreground': '209 57% 8%',
  '--_neutral': '207 54% 14%',
  '--_neutral-foreground': '197 54% 82%',
  '--_console-background': '211 60% 5%',
  '--_console-foreground': '197 54% 82%',
  '--_console-success': '155 71% 58%',
  '--_console-error': '352 83% 65%',
  '--text-high': '197 60% 88%',
  '--text-normal': '197 54% 82%',
  '--text-low': '203 24% 48%',
  '--_bg-primary-default': '211 60% 7%',
  '--_bg-secondary-default': '209 57% 10%',
  '--_bg-panel-default': '209 57% 12%',
  '--brand': '190 86% 58%',
  '--brand-hover': '190 86% 68%',
  '--brand-secondary': '192 69% 35%',
  '--error': '352 83% 65%',
  '--success': '155 71% 58%',
  '--merged': '271 81% 66%',
  '--text-on-brand': '209 57% 8%',
  '--_syntax-keyword': '#ff7b9c',
  '--_syntax-function': '#7fd6ff',
  '--_syntax-constant': '#79c0ff',
  '--_syntax-string': '#46e0a0',
  '--_syntax-variable': '#f3b34a',
  '--_syntax-comment': '#5d8197',
  '--_syntax-tag': '#38d2f0',
  '--_syntax-punctuation': '#b9dcea',
  '--_syntax-deleted': '#f0596d',
};

const PHOSPHOR_TOKENS: Record<string, string> = {
  '--_background': '146 47% 3%',
  '--_foreground': '141 64% 73%',
  '--_primary': '146 86% 59%',
  '--_primary-foreground': '146 47% 4%',
  '--_secondary': '154 47% 6%',
  '--_secondary-foreground': '141 64% 73%',
  '--_muted': '148 48% 5%',
  '--_muted-foreground': '145 27% 43%',
  '--_accent': '147 45% 8%',
  '--_accent-foreground': '141 64% 73%',
  '--_destructive': '352 83% 65%',
  '--_destructive-foreground': '0 0% 100%',
  '--_border': '149 49% 17%',
  '--_input': '154 47% 6%',
  '--_ring': '146 86% 59%',
  '--_success': '145 100% 77%',
  '--_success-foreground': '150 66% 14%',
  '--_warning': '42 88% 62%',
  '--_warning-foreground': '42 88% 14%',
  '--_info': '146 86% 59%',
  '--_info-foreground': '146 47% 4%',
  '--_neutral': '147 45% 8%',
  '--_neutral-foreground': '141 64% 73%',
  '--_console-background': '146 47% 2%',
  '--_console-foreground': '141 64% 73%',
  '--_console-success': '145 100% 77%',
  '--_console-error': '352 83% 65%',
  '--text-high': '145 80% 80%',
  '--text-normal': '141 64% 73%',
  '--text-low': '145 27% 43%',
  '--_bg-primary-default': '146 47% 3%',
  '--_bg-secondary-default': '148 48% 5%',
  '--_bg-panel-default': '154 47% 6%',
  '--brand': '146 86% 59%',
  '--brand-hover': '145 100% 77%',
  '--brand-secondary': '150 66% 33%',
  '--error': '352 83% 65%',
  '--success': '145 100% 77%',
  '--merged': '271 81% 66%',
  '--text-on-brand': '146 47% 4%',
  '--_syntax-keyword': '#ff7b9c',
  '--_syntax-function': '#88ffba',
  '--_syntax-constant': '#6fdc9a',
  '--_syntax-string': '#3bf08a',
  '--_syntax-variable': '#f3c14a',
  '--_syntax-comment': '#4f8a68',
  '--_syntax-tag': '#3bf08a',
  '--_syntax-punctuation': '#8fe6ad',
  '--_syntax-deleted': '#f0596d',
};

const AMBER_TOKENS: Record<string, string> = {
  '--_background': '214 47% 6%',
  '--_foreground': '41 51% 78%',
  '--_primary': '36 89% 59%',
  '--_primary-foreground': '214 47% 6%',
  '--_secondary': '218 46% 10%',
  '--_secondary-foreground': '41 51% 78%',
  '--_muted': '217 49% 8%',
  '--_muted-foreground': '42 24% 44%',
  '--_accent': '216 44% 13%',
  '--_accent-foreground': '41 51% 78%',
  '--_destructive': '352 83% 65%',
  '--_destructive-foreground': '0 0% 100%',
  '--_border': '40 37% 21%',
  '--_input': '218 46% 10%',
  '--_ring': '36 89% 59%',
  '--_success': '144 61% 65%',
  '--_success-foreground': '144 61% 14%',
  '--_warning': '36 89% 59%',
  '--_warning-foreground': '36 89% 14%',
  '--_info': '36 89% 59%',
  '--_info-foreground': '214 47% 6%',
  '--_neutral': '216 44% 13%',
  '--_neutral-foreground': '41 51% 78%',
  '--_console-background': '214 47% 4%',
  '--_console-foreground': '41 51% 78%',
  '--_console-success': '144 61% 65%',
  '--_console-error': '352 83% 65%',
  '--text-high': '41 60% 84%',
  '--text-normal': '41 51% 78%',
  '--text-low': '42 24% 44%',
  '--_bg-primary-default': '214 47% 6%',
  '--_bg-secondary-default': '217 49% 8%',
  '--_bg-panel-default': '218 46% 10%',
  '--brand': '36 89% 59%',
  '--brand-hover': '36 89% 68%',
  '--brand-secondary': '40 64% 37%',
  '--error': '352 83% 65%',
  '--success': '144 61% 65%',
  '--merged': '271 81% 66%',
  '--text-on-brand': '214 47% 6%',
  '--_syntax-keyword': '#f0596d',
  '--_syntax-function': '#f3a83a',
  '--_syntax-constant': '#f3c14a',
  '--_syntax-string': '#6fdc9a',
  '--_syntax-variable': '#e4d2ab',
  '--_syntax-comment': '#8a7a55',
  '--_syntax-tag': '#f3a83a',
  '--_syntax-punctuation': '#e4d2ab',
  '--_syntax-deleted': '#f0596d',
};

export const BUILTIN_PRESETS: ThemePreset[] = [
  {
    id: 'navy-hud',
    name: 'Navy HUD',
    builtIn: true,
    colorScheme: 'dark',
    mono: true,
    tokens: NAVY_HUD_TOKENS,
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    builtIn: true,
    colorScheme: 'dark',
    mono: true,
    tokens: PHOSPHOR_TOKENS,
  },
  {
    id: 'amber',
    name: 'Amber Terminal',
    builtIn: true,
    colorScheme: 'dark',
    mono: true,
    tokens: AMBER_TOKENS,
  },
];

export const BUILTIN_PRESET_IDS = new Set(BUILTIN_PRESETS.map((p) => p.id));

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidPresetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id) && id !== DEFAULT_THEME_VARIANT;
}

export function slugifyPresetName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generatePresetId(name: string, taken: Set<string>): string {
  const base = slugifyPresetName(name) || 'theme';
  let id = base;
  let i = 2;
  while (
    taken.has(id) ||
    id === DEFAULT_THEME_VARIANT ||
    !isValidPresetId(id)
  ) {
    id = `${base}-${i++}`;
  }
  return id;
}

/**
 * Coerce a single token value to its native CSS form, or null if invalid.
 * Accepts the "other" format too (hex<->hsl) so the editor can speak hex
 * everywhere and we convert on the way in.
 */
function normalizeTokenValue(def: ThemeTokenDef, value: string): string | null {
  const v = value.trim();
  if (def.format === 'hex') {
    if (HEX6_RE.test(v)) return v.toLowerCase();
    if (isHslTriple(v)) return hslTripleToHex(v);
    return null;
  }
  if (isHslTriple(v)) return v.replace(/\s+/g, ' ').trim();
  if (HEX6_RE.test(v)) return hexToHslTriple(v);
  return null;
}

/** Keep only known tokens with valid values, coerced to native format. */
export function sanitizePresetTokens(
  tokens: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of THEME_TOKENS) {
    const raw = tokens?.[def.cssVar];
    if (typeof raw !== 'string') continue;
    const norm = normalizeTokenValue(def, raw);
    if (norm) out[def.cssVar] = norm;
  }
  return out;
}

function sanitizePreset(raw: unknown): ThemePreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!isValidPresetId(id)) return null;
  const name =
    typeof r.name === 'string' && r.name.trim()
      ? r.name.trim().slice(0, 60)
      : id;
  const colorScheme: ThemeColorScheme =
    r.colorScheme === 'light' ? 'light' : 'dark';
  const mono = r.mono !== false; // default to monospace unless explicitly off
  const tokens = sanitizePresetTokens(
    r.tokens && typeof r.tokens === 'object'
      ? (r.tokens as Record<string, unknown>)
      : {}
  );
  return {
    id,
    name,
    builtIn: BUILTIN_PRESET_IDS.has(id),
    colorScheme,
    mono,
    tokens,
  };
}

// ---------------------------------------------------------------------------
// Persistence (localStorage) + merge with built-ins
// ---------------------------------------------------------------------------

const PRESETS_KEY = 'vk-theme-presets';

/** Raw stored presets: user-added presets + overrides of built-in ones. */
export function loadStoredPresets(): ThemePreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizePreset)
      .filter((p): p is ThemePreset => p !== null);
  } catch {
    return [];
  }
}

export function persistStoredPresets(presets: ThemePreset[]): void {
  try {
    if (!presets.length) {
      localStorage.removeItem(PRESETS_KEY);
    } else {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    }
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * The effective preset list shown to the user: every built-in (with a stored
 * override merged on top of its base tokens, if any), followed by user-added
 * presets in insertion order.
 */
export function mergePresets(stored: ThemePreset[]): ThemePreset[] {
  const overrides = new Map(stored.map((p) => [p.id, p]));
  const result: ThemePreset[] = [];

  for (const base of BUILTIN_PRESETS) {
    const override = overrides.get(base.id);
    if (override) {
      result.push({
        ...override,
        builtIn: true,
        // Built-in base provides any tokens the override doesn't touch.
        tokens: { ...base.tokens, ...override.tokens },
      });
    } else {
      result.push(base);
    }
  }

  for (const p of stored) {
    if (BUILTIN_PRESET_IDS.has(p.id)) continue;
    result.push({ ...p, builtIn: false });
  }

  return result;
}

export function getEffectivePresets(): ThemePreset[] {
  return mergePresets(loadStoredPresets());
}

export function findPreset(
  presets: ThemePreset[],
  id: string | null | undefined
): ThemePreset | undefined {
  if (!id) return undefined;
  return presets.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// CSS generation (consumed by themeVariant.ts + the index.html bootstrap)
// ---------------------------------------------------------------------------

const MONO_FONT_STACK =
  "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** Build the scoped CSS text for a preset. Safe to inject in a <style>. */
export function presetToCss(preset: ThemePreset): string {
  // id is validated to [a-z0-9-]; safe to interpolate into the selector.
  const sel = `html[data-theme-variant="${preset.id}"]`;
  const lines: string[] = [
    `  color-scheme: ${preset.colorScheme === 'light' ? 'light' : 'dark'};`,
  ];

  for (const def of THEME_TOKENS) {
    const raw = preset.tokens[def.cssVar];
    if (typeof raw !== 'string') continue;
    const norm = normalizeTokenValue(def, raw);
    if (norm) lines.push(`  ${def.cssVar}: ${norm};`);
  }

  let css = `${sel} {\n${lines.join('\n')}\n}\n`;

  if (preset.mono) {
    css +=
      `${sel},\n${sel} body,\n${sel} #root,\n${sel} .font-ibm-plex-sans {\n` +
      `  font-family: ${MONO_FONT_STACK} !important;\n` +
      `  letter-spacing: 0.01em;\n}\n` +
      `${sel} button,\n${sel} input,\n${sel} textarea,\n${sel} select {\n` +
      `  font-family: inherit;\n}\n`;
  }

  return css;
}

/** The default value for a token, taken from a sensible built-in (Navy HUD). */
export function defaultTokenValue(cssVar: string): string {
  return NAVY_HUD_TOKENS[cssVar] ?? '0 0% 50%';
}

export function tokenDefFor(cssVar: string): ThemeTokenDef | undefined {
  return TOKEN_BY_VAR.get(cssVar);
}

// --- editor helpers: the UI speaks hex; storage uses each token's native form

/** Render a token's stored value as hex for a native <input type="color">. */
export function tokenToHex(def: ThemeTokenDef, value: string): string {
  return def.format === 'hex' ? value : hslTripleToHex(value);
}

/** Convert a hex value from the editor back to the token's native form. */
export function tokenFromHex(def: ThemeTokenDef, hexValue: string): string {
  return def.format === 'hex'
    ? hexValue.toLowerCase()
    : hexToHslTriple(hexValue);
}

/**
 * Build a fresh user preset by cloning an existing one under a new id/name.
 * `taken` is the set of ids already in use (including 'default').
 */
export function clonePreset(
  source: ThemePreset,
  name: string,
  taken: Set<string>
): ThemePreset {
  return {
    id: generatePresetId(name, taken),
    name: name.trim().slice(0, 60) || 'Custom theme',
    builtIn: false,
    colorScheme: source.colorScheme,
    mono: source.mono,
    tokens: { ...source.tokens },
  };
}
