import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { defineModal, type NoProps } from '@/shared/lib/modals';
import { cn } from '@/shared/lib/utils';
import {
  BUILTIN_PRESETS,
  DEFAULT_THEME_VARIANT,
  THEME_TOKEN_GROUPS,
  clonePreset,
  defaultTokenValue,
  findPreset,
  tokenFromHex,
  tokenToHex,
  type ThemePreset,
  type ThemeTokenDef,
} from '@/shared/lib/themePresets';
import {
  useThemePresetActions,
  useThemePresets,
  useThemeVariant,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * A single editable token: a native color swatch + a hex text field, with a
 * label and the underlying CSS variable for orientation. The text field keeps
 * its own draft so partial edits don't fight the controlled value; it only
 * commits when it parses as a 6-digit hex.
 */
function TokenRow({
  def,
  value,
  onChange,
}: {
  def: ThemeTokenDef;
  value: string;
  onChange: (hex: string) => void;
}) {
  const hex = tokenToHex(def, value);
  const [text, setText] = useState(hex);

  useEffect(() => {
    setText(hex);
  }, [hex]);

  const commitText = (next: string) => {
    setText(next);
    const trimmed = next.trim();
    if (HEX6_RE.test(trimmed)) onChange(trimmed.toLowerCase());
  };

  return (
    <div className="flex items-center gap-2 py-1">
      <input
        type="color"
        value={hex}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        className="h-7 w-9 shrink-0 cursor-pointer rounded-sm border border-border bg-secondary p-0.5"
        aria-label={def.label}
      />
      <input
        type="text"
        value={text}
        onChange={(e) => commitText(e.target.value)}
        spellCheck={false}
        className={cn(
          'w-24 shrink-0 rounded-sm border bg-secondary px-2 py-1 text-xs',
          'font-mono text-high focus:outline-none focus:ring-1 focus:ring-brand',
          HEX6_RE.test(text.trim()) ? 'border-border' : 'border-error'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-normal">{def.label}</div>
        <code className="block truncate text-xs text-low">{def.cssVar}</code>
      </div>
    </div>
  );
}

function PresetBadge({ kind }: { kind: 'builtin' | 'modified' | 'custom' }) {
  const { t } = useTranslation('settings');
  const label = t(`settings.general.themeEditor.badge.${kind}`);
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 text-xs font-medium',
        kind === 'custom' ? 'bg-brand/15 text-brand' : 'bg-secondary text-low'
      )}
    >
      {label}
    </span>
  );
}

const ThemeVariantEditorDialogImpl = create<NoProps>(() => {
  const { t } = useTranslation(['settings', 'common']);
  const modal = useModal();

  const presets = useThemePresets();
  const customPresets = useUiPreferencesStore((s) => s.customThemePresets);
  const [activeVariant, setActiveVariant] = useThemeVariant();
  const { saveThemePreset, deleteThemePreset } = useThemePresetActions();

  const editing = useMemo(
    () => findPreset(presets, activeVariant) ?? null,
    [presets, activeVariant]
  );

  const takenIds = useMemo(
    () => new Set<string>([DEFAULT_THEME_VARIANT, ...presets.map((p) => p.id)]),
    [presets]
  );

  const isModified = (id: string) => customPresets.some((p) => p.id === id);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => ({
    [THEME_TOKEN_GROUPS[0].id]: true,
  }));

  const updateToken = (def: ThemeTokenDef, hex: string) => {
    if (!editing) return;
    saveThemePreset({
      ...editing,
      tokens: { ...editing.tokens, [def.cssVar]: tokenFromHex(def, hex) },
    });
  };

  const createFrom = (base: ThemePreset) => {
    const created = clonePreset(
      base,
      t('settings.general.themeEditor.copyName', {
        name: base.name,
        defaultValue: '{{name}} copy',
      }),
      takenIds
    );
    saveThemePreset(created);
    setActiveVariant(created.id);
  };

  const handleRemove = async (preset: ThemePreset) => {
    const builtIn = preset.builtIn;
    const result = await ConfirmDialog.show({
      title: builtIn
        ? t('settings.general.themeEditor.resetConfirm.title')
        : t('settings.general.themeEditor.deleteConfirm.title'),
      message: builtIn
        ? t('settings.general.themeEditor.resetConfirm.message', {
            name: preset.name,
          })
        : t('settings.general.themeEditor.deleteConfirm.message', {
            name: preset.name,
          }),
      confirmText: builtIn
        ? t('settings.general.themeEditor.reset')
        : t('settings.general.themeEditor.delete'),
      variant: builtIn ? 'default' : 'destructive',
    });
    if (result !== 'confirmed') return;
    deleteThemePreset(preset.id);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) modal.hide();
  };

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border p-4">
          <DialogTitle>{t('settings.general.themeEditor.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.general.themeEditor.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Preset list */}
          <div className="flex w-52 shrink-0 flex-col border-r border-border">
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
              <button
                type="button"
                onClick={() => setActiveVariant(DEFAULT_THEME_VARIANT)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  activeVariant === DEFAULT_THEME_VARIANT
                    ? 'bg-brand/10 text-brand'
                    : 'text-normal hover:bg-secondary'
                )}
              >
                <span className="truncate">
                  {t('settings.general.appearance.themeVariant.default')}
                </span>
              </button>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveVariant(p.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                    activeVariant === p.id
                      ? 'bg-brand/10 text-brand'
                      : 'text-normal hover:bg-secondary'
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  <PresetBadge
                    kind={
                      p.builtIn
                        ? isModified(p.id)
                          ? 'modified'
                          : 'builtin'
                        : 'custom'
                    }
                  />
                </button>
              ))}
            </div>
            <div className="border-t border-border p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center gap-1"
                onClick={() => createFrom(editing ?? BUILTIN_PRESETS[0])}
              >
                <PlusIcon className="size-4" weight="bold" />
                {t('settings.general.themeEditor.newPreset')}
              </Button>
            </div>
          </div>

          {/* Editor */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {editing ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-normal">
                    {t('settings.general.themeEditor.name')}
                  </label>
                  <Input
                    value={editing.name}
                    onChange={(e) =>
                      saveThemePreset({
                        ...editing,
                        name: e.target.value.slice(0, 60),
                      })
                    }
                  />
                </div>

                <div className="flex flex-wrap items-end gap-6">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-normal">
                      {t('settings.general.themeEditor.colorScheme')}
                    </label>
                    <div className="flex gap-1">
                      {(['dark', 'light'] as const).map((scheme) => (
                        <button
                          key={scheme}
                          type="button"
                          onClick={() =>
                            saveThemePreset({ ...editing, colorScheme: scheme })
                          }
                          className={cn(
                            'rounded-sm border px-3 py-1 text-sm',
                            editing.colorScheme === scheme
                              ? 'border-brand bg-brand/10 text-brand'
                              : 'border-border text-normal hover:bg-secondary'
                          )}
                        >
                          {t(`settings.general.themeEditor.scheme.${scheme}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-center gap-2 pb-1 text-sm text-normal">
                    <Checkbox
                      checked={editing.mono}
                      onCheckedChange={(checked) =>
                        saveThemePreset({ ...editing, mono: checked })
                      }
                    />
                    {t('settings.general.themeEditor.mono')}
                  </label>
                </div>

                <div className="space-y-2">
                  {THEME_TOKEN_GROUPS.map((group) => {
                    const open = openGroups[group.id] ?? false;
                    return (
                      <div
                        key={group.id}
                        className="overflow-hidden rounded-sm border border-border"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setOpenGroups((g) => ({ ...g, [group.id]: !open }))
                          }
                          className="flex w-full items-center justify-between bg-secondary/50 px-3 py-2 text-sm font-medium text-high"
                        >
                          <span>
                            {t(
                              `settings.general.themeEditor.groups.${group.id}`
                            )}
                          </span>
                          {open ? (
                            <CaretDownIcon className="size-4 text-low" />
                          ) : (
                            <CaretRightIcon className="size-4 text-low" />
                          )}
                        </button>
                        {open && (
                          <div className="border-t border-border px-3 py-2">
                            {group.tokens.map((def) => (
                              <TokenRow
                                key={def.cssVar}
                                def={def}
                                value={
                                  editing.tokens[def.cssVar] ??
                                  defaultTokenValue(def.cssVar)
                                }
                                onChange={(hex) => updateToken(def, hex)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="pt-1">
                  {editing.builtIn ? (
                    isModified(editing.id) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => handleRemove(editing)}
                      >
                        <ArrowCounterClockwiseIcon className="size-4" />
                        {t('settings.general.themeEditor.reset')}
                      </Button>
                    )
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 border-error/50 text-error hover:bg-error/10"
                      onClick={() => handleRemove(editing)}
                    >
                      <TrashIcon className="size-4" />
                      {t('settings.general.themeEditor.delete')}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="max-w-xs text-sm text-low">
                  {t('settings.general.themeEditor.defaultHint')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => createFrom(BUILTIN_PRESETS[0])}
                >
                  <PlusIcon className="size-4" weight="bold" />
                  {t('settings.general.themeEditor.newPreset')}
                </Button>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-border p-4">
          {/* type="submit" so the dialog's Enter handler resolves to this
              (Close) button rather than falling back to the first button in the
              body — see the KeyboardDialog i18n fallback caveat. */}
          <Button type="submit" onClick={() => modal.hide()}>
            {t('common:buttons.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const ThemeVariantEditorDialog = defineModal<void, void>(
  ThemeVariantEditorDialogImpl
);
