import { type ReactNode, useRef } from 'react';
import { CheckIcon, PaperclipIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from './Checkbox';
import { ChatBoxBase, VisualVariant, type DropzoneProps } from './ChatBoxBase';
import { DropdownMenuItem, DropdownMenuLabel } from './Dropdown';
import { PrimaryButton } from './PrimaryButton';
import type { LocalAttachmentMetadata } from './WorkspaceContext';
import { ToolbarDropdown, ToolbarIconButton } from './Toolbar';

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ModelSelectorProps<TExecutorConfig = unknown> {
  onAdvancedSettings: () => void;
  presets: string[];
  selectedPreset: string | null;
  onPresetSelect: (presetId: string | null) => void;
  onOverrideChange: (partial: Partial<TExecutorConfig>) => void;
  executorConfig: TExecutorConfig | null;
  presetOptions: TExecutorConfig | null | undefined;
}

export interface ExecutorProps<TExecutor extends string = string> {
  selected: TExecutor | null;
  options: TExecutor[];
  onChange: (executor: TExecutor) => void;
}

export interface SaveAsDefaultProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  visible: boolean;
}

export interface LinkedIssueBadgeProps {
  simpleId: string;
  title: string;
  onRemove: () => void;
}

export interface CreateChatBoxEditorRenderProps<
  TExecutor extends string = string,
> {
  value: string;
  onChange: (value: string) => void;
  onCmdEnter: () => void;
  disabled: boolean;
  repoIds?: string[];
  repoId?: string;
  executor: TExecutor | null;
  onPasteFiles?: (files: File[]) => void;
  localAttachments?: LocalAttachmentMetadata[];
}

interface CreateChatBoxProps<TExecutor extends string = string> {
  editor: EditorProps;
  renderEditor: (props: CreateChatBoxEditorRenderProps<TExecutor>) => ReactNode;
  agentIcon?: ReactNode;
  onSend: () => void;
  isSending: boolean;
  secondaryAction?: {
    value: string;
    pendingValue: string;
    onClick: () => void;
    disabled?: boolean;
    isPending?: boolean;
  };
  disabled?: boolean;
  executor: ExecutorProps<TExecutor>;
  formatExecutorLabel?: (executor: TExecutor) => string;
  emptyExecutorLabel?: string;
  saveAsDefault?: SaveAsDefaultProps;
  error?: string | null;
  repoIds?: string[];
  repoId?: string;
  modelSelector?: ReactNode;
  onPasteFiles?: (files: File[]) => void;
  localAttachments?: LocalAttachmentMetadata[];
  dropzone?: DropzoneProps;
  onEditRepos: () => void;
  repoSummaryLabel: string;
  repoSummaryTitle: string;
  linkedIssue?: LinkedIssueBadgeProps | null;
  /** Hide the attach-file control (e.g. quick chat, which has no attachments). */
  showAttachments?: boolean;
  /** Override the primary button label (defaults to "Create"/"Creating"). */
  sendLabel?: string;
  sendingLabel?: string;
  /**
   * Fill the available height and let the editor shrink (with internal scroll)
   * so the footer/action buttons stay visible on short viewports instead of
   * being pushed off-screen. Requires a height-bounded parent.
   */
  fillHeight?: boolean;
}

/**
 * Lightweight chat box for create mode.
 * Supports sending and attachments - no queue, stop, or feedback functionality.
 */
function defaultExecutorLabel(executor: string) {
  return executor
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function CreateChatBox<TExecutor extends string = string>({
  editor,
  renderEditor,
  agentIcon,
  onSend,
  isSending,
  secondaryAction,
  disabled = false,
  executor,
  formatExecutorLabel = defaultExecutorLabel,
  emptyExecutorLabel = 'Select Executor',
  saveAsDefault,
  error,
  repoIds,
  repoId,
  modelSelector,
  onPasteFiles,
  localAttachments,
  dropzone,
  onEditRepos,
  repoSummaryLabel,
  repoSummaryTitle,
  linkedIssue,
  showAttachments = true,
  sendLabel,
  sendingLabel,
  fillHeight = false,
}: CreateChatBoxProps<TExecutor>) {
  const { t } = useTranslation(['common', 'tasks']);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSecondaryPending = secondaryAction?.isPending ?? false;
  const isDisabled = disabled || isSending || isSecondaryPending;
  const canSend = editor.value.trim().length > 0 && !isDisabled;

  const handleCmdEnter = () => {
    if (canSend) {
      onSend();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key !== 'Enter' ||
      !(e.metaKey || e.ctrlKey) ||
      e.shiftKey ||
      e.defaultPrevented
    ) {
      return;
    }

    e.preventDefault();
    handleCmdEnter();
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0 && onPasteFiles) {
      onPasteFiles(files);
    }
    e.target.value = '';
  };

  const executorLabel = executor.selected
    ? formatExecutorLabel(executor.selected)
    : emptyExecutorLabel;

  return (
    <ChatBoxBase
      fillHeight={fillHeight}
      onKeyDown={handleKeyDown}
      editor={renderEditor({
        value: editor.value,
        onChange: editor.onChange,
        onCmdEnter: handleCmdEnter,
        disabled: isDisabled,
        repoIds,
        repoId,
        executor: executor.selected ?? null,
        onPasteFiles,
        localAttachments,
      })}
      error={error}
      visualVariant={VisualVariant.NORMAL}
      dropzone={dropzone}
      modelSelector={modelSelector}
      headerLeft={
        <>
          {agentIcon}
          <ToolbarDropdown label={executorLabel} disabled={isDisabled}>
            <DropdownMenuLabel>
              {t('tasks:conversation.executors')}
            </DropdownMenuLabel>
            {executor.options.map((exec) => (
              <DropdownMenuItem
                key={exec}
                icon={executor.selected === exec ? CheckIcon : undefined}
                onClick={() => executor.onChange(exec)}
              >
                {formatExecutorLabel(exec)}
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
          {saveAsDefault?.visible && (
            <label className="flex items-center gap-1.5 text-sm text-low cursor-pointer ml-2">
              <Checkbox
                checked={saveAsDefault.checked}
                onCheckedChange={saveAsDefault.onChange}
                className="h-3.5 w-3.5"
                disabled={isDisabled}
              />
              <span>{t('tasks:conversation.saveAsDefault')}</span>
            </label>
          )}
        </>
      }
      footerLeft={
        <>
          {showAttachments && (
            <>
              <ToolbarIconButton
                icon={PaperclipIcon}
                aria-label={t('tasks:taskFormDialog.attachFile')}
                title={t('tasks:taskFormDialog.attachFile')}
                onClick={handleAttachClick}
                disabled={isDisabled}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
            </>
          )}
          <button
            type="button"
            onClick={onEditRepos}
            title={repoSummaryTitle}
            disabled={isDisabled}
            className="max-w-[320px] truncate text-sm text-normal hover:text-high disabled:cursor-not-allowed disabled:opacity-50"
          >
            {repoSummaryLabel}
          </button>
          {linkedIssue && (
            <>
              <div
                className="inline-flex items-center gap-half whitespace-nowrap text-sm text-low"
                title={linkedIssue.title}
              >
                <span className="font-mono text-xs text-normal">
                  {linkedIssue.simpleId}
                </span>
                <button
                  type="button"
                  onClick={linkedIssue.onRemove}
                  disabled={isDisabled}
                  className="inline-flex items-center text-low hover:text-error transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Remove link to ${linkedIssue.simpleId}`}
                >
                  <XIcon className="size-icon-xs" weight="bold" />
                </button>
              </div>
            </>
          )}
        </>
      }
      footerRight={
        <>
          {secondaryAction && (
            <PrimaryButton
              variant="tertiary"
              onClick={secondaryAction.onClick}
              disabled={isDisabled || secondaryAction.disabled}
              actionIcon={isSecondaryPending ? 'spinner' : undefined}
              value={
                isSecondaryPending
                  ? secondaryAction.pendingValue
                  : secondaryAction.value
              }
            />
          )}
          <PrimaryButton
            onClick={onSend}
            disabled={!canSend}
            actionIcon={isSending ? 'spinner' : undefined}
            value={
              isSending
                ? (sendingLabel ?? t('tasks:conversation.workspace.creating'))
                : (sendLabel ?? t('tasks:conversation.workspace.create'))
            }
          />
        </>
      }
    />
  );
}
