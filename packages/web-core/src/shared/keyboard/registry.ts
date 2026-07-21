import { isMac, getModifierKey } from '@/shared/lib/platform';

export enum Scope {
  GLOBAL = 'global',
  DIALOG = 'dialog',
  CONFIRMATION = 'confirmation',
  KANBAN = 'kanban',
  PROJECTS = 'projects',
  SETTINGS = 'settings',
  EDIT_COMMENT = 'edit-comment',
  APPROVALS = 'approvals',
  FOLLOW_UP = 'follow-up',
  FOLLOW_UP_READY = 'follow-up-ready',
  WORKSPACE = 'workspace',
}

export enum Action {
  EXIT = 'exit',
  CREATE = 'create',
  SUBMIT = 'submit',
  FOCUS_SEARCH = 'focus_search',
  NAV_UP = 'nav_up',
  NAV_DOWN = 'nav_down',
  NAV_LEFT = 'nav_left',
  NAV_RIGHT = 'nav_right',
  OPEN_DETAILS = 'open_details',
  SHOW_HELP = 'show_help',
  DELETE_TASK = 'delete_task',
  APPROVE_REQUEST = 'approve_request',
  DENY_APPROVAL = 'deny_approval',
  SUBMIT_FOLLOW_UP = 'submit_follow_up',
  SUBMIT_TASK = 'submit_task',
  SUBMIT_TASK_ALT = 'submit_task_alt',
  SUBMIT_COMMENT = 'submit_comment',
  CYCLE_VIEW_BACKWARD = 'cycle_view_backward',
}

export interface KeyBinding {
  action: Action;
  keys: string | string[];
  scopes?: Scope[];
  description: string;
  group?: string;
}

/**
 * Sequential keyboard shortcut binding (e.g., "g s" for Go to Settings)
 */
export interface SequentialBinding {
  id: string;
  keys: string[];
  scopes?: Scope[];
  description: string;
  group: string;
  actionId: string;
}

/**
 * Valid first keys for sequential shortcuts.
 * These keys will be intercepted to start a sequence.
 */
export const SEQUENCE_FIRST_KEYS = new Set([
  'g', // Go/Navigate
  'w', // Workspace
  'v', // View
  'x', // eXecute (git)
  'y', // Yank/Copy
  't', // Toggle
  'r', // Run
  'i', // Issue
]);

/**
 * All sequential keyboard shortcuts organized by namespace
 */
export const sequentialBindings: SequentialBinding[] = [
  // Navigation (G = Go)
  {
    id: 'seq-go-settings',
    keys: ['g', 's'],
    description: 'Go to Settings',
    group: 'Navigation',
    actionId: 'settings',
  },
  {
    id: 'seq-go-new-workspace',
    keys: ['g', 'n'],
    description: 'Go to New Workspace',
    group: 'Navigation',
    actionId: 'new-workspace',
  },
  {
    id: 'seq-go-quick-chat',
    keys: ['g', 'q'],
    description: 'Open Quick Chat',
    group: 'Navigation',
    actionId: 'quick-chat',
  },

  // Workspace (W)
  {
    id: 'seq-workspace-new-session',
    keys: ['w', 's'],
    description: 'New session',
    group: 'Workspace',
    actionId: 'new-session',
  },
  {
    id: 'seq-workspace-duplicate',
    keys: ['w', 'd'],
    description: 'Duplicate workspace',
    group: 'Workspace',
    actionId: 'duplicate-workspace',
  },
  {
    id: 'seq-workspace-rename',
    keys: ['w', 'r'],
    description: 'Rename workspace',
    group: 'Workspace',
    actionId: 'rename-workspace',
  },
  {
    id: 'seq-workspace-pin',
    keys: ['w', 'p'],
    description: 'Pin/Unpin workspace',
    group: 'Workspace',
    actionId: 'pin-workspace',
  },
  {
    id: 'seq-workspace-archive',
    keys: ['w', 'a'],
    description: 'Archive workspace',
    group: 'Workspace',
    actionId: 'archive-workspace',
  },
  {
    id: 'seq-workspace-delete',
    keys: ['w', 'x'],
    description: 'Delete workspace',
    group: 'Workspace',
    actionId: 'delete-workspace',
  },

  // View (V)
  {
    id: 'seq-view-changes',
    keys: ['v', 'c'],
    description: 'Toggle Changes panel',
    group: 'View',
    actionId: 'toggle-changes-mode',
  },
  {
    id: 'seq-view-logs',
    keys: ['v', 'l'],
    description: 'Toggle Logs panel',
    group: 'View',
    actionId: 'toggle-logs-mode',
  },
  {
    id: 'seq-view-preview',
    keys: ['v', 'p'],
    description: 'Toggle Preview panel',
    group: 'View',
    actionId: 'toggle-preview-mode',
  },
  {
    id: 'seq-view-sidebar',
    keys: ['v', 's'],
    description: 'Toggle Left Sidebar',
    group: 'View',
    actionId: 'toggle-left-sidebar',
  },
  {
    id: 'seq-view-right-sidebar',
    keys: ['v', 'r'],
    description: 'Toggle Right Sidebar',
    group: 'View',
    actionId: 'toggle-right-sidebar',
  },
  {
    id: 'seq-view-chat',
    keys: ['v', 'h'],
    description: 'Toggle Chat panel',
    group: 'View',
    actionId: 'toggle-left-main-panel',
  },

  // Git (X = eXecute)
  {
    id: 'seq-git-pr',
    keys: ['x', 'p'],
    scopes: [Scope.WORKSPACE],
    description: 'Create Pull Request',
    group: 'Git',
    actionId: 'git-create-pr',
  },
  {
    id: 'seq-git-merge',
    keys: ['x', 'm'],
    scopes: [Scope.WORKSPACE],
    description: 'Merge branch',
    group: 'Git',
    actionId: 'git-merge',
  },
  {
    id: 'seq-git-commit',
    keys: ['x', 'c'],
    scopes: [Scope.WORKSPACE],
    description: 'Commit uncommitted changes',
    group: 'Git',
    actionId: 'git-commit',
  },
  {
    id: 'seq-git-rebase',
    keys: ['x', 'r'],
    scopes: [Scope.WORKSPACE],
    description: 'Rebase branch',
    group: 'Git',
    actionId: 'git-rebase',
  },
  {
    id: 'seq-git-push',
    keys: ['x', 'u'],
    scopes: [Scope.WORKSPACE],
    description: 'Push changes',
    group: 'Git',
    actionId: 'git-push',
  },

  // Yank/Copy (Y)
  {
    id: 'seq-yank-path',
    keys: ['y', 'p'],
    scopes: [Scope.WORKSPACE],
    description: 'Copy path',
    group: 'Yank',
    actionId: 'copy-path',
  },
  {
    id: 'seq-yank-logs',
    keys: ['y', 'l'],
    scopes: [Scope.WORKSPACE],
    description: 'Copy raw logs',
    group: 'Yank',
    actionId: 'copy-raw-logs',
  },

  // Toggle (T)
  {
    id: 'seq-toggle-dev-server',
    keys: ['t', 'd'],
    scopes: [Scope.WORKSPACE],
    description: 'Toggle dev server',
    group: 'Toggle',
    actionId: 'toggle-dev-server',
  },
  {
    id: 'seq-toggle-wrap',
    keys: ['t', 'w'],
    scopes: [Scope.WORKSPACE],
    description: 'Toggle line wrapping',
    group: 'Toggle',
    actionId: 'toggle-wrap-lines',
  },

  // Run (R)
  {
    id: 'seq-run-setup',
    keys: ['r', 's'],
    scopes: [Scope.WORKSPACE],
    description: 'Run setup script',
    group: 'Run',
    actionId: 'run-setup-script',
  },
  {
    id: 'seq-run-cleanup',
    keys: ['r', 'c'],
    scopes: [Scope.WORKSPACE],
    description: 'Run cleanup script',
    group: 'Run',
    actionId: 'run-cleanup-script',
  },
  {
    id: 'seq-run-archive',
    keys: ['r', 'a'],
    scopes: [Scope.WORKSPACE],
    description: 'Run archive script',
    group: 'Run',
    actionId: 'run-archive-script',
  },

  // Issue (I)
  {
    id: 'seq-issue-create',
    keys: ['i', 'c'],
    description: 'Create Issue',
    group: 'Issue',
    actionId: 'create-issue',
  },
  {
    id: 'seq-issue-status',
    keys: ['i', 's'],
    description: 'Change Status',
    group: 'Issue',
    actionId: 'change-issue-status',
  },
  {
    id: 'seq-issue-priority',
    keys: ['i', 'p'],
    description: 'Change Priority',
    group: 'Issue',
    actionId: 'change-issue-priority',
  },
  {
    id: 'seq-issue-assignees',
    keys: ['i', 'a'],
    description: 'Change Assignees',
    group: 'Issue',
    actionId: 'change-assignees',
  },
  {
    id: 'seq-issue-make-sub-issue',
    keys: ['i', 'm'],
    description: 'Make Sub-issue of',
    group: 'Issue',
    actionId: 'make-sub-issue-of',
  },
  {
    id: 'seq-issue-add-sub-issue',
    keys: ['i', 'b'],
    description: 'Add Sub-issue',
    group: 'Issue',
    actionId: 'add-sub-issue',
  },
  {
    id: 'seq-issue-remove-parent',
    keys: ['i', 'u'],
    description: 'Remove Parent',
    group: 'Issue',
    actionId: 'remove-parent-issue',
  },
  {
    id: 'seq-issue-link-workspace',
    keys: ['i', 'w'],
    description: 'Link Workspace',
    group: 'Issue',
    actionId: 'link-workspace',
  },
  {
    id: 'seq-issue-duplicate',
    keys: ['i', 'd'],
    description: 'Duplicate Issue',
    group: 'Issue',
    actionId: 'duplicate-issue',
  },
  {
    id: 'seq-issue-delete',
    keys: ['i', 'x'],
    description: 'Delete Issue',
    group: 'Issue',
    actionId: 'delete-issue',
  },
];

export const keyBindings: KeyBinding[] = [
  // Exit/Close actions
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.CONFIRMATION],
    description: 'Close confirmation dialog',
    group: 'Dialog',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.DIALOG],
    description: 'Close dialog or blur input',
    group: 'Dialog',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.KANBAN],
    description: 'Close panel or navigate to projects',
    group: 'Navigation',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.EDIT_COMMENT],
    description: 'Cancel comment',
    group: 'Comments',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.SETTINGS],
    description: 'Close settings',
    group: 'Navigation',
  },

  // Creation actions
  {
    action: Action.CREATE,
    keys: 'c',
    scopes: [Scope.KANBAN],
    description: 'Create new task',
    group: 'Kanban',
  },
  {
    action: Action.CREATE,
    keys: 'c',
    scopes: [Scope.PROJECTS],
    description: 'Create new project',
    group: 'Projects',
  },

  // Submit actions
  {
    action: Action.SUBMIT,
    keys: 'enter',
    scopes: [Scope.DIALOG],
    description: 'Submit form or confirm action',
    group: 'Dialog',
  },

  // Navigation actions
  {
    action: Action.FOCUS_SEARCH,
    keys: 'slash',
    scopes: [Scope.KANBAN],
    description: 'Focus search',
    group: 'Navigation',
  },
  {
    action: Action.NAV_UP,
    keys: 'up',
    scopes: [Scope.KANBAN],
    description: 'Move up within column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_DOWN,
    keys: 'down',
    scopes: [Scope.KANBAN],
    description: 'Move down within column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_LEFT,
    keys: 'left',
    scopes: [Scope.KANBAN],
    description: 'Move to previous column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_RIGHT,
    keys: 'right',
    scopes: [Scope.KANBAN],
    description: 'Move to next column',
    group: 'Navigation',
  },
  {
    action: Action.OPEN_DETAILS,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.KANBAN],
    description:
      'Open details; when open, cycle views forward (attempt → preview → diffs)',
    group: 'Navigation',
  },
  {
    action: Action.CYCLE_VIEW_BACKWARD,
    keys: ['meta+shift+enter', 'ctrl+shift+enter'],
    scopes: [Scope.KANBAN],
    description: 'Cycle views backward (diffs → preview → attempt)',
    group: 'Navigation',
  },

  // Global actions
  {
    action: Action.SHOW_HELP,
    keys: 'shift+slash',
    scopes: [Scope.GLOBAL],
    description: 'Show keyboard shortcuts help',
    group: 'Global',
  },

  // Task actions
  {
    action: Action.DELETE_TASK,
    keys: 'd',
    scopes: [Scope.KANBAN],
    description: 'Delete selected task',
    group: 'Task Details',
  },

  // Approval actions
  {
    action: Action.APPROVE_REQUEST,
    keys: 'enter',
    scopes: [Scope.APPROVALS],
    description: 'Approve pending approval request',
    group: 'Approvals',
  },
  {
    action: Action.DENY_APPROVAL,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.APPROVALS],
    description: 'Deny pending approval request',
    group: 'Approvals',
  },

  // Follow-up actions
  {
    action: Action.SUBMIT_FOLLOW_UP,
    keys: 'meta+enter',
    scopes: [Scope.FOLLOW_UP_READY],
    description: 'Send or queue follow-up (depending on state)',
    group: 'Follow-up',
  },
  {
    action: Action.SUBMIT_TASK,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.DIALOG],
    description: 'Submit task form (Create & Start or Update)',
    group: 'Dialog',
  },
  {
    action: Action.SUBMIT_TASK_ALT,
    keys: ['meta+shift+enter', 'ctrl+shift+enter'],
    scopes: [Scope.DIALOG],
    description: 'Submit task form (Create Task)',
    group: 'Dialog',
  },
  {
    action: Action.SUBMIT_COMMENT,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.EDIT_COMMENT],
    description: 'Submit review comment',
    group: 'Comments',
  },
];

/**
 * Modifier-combo shortcuts (e.g. Cmd/Ctrl+K). Unlike the single-key entries in
 * `keyBindings`, these are user-rebindable via the Keyboard Shortcuts settings.
 */
export const COMMAND_BAR_BINDING_ID = 'command-bar';
export const NEXT_WORKSPACE_BINDING_ID = 'next-workspace';
export const PREVIOUS_WORKSPACE_BINDING_ID = 'previous-workspace';
export const NEXT_SPLIT_PANE_BINDING_ID = 'next-split-pane';
export const PREVIOUS_SPLIT_PANE_BINDING_ID = 'previous-split-pane';
export const SPLIT_PRESET_BINDING_IDS = {
  1: 'split-preset-1',
  2: 'split-preset-2',
  3: 'split-preset-3',
  4: 'split-preset-4',
} as const;

export interface ModifierBinding {
  id: string;
  /** Matcher syntax with a leading modifier, e.g. 'mod+k' */
  keys: string;
  /** i18n key under common:shortcuts.actions.* */
  actionId: string;
  group: string;
}

export const modifierBindings: ModifierBinding[] = [
  {
    id: COMMAND_BAR_BINDING_ID,
    keys: 'mod+k',
    actionId: 'openCommandBar',
    group: 'Modifiers',
  },
  {
    id: NEXT_WORKSPACE_BINDING_ID,
    keys: 'ctrl+tab',
    actionId: 'nextWorkspace',
    group: 'Modifiers',
  },
  {
    id: PREVIOUS_WORKSPACE_BINDING_ID,
    keys: 'ctrl+shift+tab',
    actionId: 'previousWorkspace',
    group: 'Modifiers',
  },
  {
    id: NEXT_SPLIT_PANE_BINDING_ID,
    keys: 'mod+shift+alt+right',
    actionId: 'nextSplitPane',
    group: 'Modifiers',
  },
  {
    id: PREVIOUS_SPLIT_PANE_BINDING_ID,
    keys: 'mod+shift+alt+left',
    actionId: 'previousSplitPane',
    group: 'Modifiers',
  },
  ...([1, 2, 3, 4] as const).map((preset) => ({
    id: SPLIT_PRESET_BINDING_IDS[preset],
    keys: `mod+shift+alt+${preset}`,
    actionId: `splitPreset${preset}`,
    group: 'Modifiers',
  })),
];

/**
 * Get keyboard bindings for a specific action and scope
 */
export function getKeysFor(action: Action, scope?: Scope): string[] {
  const bindings = keyBindings
    .filter(
      (binding) =>
        binding.action === action &&
        (!scope || !binding.scopes || binding.scopes.includes(scope))
    )
    .flatMap((binding) =>
      Array.isArray(binding.keys) ? binding.keys : [binding.keys]
    );

  return bindings;
}

/**
 * Get binding info for a specific action and scope
 */
export function getBindingFor(
  action: Action,
  scope?: Scope
): KeyBinding | undefined {
  return keyBindings.find(
    (binding) =>
      binding.action === action &&
      (!scope || !binding.scopes || binding.scopes.includes(scope))
  );
}

/**
 * Get sequential binding for a specific action ID
 */
export function getSequentialBindingFor(
  actionId: string
): SequentialBinding | undefined {
  return sequentialBindings.find((binding) => binding.actionId === actionId);
}

export type ShortcutType = 'sequence' | 'modifier';

/**
 * Map a KeyboardEvent's physical `code` to a logical key for layout
 * independence (e.g. 'KeyG' -> 'g', 'Digit5' -> '5'), falling back to the
 * lowercased `event.key` for other codes. Single source of truth shared by
 * the settings recorder, the SequenceTracker, and the command-bar matcher;
 * kept consistent with how react-hotkeys-hook normalizes keys via event.code.
 */
export function mapCodeToLogicalKey(code: string, key: string): string {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return key.toLowerCase();
}

/**
 * Human-readable key chips for display. Format is inferred from the value
 * itself: empty => no chips (disabled), contains '>' => a sequence split on
 * '>', otherwise a modifier combo split on '+' with each modifier mapped to its
 * platform glyph. A binding can be rebound across formats, so display must not
 * rely on the binding's declared type.
 */
export function displayKeyParts(keys: string): string[] {
  const displayKey = (key: string) => {
    switch (key) {
      case 'escape':
      case 'esc':
        return 'Esc';
      default:
        return key.toUpperCase();
    }
  };
  if (!keys) return [];
  if (keys.includes('>')) {
    return keys.split('>').map(displayKey);
  }
  return keys.split('+').map((part) => {
    switch (part) {
      case 'mod':
        return getModifierKey();
      case 'ctrl':
        return 'Ctrl';
      case 'meta':
        return isMac() ? '⌘' : 'Win';
      case 'shift':
        return '⇧';
      case 'alt':
        return isMac() ? '⌥' : 'Alt';
      default:
        return displayKey(part);
    }
  });
}

// ---------------------------------------------------------------------------
// Override-aware resolvers
//
// These take the user `overrides` map (from useKeyboardShortcutsStore) as an
// argument rather than reading the store directly, so this module stays free of
// an import cycle and the values stay reactive in callers that subscribe.
//
// An override value is one of three forms:
//   - sequence:  'w>a'   (react-hotkeys-hook sequence syntax)
//   - combo:     'mod+a' (a sequence binding may be rebound to a modifier combo)
//   - empty:     ''      (binding cleared / disabled)
// Absence of an entry means "use the default", but an empty string means
// "disabled", so resolvers check `id in overrides` rather than truthiness.
// ---------------------------------------------------------------------------

type Overrides = Record<string, string>;

/** True when an effective value is a two-key sequence (vs a combo or empty). */
export function isSequenceKeys(keys: string): boolean {
  return keys.includes('>');
}

/**
 * Effective hotkey for a sequential binding, honoring overrides. Returns
 * sequence syntax ('w>a'), a combo ('mod+a') if rebound, or '' if disabled.
 */
export function resolveSequence(id: string, overrides: Overrides): string {
  if (id in overrides) return overrides[id];
  const binding = sequentialBindings.find((b) => b.id === id);
  return binding ? binding.keys.join('>') : '';
}

/**
 * Effective combo for a modifier binding (e.g. the command bar), honoring
 * overrides. Returns matcher syntax ('mod+k') or '' if disabled.
 */
export function resolveModifier(id: string, overrides: Overrides): string {
  if (id in overrides) return overrides[id];
  const binding = modifierBindings.find((b) => b.id === id);
  return binding ? binding.keys : '';
}

/** Sequential bindings paired with their effective key string (overrides applied). */
export function effectiveSequentialBindings(
  overrides: Overrides
): { binding: SequentialBinding; keys: string }[] {
  return sequentialBindings.map((binding) => ({
    binding,
    keys: resolveSequence(binding.id, overrides),
  }));
}

/**
 * Valid first keys for sequences, with overrides applied (for SequenceTracker).
 * Only true sequences participate; combo and disabled overrides are excluded.
 */
export function effectiveFirstKeys(overrides: Overrides): Set<string> {
  const set = new Set<string>();
  for (const { keys } of effectiveSequentialBindings(overrides)) {
    if (isSequenceKeys(keys)) set.add(keys.split('>')[0]);
  }
  return set;
}

/** Full sequences (comma-joined) for validity checks, with overrides applied. */
export function effectiveValidSequences(overrides: Overrides): Set<string> {
  const set = new Set<string>();
  for (const { keys } of effectiveSequentialBindings(overrides)) {
    if (isSequenceKeys(keys)) set.add(keys.split('>').join(','));
  }
  return set;
}

/**
 * Map an Action.id to the modifier binding it triggers. Modifier bindings carry
 * an i18n actionId that differs from the triggering Action.id (e.g.
 * 'openCommandBar' vs 'open-command-bar'), so this link is explicit. Sequence
 * bindings need no such map — their actionId IS the Action.id.
 */
const MODIFIER_BINDING_BY_ACTION_ID: Record<string, string> = {
  'open-command-bar': COMMAND_BAR_BINDING_ID,
};

/**
 * Effective shortcut string for display next to an action (navbar tooltips, the
 * command bar), honoring user overrides. Resolved by the action's id:
 *   - rebindable binding, active  -> the rebound keys ('V S', '⌘ K')
 *   - rebindable binding, cleared -> undefined (disabled: show no hint)
 *   - no rebindable binding       -> the action's static `shortcut` fallback
 * Keeps these hints in sync with the keys that actually fire and with the help
 * dialog / settings, instead of the hardcoded registry defaults.
 */
export function effectiveActionShortcut(
  actionId: string,
  staticShortcut: string | undefined,
  overrides: Overrides
): string | undefined {
  const seq = sequentialBindings.find((b) => b.actionId === actionId);
  if (seq) {
    return (
      displayKeyParts(resolveSequence(seq.id, overrides)).join(' ') || undefined
    );
  }
  const modifierId = MODIFIER_BINDING_BY_ACTION_ID[actionId];
  if (modifierId) {
    return (
      displayKeyParts(resolveModifier(modifierId, overrides)).join(' ') ||
      undefined
    );
  }
  return staticShortcut;
}

/**
 * Build a modifier combo string ('mod+shift+k') from a KeyboardEvent, or null
 * if no modifier is held. 'mod' = Cmd on macOS, Ctrl elsewhere. The key part is
 * the layout-independent logical key (see mapCodeToLogicalKey). Shared by the
 * settings recorder so captured combos round-trip with matchesCombo.
 */
export function buildCombo(e: KeyboardEvent, key: string): string | null {
  const mac = isMac();
  const parts: string[] = [];
  if ((mac && e.metaKey) || (!mac && e.ctrlKey)) parts.push('mod');
  if (mac && e.ctrlKey) parts.push('ctrl');
  if (!mac && e.metaKey) parts.push('meta');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join('+');
}

// ---------------------------------------------------------------------------
// Reserved (non-rebindable) shortcuts
//
// These are hardcoded in feature hooks (issue multi-selection in
// useIssueShortcuts) and are NOT part of the rebindable registry. They are
// listed here only so the settings recorder can flag a conflict when a user
// rebinds a sequence/combo onto one of them.
//
// Keys use the same normalized form `buildCombo` emits, so a captured value
// compares by exact string (note 'arrowdown'/'arrowup', the logical key for the
// arrow keys per mapCodeToLogicalKey). Single-key bindings (Escape, plain 'x')
// are intentionally omitted: a captured override is always either a combo (needs
// a modifier) or a two-key sequence, so a bare key can never collide with them.
// ---------------------------------------------------------------------------

export interface ReservedBinding {
  /** Stable id, namespaced so it never collides with a rebindable binding id. */
  id: string;
  /** i18n key under common:shortcuts.actions.* */
  actionId: string;
  /** Combo in buildCombo's normalized form, e.g. 'mod+a'. */
  keys: string;
}

export const reservedBindings: ReservedBinding[] = [
  { id: 'reserved-select-all', actionId: 'selectAllIssues', keys: 'mod+a' },
  {
    id: 'reserved-extend-down',
    actionId: 'extendSelectionDown',
    keys: 'shift+j',
  },
  {
    id: 'reserved-extend-down-arrow',
    actionId: 'extendSelectionDown',
    keys: 'shift+arrowdown',
  },
  { id: 'reserved-extend-up', actionId: 'extendSelectionUp', keys: 'shift+k' },
  {
    id: 'reserved-extend-up-arrow',
    actionId: 'extendSelectionUp',
    keys: 'shift+arrowup',
  },
];
