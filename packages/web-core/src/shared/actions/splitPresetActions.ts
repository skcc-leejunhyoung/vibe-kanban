import { LayoutIcon, XIcon, ColumnsIcon } from '@phosphor-icons/react';
import { WORKSPACE_PANE_COUNTS } from '@/shared/stores/useWorkspacePanesStore';
import {
  closeActivePane,
  focusPaneAt,
  openNewPane,
} from '@/shared/lib/openInSplitPane';
import {
  ActionTargetType,
  type GlobalActionDefinition,
} from '@/shared/types/actions';

/**
 * Command palette entries for the pane grid, VS Code style: focus pane N,
 * new pane, close pane. (File keeps its historic name; the "presets" are the
 * rebindable mod+alt+shift+N bindings, which now focus instead of resize.)
 */
export const splitPresetActions: GlobalActionDefinition[] = [
  {
    id: 'newPane',
    label: 'New pane',
    keywords: ['pane', 'split', 'new', 'open', '분할', '새 패널', 'cmd t'],
    icon: ColumnsIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: (ctx) => openNewPane(ctx.appNavigation),
  },
  {
    id: 'closePane',
    label: 'Close pane',
    keywords: ['pane', 'split', 'close', '분할', '패널 닫기', 'cmd w'],
    icon: XIcon,
    requiresTarget: ActionTargetType.NONE,
    execute: (ctx) => closeActivePane(ctx.appNavigation),
  },
  ...WORKSPACE_PANE_COUNTS.map(
    (count): GlobalActionDefinition => ({
      id: `focusPane${count}`,
      label: `Focus pane ${count}`,
      keywords: [
        'pane',
        'focus',
        'split',
        '패널 포커스',
        `cmd opt shift ${count}`,
        String(count),
      ],
      icon: LayoutIcon,
      requiresTarget: ActionTargetType.NONE,
      execute: (ctx) => focusPaneAt(count - 1, ctx.appNavigation),
    })
  ),
];
