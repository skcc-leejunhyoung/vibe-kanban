import { LayoutIcon } from '@phosphor-icons/react';
import { SPLIT_PRESETS } from '@/shared/stores/useSplitScreenStore';
import { activateSplitPreset } from '@/shared/lib/openInSplitPane';
import {
  ActionTargetType,
  type GlobalActionDefinition,
} from '@/shared/types/actions';

export const splitPresetActions: GlobalActionDefinition[] = SPLIT_PRESETS.map(
  (preset) => ({
    id: `splitPreset${preset}`,
    label: `${preset}-pane layout`,
    keywords: ['split', 'pane', 'layout', '분할', String(preset)],
    icon: LayoutIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: () => activateSplitPreset(preset),
  })
);
