import { useCallback, useEffect, useMemo } from 'react';
import { useScratch } from '@/shared/hooks/useScratch';
import { useDebouncedCallback } from '@/shared/hooks/useDebouncedCallback';
import {
  useUiPreferencesStore,
  PREVIEW_SHORTCUTS_GLOBAL_KEY,
} from '@/shared/stores/useUiPreferencesStore';
import {
  ScratchType,
  type PreviewSettingsData,
  type PreviewShortcutData,
  type ScratchPayload,
} from 'shared/types';

export type ScreenSize = 'desktop' | 'mobile' | 'responsive';

export interface ResponsiveDimensions {
  width: number;
  height: number;
}

export type PreviewShortcut = PreviewShortcutData;

interface UsePreviewSettingsResult {
  // URL override
  overrideUrl: string | null;
  hasOverride: boolean;
  setOverrideUrl: (url: string) => void;
  clearOverride: () => Promise<void>;

  // Screen size
  screenSize: ScreenSize;
  responsiveDimensions: ResponsiveDimensions;
  setScreenSize: (size: ScreenSize) => void;
  setResponsiveDimensions: (dimensions: ResponsiveDimensions) => void;

  // Shortcuts
  shortcuts: PreviewShortcut[];
  addShortcut: (shortcut: Omit<PreviewShortcut, 'id'>) => Promise<void>;
  removeShortcut: (id: string) => Promise<void>;

  isLoading: boolean;
}

const DEFAULT_RESPONSIVE_DIMENSIONS: ResponsiveDimensions = {
  width: 800,
  height: 600,
};

/**
 * Hook to manage preview settings. URL override and screen size are stored
 * per-workspace via the scratch system; shortcuts are stored per-project
 * (keyed by `projectId`, falling back to a shared global bucket when the
 * workspace has no associated project).
 */
export function usePreviewSettings(
  workspaceId: string | undefined,
  projectId?: string | null
): UsePreviewSettingsResult {
  const enabled = !!workspaceId;
  const projectKey = projectId ?? PREVIEW_SHORTCUTS_GLOBAL_KEY;
  const shortcutsByProject = useUiPreferencesStore(
    (state) => state.previewShortcutsByProject
  );
  const shortcuts = useMemo(
    () => shortcutsByProject[projectKey] ?? [],
    [shortcutsByProject, projectKey]
  );
  const setPreviewShortcuts = useUiPreferencesStore(
    (state) => state.setPreviewShortcuts
  );

  const {
    scratch,
    updateScratch,
    isLoading: isScratchLoading,
  } = useScratch(ScratchType.PREVIEW_SETTINGS, workspaceId ?? '', {
    enabled,
  });

  // Extract settings from scratch data
  const payload = scratch?.payload as ScratchPayload | undefined;
  const scratchData: PreviewSettingsData | undefined =
    payload?.type === 'PREVIEW_SETTINGS' ? payload.data : undefined;

  const overrideUrl = scratchData?.url ?? null;
  const hasOverride = overrideUrl !== null && overrideUrl.trim() !== '';

  const screenSize: ScreenSize =
    (scratchData?.screen_size as ScreenSize) ?? 'desktop';
  const responsiveDimensions: ResponsiveDimensions = useMemo(
    () => ({
      width:
        scratchData?.responsive_width ?? DEFAULT_RESPONSIVE_DIMENSIONS.width,
      height:
        scratchData?.responsive_height ?? DEFAULT_RESPONSIVE_DIMENSIONS.height,
    }),
    [scratchData?.responsive_width, scratchData?.responsive_height]
  );
  const legacyWorkspaceShortcuts = scratchData?.shortcuts ?? [];

  // Migrate any legacy per-workspace shortcuts into this workspace's project
  // bucket (merge by url) so previously-saved shortcuts aren't lost.
  useEffect(() => {
    if (legacyWorkspaceShortcuts.length === 0) return;

    const nextShortcutsByUrl = new Map(
      shortcuts.map((shortcut) => [shortcut.url, shortcut])
    );

    for (const shortcut of legacyWorkspaceShortcuts) {
      if (!nextShortcutsByUrl.has(shortcut.url)) {
        nextShortcutsByUrl.set(shortcut.url, shortcut);
      }
    }

    if (nextShortcutsByUrl.size !== shortcuts.length) {
      setPreviewShortcuts(projectKey, Array.from(nextShortcutsByUrl.values()));
    }
  }, [legacyWorkspaceShortcuts, setPreviewShortcuts, shortcuts, projectKey]);

  // Helper to save settings
  const saveSettings = useCallback(
    async (updates: Partial<PreviewSettingsData>) => {
      if (!workspaceId) return;

      try {
        await updateScratch({
          payload: {
            type: 'PREVIEW_SETTINGS',
            data: {
              url: updates.url ?? overrideUrl ?? '',
              screen_size: updates.screen_size ?? screenSize,
              responsive_width:
                updates.responsive_width ?? responsiveDimensions.width,
              responsive_height:
                updates.responsive_height ?? responsiveDimensions.height,
              shortcuts: scratchData?.shortcuts ?? [],
            },
          },
        });
      } catch (e) {
        console.error('[usePreviewSettings] Failed to save:', e);
      }
    },
    [
      workspaceId,
      updateScratch,
      overrideUrl,
      screenSize,
      responsiveDimensions.width,
      responsiveDimensions.height,
      scratchData?.shortcuts,
    ]
  );

  // Debounced save for URL changes (frequent typing)
  const { debounced: debouncedSaveUrl } = useDebouncedCallback(
    async (url: string) => {
      await saveSettings({ url });
    },
    300
  );

  // Debounced save for responsive dimensions (frequent dragging)
  const { debounced: debouncedSaveDimensions } = useDebouncedCallback(
    async (dimensions: ResponsiveDimensions) => {
      await saveSettings({
        responsive_width: dimensions.width,
        responsive_height: dimensions.height,
      });
    },
    300
  );

  const setOverrideUrl = useCallback(
    (url: string) => {
      debouncedSaveUrl(url);
    },
    [debouncedSaveUrl]
  );

  const setScreenSize = useCallback(
    (size: ScreenSize) => {
      saveSettings({ screen_size: size });
    },
    [saveSettings]
  );

  const setResponsiveDimensions = useCallback(
    (dimensions: ResponsiveDimensions) => {
      debouncedSaveDimensions(dimensions);
    },
    [debouncedSaveDimensions]
  );

  const clearOverride = useCallback(async () => {
    await saveSettings({ url: '' });
  }, [saveSettings]);

  const addShortcut = useCallback(
    async (shortcut: Omit<PreviewShortcut, 'id'>) => {
      const trimmedUrl = shortcut.url.trim();
      if (!trimmedUrl) return;

      const normalizedLabel = shortcut.label.trim() || trimmedUrl;
      const normalizedShortcut: PreviewShortcut = {
        id:
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label: normalizedLabel,
        url: trimmedUrl,
      };

      const nextShortcuts = [
        ...shortcuts.filter((item) => item.url !== trimmedUrl),
        normalizedShortcut,
      ];
      setPreviewShortcuts(projectKey, nextShortcuts);
    },
    [setPreviewShortcuts, shortcuts, projectKey]
  );

  const removeShortcut = useCallback(
    async (id: string) => {
      const nextShortcuts = shortcuts.filter((shortcut) => shortcut.id !== id);
      setPreviewShortcuts(projectKey, nextShortcuts);
    },
    [setPreviewShortcuts, shortcuts, projectKey]
  );

  return {
    overrideUrl,
    hasOverride,
    setOverrideUrl,
    clearOverride,
    screenSize,
    responsiveDimensions,
    setScreenSize,
    setResponsiveDimensions,
    shortcuts,
    addShortcut,
    removeShortcut,
    isLoading: isScratchLoading,
  };
}
