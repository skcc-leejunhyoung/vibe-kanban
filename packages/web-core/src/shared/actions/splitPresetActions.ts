import { LayoutIcon } from '@phosphor-icons/react';
import { WORKSPACE_PANE_COUNTS } from '@/shared/stores/useWorkspacePanesStore';
import { applyWorkspacePaneCount } from '@/shared/lib/openInSplitPane';
import {
  ActionTargetType,
  type GlobalActionDefinition,
} from '@/shared/types/actions';

export const splitPresetActions: GlobalActionDefinition[] =
  WORKSPACE_PANE_COUNTS.map((count) => ({
    id: `splitPreset${count}`,
    label: `Window preset: ${count} pane${count === 1 ? '' : 's'}`,
    keywords: [
      'window preset',
      'split',
      'pane',
      'layout',
      '창 프리셋',
      '분할',
      `cmd opt shift ${count}`,
      String(count),
    ],
    icon: LayoutIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: (ctx) => applyWorkspacePaneCount(count, ctx.appNavigation),
  }));
