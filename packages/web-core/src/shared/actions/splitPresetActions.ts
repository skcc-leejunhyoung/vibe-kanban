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
    label: `Window preset: ${preset} pane${preset === 1 ? '' : 's'}`,
    keywords: [
      'window preset',
      'split',
      'pane',
      'layout',
      '창 프리셋',
      '분할',
      `cmd opt shift ${preset}`,
      String(preset),
    ],
    icon: LayoutIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: () => activateSplitPreset(preset),
  })
);
