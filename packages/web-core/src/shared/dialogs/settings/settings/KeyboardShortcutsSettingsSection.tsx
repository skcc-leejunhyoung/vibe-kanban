import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwiseIcon, XIcon } from '@phosphor-icons/react';
import {
  modifierBindings,
  sequentialBindings,
  reservedBindings,
  mapCodeToLogicalKey,
  displayKeyParts,
  buildCombo,
  type ShortcutType,
} from '@/shared/keyboard/registry';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';
import { cn } from '@/shared/lib/utils';
import { SettingsCard } from './SettingsComponents';

interface ShortcutEntry {
  id: string;
  type: ShortcutType;
  /** i18n key under common:shortcuts.actions.* */
  actionId: string;
  /** registry default in storage syntax ('w>a' or 'mod+k') */
  defaultKeys: string;
}

// First key of a sequence -> i18n group key under common:shortcuts.groups.*
const FIRST_KEY_TO_GROUP: Record<string, string> = {
  g: 'goTo',
  w: 'workspace',
  v: 'view',
  i: 'issues',
  x: 'git',
  y: 'yank',
  t: 'toggle',
  r: 'run',
};

const SEQUENCE_GROUP_ORDER = ['g', 'w', 'v', 'i', 'x', 'y', 't', 'r'];

interface EntryGroup {
  groupKey: string;
  entries: ShortcutEntry[];
}

// Built once from the registry; default keys never change at runtime.
const ENTRY_GROUPS: EntryGroup[] = (() => {
  const groups: EntryGroup[] = [];

  groups.push({
    groupKey: 'modifiers',
    entries: modifierBindings.map((b) => ({
      id: b.id,
      type: 'modifier' as const,
      actionId: b.actionId,
      defaultKeys: b.keys,
    })),
  });

  for (const firstKey of SEQUENCE_GROUP_ORDER) {
    const entries = sequentialBindings
      .filter((b) => b.keys[0] === firstKey)
      .map((b) => ({
        id: b.id,
        type: 'sequence' as const,
        actionId: b.actionId,
        defaultKeys: b.keys.join('>'),
      }));
    if (entries.length > 0) {
      groups.push({ groupKey: FIRST_KEY_TO_GROUP[firstKey], entries });
    }
  }

  return groups;
})();

function KeyChips({ keys }: { keys: string }) {
  return (
    <div className="flex items-center gap-1">
      {displayKeyParts(keys).map((part, i) => (
        <kbd
          key={i}
          className={cn(
            'inline-flex items-center justify-center',
            'min-w-[24px] h-6 px-1.5',
            'rounded-sm border border-border bg-secondary',
            'font-ibm-plex-mono text-xs text-high'
          )}
        >
          {part}
        </kbd>
      ))}
    </div>
  );
}

/**
 * Captures a new binding from the keyboard. Uses a capture-phase listener with
 * stopImmediatePropagation so live shortcuts don't fire while recording.
 *
 * A held modifier always produces a combo ('mod+a'). With `allowSequence`
 * (sequence bindings), a modifier-free keystroke instead starts a two-key
 * sequence ('w>a'); modifier bindings (command bar) require a combo.
 */
function ShortcutRecorder({
  allowSequence,
  onCapture,
  onCancel,
}: {
  allowSequence: boolean;
  onCapture: (keys: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const seqBufferRef = useRef<string[]>([]);
  const onCaptureRef = useRef(onCapture);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCaptureRef.current = onCapture;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    seqBufferRef.current = [];
    const handler = (e: KeyboardEvent) => {
      // Skip IME composition (e.g. Korean/Japanese/Chinese input)
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === 'Escape') {
        onCancelRef.current();
        return;
      }
      // Ignore lone modifier keypresses
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

      const key = mapCodeToLogicalKey(e.code, e.key);
      if (!key) return;

      // A modifier combo takes priority for every binding type.
      const combo = buildCombo(e, key);
      if (combo) {
        onCaptureRef.current(combo);
        return;
      }
      // No modifier: only sequence bindings accept a plain two-key sequence.
      if (!allowSequence) return;
      seqBufferRef.current = [...seqBufferRef.current, key];
      if (seqBufferRef.current.length === 2) {
        onCaptureRef.current(seqBufferRef.current.join('>'));
        seqBufferRef.current = [];
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true });
  }, [allowSequence]);

  return (
    <span className="text-xs text-brand font-medium animate-pulse">
      {allowSequence
        ? t('settings.keyboardShortcuts.recording.sequence')
        : t('settings.keyboardShortcuts.recording.modifier')}
    </span>
  );
}

interface EffectiveBinding {
  id: string;
  actionId: string;
  keys: string;
}

function ShortcutRow({
  entry,
  effectiveKeys,
  isOverridden,
  allEffective,
  onSet,
  onReset,
}: {
  entry: ShortcutEntry;
  effectiveKeys: string;
  isOverridden: boolean;
  allEffective: EffectiveBinding[];
  onSet: (id: string, keys: string) => void;
  onReset: (id: string) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = t(`shortcuts.actions.${entry.actionId}`, {
    ns: 'common',
    defaultValue: entry.actionId,
  });

  const handleCapture = useCallback(
    (keys: string) => {
      // Disabled bindings ('') don't conflict; only non-empty values do.
      const conflict = allEffective.find(
        (b) => b.id !== entry.id && b.keys !== '' && b.keys === keys
      );
      if (conflict) {
        const conflictLabel = t(`shortcuts.actions.${conflict.actionId}`, {
          ns: 'common',
          defaultValue: conflict.actionId,
        });
        setError(
          t('settings.keyboardShortcuts.conflict', { action: conflictLabel })
        );
        setRecording(false);
        return;
      }
      setError(null);
      onSet(entry.id, keys);
      setRecording(false);
    },
    [allEffective, entry.id, onSet, t]
  );

  // Clear = store an empty override so the shortcut is disabled (kept blank).
  const handleClear = useCallback(() => {
    setError(null);
    onSet(entry.id, '');
    setRecording(false);
  }, [entry.id, onSet]);

  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-normal truncate">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {recording ? (
            <>
              <ShortcutRecorder
                allowSequence={entry.type === 'sequence'}
                onCapture={handleCapture}
                onCancel={() => setRecording(false)}
              />
              <button
                type="button"
                onClick={handleClear}
                className="text-low hover:text-normal"
                title={t('settings.keyboardShortcuts.clear')}
                aria-label={t('settings.keyboardShortcuts.clear')}
              >
                <XIcon className="size-icon-xs" weight="bold" />
              </button>
            </>
          ) : effectiveKeys === '' ? (
            <span className="text-xs text-low italic">
              {t('settings.keyboardShortcuts.disabled')}
            </span>
          ) : (
            <KeyChips keys={effectiveKeys} />
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setRecording((r) => !r);
            }}
            className="text-xs text-low hover:text-normal underline-offset-2 hover:underline"
          >
            {recording
              ? t('settings.keyboardShortcuts.cancel')
              : t('settings.keyboardShortcuts.change')}
          </button>
          {isOverridden && !recording && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                onReset(entry.id);
              }}
              className="text-low hover:text-normal"
              title={t('settings.keyboardShortcuts.reset')}
              aria-label={t('settings.keyboardShortcuts.reset')}
            >
              <ArrowCounterClockwiseIcon
                className="size-icon-xs"
                weight="bold"
              />
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-error mt-1 text-right">{error}</p>}
    </div>
  );
}

export function KeyboardShortcutsSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const setOverride = useKeyboardShortcutsStore((s) => s.setOverride);
  const resetOverride = useKeyboardShortcutsStore((s) => s.resetOverride);
  const resetAll = useKeyboardShortcutsStore((s) => s.resetAll);

  const hasOverrides = Object.keys(overrides).length > 0;

  const effectiveKeysFor = useCallback(
    (entry: ShortcutEntry) => overrides[entry.id] ?? entry.defaultKeys,
    [overrides]
  );

  // Flat list of effective bindings for conflict detection. Reserved (non-
  // rebindable) shortcuts are included so the recorder warns when a user binds
  // onto one (e.g. mod+a, used by issue multi-select) even though they can't be
  // changed or reset here.
  const allEffective = useMemo<EffectiveBinding[]>(() => {
    const list: EffectiveBinding[] = [];
    for (const group of ENTRY_GROUPS) {
      for (const entry of group.entries) {
        list.push({
          id: entry.id,
          actionId: entry.actionId,
          keys: overrides[entry.id] ?? entry.defaultKeys,
        });
      }
    }
    for (const r of reservedBindings) {
      list.push({ id: r.id, actionId: r.actionId, keys: r.keys });
    }
    return list;
  }, [overrides]);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-low">
          {t('settings.keyboardShortcuts.description')}
        </p>
        {hasOverrides && (
          <button
            type="button"
            onClick={resetAll}
            className="shrink-0 text-xs text-low hover:text-normal underline-offset-2 hover:underline"
          >
            {t('settings.keyboardShortcuts.resetAll')}
          </button>
        )}
      </div>

      {ENTRY_GROUPS.map((group) => (
        <SettingsCard
          key={group.groupKey}
          title={t(`shortcuts.groups.${group.groupKey}`, { ns: 'common' })}
        >
          <div className="divide-y divide-border/50">
            {group.entries.map((entry) => (
              <ShortcutRow
                key={entry.id}
                entry={entry}
                effectiveKeys={effectiveKeysFor(entry)}
                isOverridden={entry.id in overrides}
                allEffective={allEffective}
                onSet={setOverride}
                onReset={resetOverride}
              />
            ))}
          </div>
        </SettingsCard>
      ))}

      <p className="text-xs text-low">
        {t('settings.keyboardShortcuts.sequentialHint')}
      </p>
    </>
  );
}
