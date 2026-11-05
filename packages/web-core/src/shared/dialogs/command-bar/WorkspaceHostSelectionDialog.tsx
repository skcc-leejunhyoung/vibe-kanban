import { create, useModal } from '@ebay/nice-modal-react';
import { useState } from 'react';
import { ComputerTowerIcon, DesktopIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vibe/ui/components/Command';
import { defineModal, type NoProps } from '@/shared/lib/modals';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { LoginRequiredPrompt } from '@/shared/dialogs/shared/LoginRequiredPrompt';
import { getAuthErrorKind } from '@/shared/lib/auth/errors';

export type WorkspaceHostSelection = string | null;

const WorkspaceHostSelectionDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const { t } = useTranslation('common');
  const runtime = useAppRuntime();
  const { hosts, error, partialError, isLoading, isRefreshing, retry } =
    useWorkspaceHostOptions();
  const [search, setSearch] = useState('');
  const remoteHosts = hosts.filter((host) => host.status === 'online');

  const select = (hostId: WorkspaceHostSelection) => {
    modal.resolve(hostId);
    modal.hide();
  };

  return (
    <CommandDialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) {
          modal.resolve(undefined);
          modal.hide();
        }
      }}
    >
      {error && getAuthErrorKind(error) === 'required' ? (
        <LoginRequiredPrompt className="m-base" />
      ) : error || partialError ? (
        <div
          className="flex items-center gap-base p-base text-normal"
          role="alert"
        >
          <span>
            {error
              ? getAuthErrorKind(error) === 'forbidden'
                ? t('hostSelection.forbidden')
                : t('hostSelection.unavailable')
              : t('hostSelection.pairingUnavailable')}
          </span>
          <PrimaryButton disabled={isRefreshing} onClick={retry}>
            {t('buttons.retry')}
          </PrimaryButton>
        </div>
      ) : null}
      {isLoading && !error && (
        <p className="p-base text-low" role="status">
          {t('states.loading')}
        </p>
      )}
      {!isLoading && !error && !partialError && remoteHosts.length === 0 && (
        <p className="p-base text-low" role="status">
          {hosts.length
            ? t('hostSelection.noOnline')
            : t('hostSelection.noHosts')}
        </p>
      )}
      <Command>
        <CommandInput
          placeholder={t('workspaces.searchHosts', 'Search hosts...')}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          {search.trim() && (
            <CommandEmpty>{t('hostSelection.noMatches')}</CommandEmpty>
          )}
          <CommandGroup
            heading={t('workspaces.selectHost', 'Create workspace on')}
          >
            {runtime === 'local' && (
              <CommandItem onSelect={() => select(null)}>
                <DesktopIcon className="h-4 w-4" />
                <span>
                  {t('settings.hostPicker.thisMachine', 'This machine')}
                </span>
              </CommandItem>
            )}
            {remoteHosts.map((host) => (
              <CommandItem
                key={host.id}
                disabled={Boolean(error)}
                onSelect={() => {
                  if (!error) select(host.id);
                }}
              >
                <ComputerTowerIcon className="h-4 w-4" />
                <span>{host.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
});

export const WorkspaceHostSelectionDialog = defineModal<
  void,
  WorkspaceHostSelection | undefined
>(WorkspaceHostSelectionDialogImpl);

export async function selectWorkspaceHost(): Promise<
  WorkspaceHostSelection | undefined
> {
  return WorkspaceHostSelectionDialog.show();
}
