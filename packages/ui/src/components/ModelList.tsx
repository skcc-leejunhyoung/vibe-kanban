import { useTranslation } from 'react-i18next';
import { BrainIcon, CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { fuzzySearchMatchAny } from '../lib/search';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './Dropdown';

export interface ModelReasoningOption {
  id: string;
  label: string;
  is_default?: boolean;
}

export interface ModelListModel {
  id: string;
  name: string;
  provider_id?: string | null;
  reasoning_options: ModelReasoningOption[];
}

function toPrettyCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getReasoningLabel(
  options: ModelReasoningOption[],
  selectedId: string | null
): string | null {
  if (!selectedId) return null;
  return (
    options.find((option) => option.id === selectedId)?.label ??
    toPrettyCase(selectedId)
  );
}

function getModelKey(model: ModelListModel): string {
  return model.provider_id ? `${model.provider_id}/${model.id}` : model.id;
}

interface ReasoningDropdownProps {
  options: ModelReasoningOption[];
  selectedId: string | null;
  onSelect: (reasoningId: string | null) => void;
  onSelectionComplete?: () => void;
}

function ReasoningDropdown({
  options,
  selectedId,
  onSelect,
  onSelectionComplete,
}: ReasoningDropdownProps) {
  const { t } = useTranslation('common');
  if (!options.length) return null;

  const selectedLabel =
    getReasoningLabel(options, selectedId) ?? t('modelSelector.default');
  const isDefaultSelected = selectedId === null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-model-selector-reasoning-trigger
          className={cn(
            'inline-flex items-center gap-1 rounded-sm border border-border',
            'bg-secondary/60 px-1.5 py-0.5 text-[10px] font-semibold text-low',
            'hover:border-brand/40 hover:text-normal transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-brand'
          )}
        >
          <BrainIcon className="size-icon-xs" weight="fill" />
          <span className="truncate max-w-[90px]">{selectedLabel}</span>
          <CaretDownIcon className="size-icon-2xs" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        data-model-selector-dropdown
        className="min-w-[160px]"
      >
        <DropdownMenuItem
          icon={isDefaultSelected ? CheckIcon : undefined}
          onClick={() => {
            onSelect(null);
            onSelectionComplete?.();
          }}
        >
          {t('modelSelector.default')}
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            icon={option.id === selectedId ? CheckIcon : undefined}
            onClick={() => {
              onSelect(option.id);
              onSelectionComplete?.();
            }}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ModelListProps {
  models: ModelListModel[];
  selectedModel: ModelListModel | null;
  providerNames?: ReadonlyMap<string, string>;
  searchQuery: string;
  onSelect: (id: string, providerId?: string) => void;
  selectedReasoningId: string | null;
  onReasoningSelect: (reasoningId: string | null) => void;
  justifyEnd?: boolean;
  className?: string;
  showDefaultOption?: boolean;
  isDefaultSelected?: boolean;
  onSelectDefault?: () => void;
  onSelectionComplete?: () => void;
}

export function ModelDefaultOption({
  selected,
  onSelect,
  onSelectionComplete,
}: {
  selected: boolean;
  onSelect?: () => void;
  onSelectionComplete?: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      data-model-selector-option
      data-selected={selected || undefined}
      onClick={(event) => {
        onSelect?.();
        if (event.detail === 0) onSelectionComplete?.();
      }}
      className={cn(
        'mx-half rounded-sm py-half px-base text-left text-sm truncate',
        'transition-colors duration-100 focus:bg-secondary',
        selected
          ? 'bg-secondary text-high font-semibold'
          : 'text-normal hover:bg-secondary/60'
      )}
    >
      {t('modelSelector.default')}
    </button>
  );
}

export function ModelList({
  models,
  selectedModel,
  providerNames,
  searchQuery,
  onSelect,
  selectedReasoningId,
  onReasoningSelect,
  justifyEnd = false,
  className,
  showDefaultOption = false,
  isDefaultSelected = false,
  onSelectDefault,
  onSelectionComplete,
}: ModelListProps) {
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredModels = normalizedSearch
    ? models.filter((model) => {
        return fuzzySearchMatchAny([model.name, model.id], normalizedSearch);
      })
    : models;

  const showEmptyState = filteredModels.length === 0 && !showDefaultOption;

  return (
    <div
      className={cn(
        'flex-1 min-h-0 overflow-y-auto overflow-x-hidden',
        className
      )}
    >
      {showEmptyState ? (
        <div className="flex h-full items-center justify-center px-base text-sm text-low">
          {normalizedSearch ? 'No matches.' : 'No models available.'}
        </div>
      ) : (
        <div
          className={cn(
            'flex min-h-full flex-col',
            justifyEnd && 'justify-end'
          )}
        >
          {filteredModels.map((model) => {
            const modelKey = getModelKey(model);
            const isSelected = model === selectedModel;
            const isReasoningConfigurable = model.reasoning_options.length > 0;
            const showReasoningSelector = isSelected && isReasoningConfigurable;
            const providerName = model.provider_id
              ? (providerNames?.get(model.provider_id) ??
                (providerNames ? model.provider_id : undefined))
              : undefined;

            return (
              <div
                key={`${model.provider_id ?? 'default'}/${model.id}`}
                data-model-key={modelKey}
                data-model-id={model.id}
                data-provider-id={model.provider_id ?? ''}
                className={cn(
                  'group flex items-center rounded-sm mx-half',
                  'transition-colors duration-100',
                  'focus-within:bg-secondary',
                  isSelected
                    ? 'bg-secondary text-high'
                    : cn('text-normal', 'hover:bg-secondary/60')
                )}
              >
                <button
                  type="button"
                  data-model-selector-option
                  data-selected={isSelected || undefined}
                  onClick={() =>
                    onSelect(model.id, model.provider_id ?? undefined)
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key !== 'Enter' ||
                      event.nativeEvent.isComposing
                    ) {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(model.id, model.provider_id ?? undefined);
                    if (!isReasoningConfigurable) {
                      onSelectionComplete?.();
                      return;
                    }

                    const popover = event.currentTarget.closest(
                      '[data-model-selector-popover]'
                    );
                    const focusReasoningTrigger = (attempt = 0) => {
                      const modelKeySelector = CSS.escape(modelKey);
                      const trigger = popover?.querySelector<HTMLButtonElement>(
                        `[data-model-key="${modelKeySelector}"] ` +
                          '[data-model-selector-reasoning-trigger]'
                      );
                      if (trigger) {
                        trigger.focus();
                      } else if (attempt < 2) {
                        requestAnimationFrame(() =>
                          focusReasoningTrigger(attempt + 1)
                        );
                      }
                    };
                    requestAnimationFrame(() => focusReasoningTrigger());
                  }}
                  className="flex-1 min-w-0 rounded-sm py-half pl-base pr-half text-left scroll-mt-8"
                >
                  <span
                    className={cn(
                      'block text-sm truncate',
                      isSelected && 'font-semibold'
                    )}
                    title={model.name}
                  >
                    {model.name}
                  </span>
                  {providerName && (
                    <span className="block truncate text-xs text-low">
                      {providerName}
                    </span>
                  )}
                </button>
                <div className="flex items-center justify-end gap-half pr-base">
                  {showReasoningSelector && (
                    <ReasoningDropdown
                      options={model.reasoning_options}
                      selectedId={selectedReasoningId}
                      onSelect={onReasoningSelect}
                      onSelectionComplete={onSelectionComplete}
                    />
                  )}
                  {!showReasoningSelector && isReasoningConfigurable ? (
                    <span
                      className={cn(
                        'inline-flex items-center justify-center',
                        'size-5 rounded-sm bg-border/80 text-normal',
                        'dark:bg-secondary/70'
                      )}
                      title="Reasoning supported"
                    >
                      <BrainIcon className="size-icon-xs" weight="fill" />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {showDefaultOption && (
            <ModelDefaultOption
              selected={isDefaultSelected}
              onSelect={onSelectDefault}
              onSelectionComplete={onSelectionComplete}
            />
          )}
        </div>
      )}
    </div>
  );
}
