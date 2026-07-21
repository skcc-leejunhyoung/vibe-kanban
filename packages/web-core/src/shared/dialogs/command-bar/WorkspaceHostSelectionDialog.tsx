import { create, useModal } from '@ebay/nice-modal-react';
import { ComputerTowerIcon, DesktopIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vibe/ui/components/Command';
import { defineModal, type NoProps } from '@/shared/lib/modals';
import { useWorkspaceHostOptions } from '@/shared/hooks/useWorkspaceHostOptions';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';

export type WorkspaceHostSelection = string | null;

const WorkspaceHostSelectionDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const { t } = useTranslation('common');
  const runtime = useAppRuntime();
  const { hosts } = useWorkspaceHostOptions();
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
      <Command>
        <CommandInput
          placeholder={t('workspaces.searchHosts', 'Search hosts...')}
        />
        <CommandList>
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
              <CommandItem key={host.id} onSelect={() => select(host.id)}>
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
