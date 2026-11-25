import { useId, useRef, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { fuzzySearchMatchAny } from '../lib/search';
import { DropdownMenuSearchInput } from './Dropdown';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from './Accordion';
import { ModelProviderIcon } from './ModelProviderIcon';
import {
  ModelDefaultOption,
  ModelList,
  type ModelListModel,
} from './ModelList';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Switch } from './Switch';

interface ModelSelectorProvider {
  id: string;
  name: string;
}

interface ModelSelectorConfigLike {
  models: ModelListModel[];
  providers: ModelSelectorProvider[];
}

export interface ModelSelectorPopoverProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  config: ModelSelectorConfigLike;
  error?: string | null;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedReasoningId: string | null;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onModelSelect: (id: string, providerId?: string) => void;
  onReasoningSelect: (reasoningId: string | null) => void;
  recentModelEntries?: string[];
  groupByProvider: boolean;
  onGroupByProviderChange: (checked: boolean) => void;
  showDefaultOption?: boolean;
  onSelectDefault?: () => void;
  expandedProviderId?: string;
  onExpandedProviderIdChange?: (id: string) => void;
  resolvedTheme?: 'light' | 'dark';
  onSelectionComplete?: () => void;
}

const MODEL_LIST_PAGE_SIZE = 8;

function getOptions(popover: HTMLElement) {
  // Radix keeps closing accordion contents mounted during the exit animation.
  return Array.from(
    popover.querySelectorAll<HTMLButtonElement>(
      '[data-model-selector-option]:not(:disabled, [data-model-selector-provider-content][data-state="closed"] *)'
    )
  );
}

function getModelKey(model: ModelListModel): string {
  return model.provider_id ? `${model.provider_id}/${model.id}` : model.id;
}

function getModelSortLabel(model: ModelListModel): string {
  return model.name || model.id;
}

function sortModelsAlphabetically(models: ModelListModel[]): ModelListModel[] {
  return [...models].sort((a, b) => {
    const labelComparison = getModelSortLabel(a).localeCompare(
      getModelSortLabel(b),
      undefined,
      {
        numeric: true,
        sensitivity: 'base',
      }
    );
    if (labelComparison !== 0) return labelComparison;

    return getModelKey(a).localeCompare(getModelKey(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function getSelectedModel(
  models: ModelListModel[],
  selectedProviderId: string | null,
  selectedModelId: string | null
): ModelListModel | null {
  if (!selectedModelId) return null;
  const selectedId = selectedModelId.toLowerCase();
  if (selectedProviderId) {
    const providerId = selectedProviderId.toLowerCase();
    return (
      models.find(
        (model) =>
          model.id.toLowerCase() === selectedId &&
          model.provider_id?.toLowerCase() === providerId
      ) ?? null
    );
  }
  return models.find((model) => model.id.toLowerCase() === selectedId) ?? null;
}

function getPopoverWidth(hasProviders: boolean, hasReasoning: boolean): string {
  if (hasProviders) return 'w-[280px]';
  if (hasReasoning) return 'w-[230px]';
  return 'w-[200px]';
}

function matchesSearch(model: ModelListModel, query: string): boolean {
  return fuzzySearchMatchAny([model.name, model.id], query);
}

interface ProviderAccordionProps {
  config: ModelSelectorConfigLike;
  selectedModel: ModelListModel | null;
  selectedReasoningId: string | null;
  searchQuery: string;
  onModelSelect: (id: string, providerId?: string) => void;
  onReasoningSelect: (reasoningId: string | null) => void;
  showDefaultOption?: boolean;
  isDefaultSelected: boolean;
  onSelectDefault?: () => void;
  expandedProviderId: string;
  onExpandedProviderIdChange: (id: string) => void;
  resolvedTheme: 'light' | 'dark';
  onSelectionComplete?: () => void;
}

function ProviderAccordion({
  config,
  selectedModel,
  selectedReasoningId,
  searchQuery,
  onModelSelect,
  onReasoningSelect,
  showDefaultOption = false,
  isDefaultSelected,
  onSelectDefault,
  expandedProviderId,
  onExpandedProviderIdChange,
  resolvedTheme,
  onSelectionComplete,
}: ProviderAccordionProps) {
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const modelsByProvider = new Map<string, ModelListModel[]>();
  for (const model of config.models) {
    if (!model.provider_id) continue;
    const list = modelsByProvider.get(model.provider_id) ?? [];
    list.push(model);
    modelsByProvider.set(model.provider_id, list);
  }

  const providers = config.providers;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="flex flex-col py-half">
        <Accordion
          type="single"
          collapsible
          value={expandedProviderId}
          onValueChange={onExpandedProviderIdChange}
        >
          {providers.map((provider) => {
            const providerModels = sortModelsAlphabetically(
              modelsByProvider.get(provider.id) ?? []
            );
            if (
              normalizedSearch &&
              !providerModels.some((model) =>
                matchesSearch(model, normalizedSearch)
              )
            ) {
              return null;
            }

            return (
              <AccordionItem key={provider.id} value={provider.id}>
                <AccordionTrigger
                  data-model-selector-option
                  sticky={provider.id === expandedProviderId}
                  className={cn(
                    'group gap-2 px-base py-half rounded-sm',
                    'text-sm font-medium text-low',
                    'hover:bg-secondary/60 transition-colors'
                  )}
                >
                  <ModelProviderIcon
                    providerId={provider.id}
                    theme={resolvedTheme}
                  />
                  <span className="flex-1 text-left truncate">
                    {provider.name}
                  </span>
                  <CaretDownIcon
                    className={cn(
                      'size-icon-2xs text-low transition-transform',
                      'group-data-[state=open]:rotate-180'
                    )}
                    weight="bold"
                  />
                </AccordionTrigger>
                <AccordionContent data-model-selector-provider-content>
                  <div className="pl-1">
                    <ModelList
                      models={providerModels}
                      selectedModel={selectedModel}
                      searchQuery={searchQuery}
                      onSelect={onModelSelect}
                      selectedReasoningId={selectedReasoningId}
                      onReasoningSelect={onReasoningSelect}
                      onSelectionComplete={onSelectionComplete}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
        {showDefaultOption && (
          <ModelDefaultOption
            selected={isDefaultSelected}
            onSelect={onSelectDefault}
            onSelectionComplete={onSelectionComplete}
          />
        )}
      </div>
    </div>
  );
}

export function ModelSelectorPopover({
  isOpen,
  onOpenChange,
  trigger,
  config,
  error,
  selectedProviderId,
  selectedModelId,
  selectedReasoningId,
  searchQuery,
  onSearchChange,
  onModelSelect,
  onReasoningSelect,
  groupByProvider,
  onGroupByProviderChange,
  showDefaultOption = false,
  onSelectDefault,
  expandedProviderId = '',
  onExpandedProviderIdChange,
  resolvedTheme = 'light',
  onSelectionComplete,
}: ModelSelectorPopoverProps) {
  const { t } = useTranslation('common');
  const labelId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const models = config.models;
  const selectedModel = getSelectedModel(
    models,
    selectedProviderId,
    selectedModelId
  );
  const isDefaultSelected = selectedModelId === null;
  // Only providers that still have models (after hidden-model filtering) get a
  // group; with a single such provider the flat list is shown instead.
  const providers = config.providers.filter((provider) =>
    models.some((model) => model.provider_id === provider.id)
  );
  const hasProviders = providers.length > 1;
  const showGroups = hasProviders && groupByProvider;
  const hasReasoning = models.some(
    (model) => model.reasoning_options.length > 0
  );
  const popoverWidth = getPopoverWidth(hasProviders, hasReasoning);
  const popoverRef = useRef<HTMLDivElement>(null);
  const showSearch = hasProviders || models.length > MODEL_LIST_PAGE_SIZE;
  let content: ReactElement;

  if (showGroups) {
    content = (
      <ProviderAccordion
        config={{ ...config, providers }}
        selectedModel={selectedModel}
        selectedReasoningId={selectedReasoningId}
        searchQuery={searchQuery}
        onModelSelect={onModelSelect}
        onReasoningSelect={onReasoningSelect}
        showDefaultOption={showDefaultOption}
        isDefaultSelected={isDefaultSelected}
        onSelectDefault={onSelectDefault}
        expandedProviderId={expandedProviderId}
        onExpandedProviderIdChange={onExpandedProviderIdChange ?? (() => {})}
        resolvedTheme={resolvedTheme}
        onSelectionComplete={onSelectionComplete}
      />
    );
  } else {
    const sortedModels = sortModelsAlphabetically(models);

    content = (
      <ModelList
        models={sortedModels}
        selectedModel={selectedModel}
        providerNames={
          hasProviders
            ? new Map(providers.map(({ id, name }) => [id, name]))
            : undefined
        }
        searchQuery={searchQuery}
        onSelect={onModelSelect}
        selectedReasoningId={selectedReasoningId}
        onReasoningSelect={onReasoningSelect}
        justifyEnd
        className="max-h-[233px]"
        showDefaultOption={showDefaultOption}
        isDefaultSelected={isDefaultSelected}
        onSelectDefault={onSelectDefault}
        onSelectionComplete={onSelectionComplete}
      />
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger
        asChild
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || isOpen) return;
          event.preventDefault();
          onOpenChange(true);
        }}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        ref={popoverRef}
        align="start"
        sideOffset={8}
        aria-labelledby={labelId}
        data-model-selector-popover
        className={cn(
          '!p-0 flex flex-col',
          'max-h-[var(--radix-popover-content-available-height)]',
          popoverWidth,
          showGroups && 'h-[280px]'
        )}
        onOpenAutoFocus={(event) => {
          if (!popoverRef.current) return;
          const options = getOptions(popoverRef.current);
          const option =
            options.find((item) => item.dataset.selected === 'true') ??
            options[0];
          if (!option) return;
          event.preventDefault();
          option.focus();
        }}
        onKeyDownCapture={(event) => {
          const { key, target, currentTarget } = event;
          if (
            (key !== 'ArrowDown' && key !== 'ArrowUp') ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const options = getOptions(currentTarget);
          const index = options.findIndex((item) => item === target);
          if (index === -1 && target !== searchRef.current) return;
          const offset = key === 'ArrowDown' ? 1 : -1;
          const nextIndex =
            index === -1
              ? offset === 1
                ? 0
                : options.length - 1
              : (index + offset + options.length) % options.length;
          const next = options[nextIndex];
          if (!next) return;
          event.preventDefault();
          event.stopPropagation();
          next.focus();
        }}
        onInteractOutside={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-model-selector-dropdown]')) {
            event.preventDefault();
          }
        }}
      >
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          {error && (
            <div className="px-base py-half bg-red-500/10 border-b border-red-500/20">
              <span className="text-sm text-red-600">{error}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-base px-base py-half">
            <span id={labelId} className="text-sm font-semibold text-low">
              {t('modelSelector.model')}
            </span>
            {hasProviders && (
              <label className="flex cursor-pointer items-center gap-half text-sm text-low">
                {t('modelSelector.groupByProvider')}
                <Switch
                  checked={groupByProvider}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      onExpandedProviderIdChange?.(
                        selectedModel?.provider_id ?? ''
                      );
                    }
                    onGroupByProviderChange(checked);
                  }}
                />
              </label>
            )}
          </div>
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {content}
            {showSearch && (
              <div className="border-t border-border">
                <DropdownMenuSearchInput
                  ref={searchRef}
                  autoFocus={false}
                  aria-label={t('modelSelector.filterModels')}
                  placeholder={t('modelSelector.filterModels')}
                  value={searchQuery}
                  onValueChange={onSearchChange}
                />
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
