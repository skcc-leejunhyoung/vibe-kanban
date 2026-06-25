import { useEffect } from 'react';
import { syncThemeColorMeta } from '@/shared/lib/themeColors';
import {
  DEFAULT_THEME_VARIANT,
  findPreset,
  presetToCss,
  type ThemePreset,
} from '@/shared/lib/themePresets';
import {
  useThemePresets,
  useThemeVariant,
} from '@/shared/stores/useUiPreferencesStore';

/**
 * Theme presets ("skins") are token-only palette swaps applied on top of the
 * Light/Dark/System mode. Selecting one means:
 *   1. setting `document.documentElement.dataset.themeVariant`, and
 *   2. injecting a `<style>` whose rule is scoped to
 *      `html[data-theme-variant="<id>"]` and sets the preset's token overrides.
 *
 * This replaces the older drop-in `/themes/<id>.css` files: presets are now
 * editable data (see `themePresets.ts`), so we generate the CSS at runtime
 * rather than loading a static stylesheet. This also lets the editor preview an
 * unsaved preset by calling `applyThemeVariant()` directly.
 *
 * Applied on both the local and remote web: the apply hook runs from each
 * app root, and the selection/presets sync through config so a skin chosen on
 * one surface shows on the other.
 */

const STYLE_ID = 'vk-theme-variant';

// The generated CSS for the *selected* preset is cached here so the pre-paint
// bootstrap in index.html can re-inject it before React mounts (avoiding a
// flash of the default theme). Mirrored only on the real selection, never on
// the editor's transient preview.
const CSS_CACHE_KEY = 'vk-theme-variant-css';

/**
 * Inject (or remove) the variant stylesheet and reflect the active variant on
 * the <html> element. Pass `null` (or the default preset) to clear it.
 * Idempotent and safe to call repeatedly — used both by the store-driven hook
 * and by the editor's live preview.
 *
 * `cache` controls whether the generated CSS is mirrored to localStorage for
 * the pre-paint bootstrap. The hook passes `true`; the editor preview passes
 * `false` so a previewed-but-unsaved palette never sticks across reloads.
 */
export function applyThemeVariant(
  preset: ThemePreset | null,
  cache = true
): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

  if (!preset || preset.id === DEFAULT_THEME_VARIANT) {
    delete root.dataset.themeVariant;
    existing?.remove();
    if (cache) safeRemoveCache();
    // The skin changed `--background`; repaint the PWA title-bar color.
    syncThemeColorMeta();
    return;
  }

  root.dataset.themeVariant = preset.id;

  const css = presetToCss(preset);
  if (cache) safeSetCache(css);
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
  } else {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  // The skin changed `--background`; repaint the PWA title-bar color.
  syncThemeColorMeta();
}

function safeSetCache(css: string): void {
  try {
    localStorage.setItem(CSS_CACHE_KEY, css);
  } catch {
    // localStorage may be unavailable
  }
}

function safeRemoveCache(): void {
  try {
    localStorage.removeItem(CSS_CACHE_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Keep the DOM in sync with the selected theme variant + preset data. Call once
 * near each app root (local + remote web). Re-applies whenever the selection or
 * the preset definitions change (e.g. after an edit).
 */
export function useApplyThemeVariant(): void {
  const [variant] = useThemeVariant();
  const presets = useThemePresets();
  useEffect(() => {
    applyThemeVariant(findPreset(presets, variant) ?? null);
  }, [variant, presets]);
}
