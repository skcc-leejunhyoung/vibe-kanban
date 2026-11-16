import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CaretLeftIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';

import { cn } from '@/shared/lib/utils';
import { SettingsSection } from './settings/SettingsSection';
import { SettingsSelect } from './settings/SettingsComponents';
import type {
  SettingsSectionType,
  SettingsSectionInitialState,
} from './settings/SettingsSection';
import {
  SETTINGS_SECTION_DEFINITIONS,
  isHostSpecificSettingsSection,
} from './settings/settingsRegistry';
import {
  focusIfVisible,
  nextSettingsSection,
} from './settings/settingsNavigation';
import {
  SettingsDirtyProvider,
  useSettingsDirty,
} from './settings/SettingsDirtyContext';
import {
  SettingsHostProvider,
  useSettingsHost,
  isRemoteSharedHostId,
} from './settings/SettingsHostContext';
import { SettingsMachineUserSystemProvider } from './settings/SettingsMachineUserSystemProvider';
import { SettingsRemoteUserSystemProvider } from './settings/SettingsRemoteUserSystemProvider';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { useModalKeyboardLayer } from '@vibe/ui/lib/modal-keyboard';
import { useDialogKeyboard } from '@vibe/ui/lib/dialog-keyboard';
import { DialogFocusScope } from '@vibe/ui/components/DialogFocusScope';

export interface SettingsDialogProps {
  initialSection?: SettingsSectionType;
  initialState?: SettingsSectionInitialState[SettingsSectionType];
  initialHostId?: string | 'local';
}

interface SettingsDialogContentProps {
  initialSection?: SettingsSectionType;
  initialState?: SettingsSectionInitialState[SettingsSectionType];
  onClose: () => void;
}

// Host settings sections that apply to the account-scoped "Remote" device.
// The others (repos, agents, mcp, automation) configure a specific machine's
// disk/processes, so they have no meaning without a backing host.
const REMOTE_SHARED_HOST_SECTIONS = new Set<SettingsSectionType>(['general']);

function isHostSectionAvailableForTarget(
  sectionId: SettingsSectionType,
  isRemoteShared: boolean
): boolean {
  if (!isHostSpecificSettingsSection(sectionId)) return true;
  return isRemoteShared ? REMOTE_SHARED_HOST_SECTIONS.has(sectionId) : true;
}

/**
 * What to say about a selected host that is not in the list: named after it
 * when it is known, and "unknown" rather than "gone" when the list itself
 * could not be loaded. Never "this machine": that is the local host's label.
 */
function useUnavailableHostText() {
  const { t } = useTranslation('settings');
  const { selectedHost, selectedHostUnavailable, hostListFailed } =
    useSettingsHost();
  const unavailableName = selectedHostUnavailable
    ? (selectedHost?.label ?? null)
    : null;
  const unavailableLabel = unavailableName
    ? t(
        hostListFailed
          ? 'settings.hostPicker.unconfirmedNamedHost'
          : 'settings.hostPicker.unavailableNamedHost',
        { name: unavailableName }
      )
    : t('settings.hostPicker.unavailableHost', 'Unavailable host');
  const unavailableHint = hostListFailed
    ? t('settings.hostPicker.hostListFailedHint')
    : unavailableName
      ? t('settings.hostPicker.unavailableNamedHostHint', {
          name: unavailableName,
        })
      : t('settings.hostPicker.unavailableHostHint');
  return { unavailableLabel, unavailableHint };
}

function SettingsDialogNavigation({
  activeSection,
  onSectionSelect,
}: {
  activeSection: SettingsSectionType;
  onSectionSelect: (sectionId: SettingsSectionType) => void;
}) {
  const { t } = useTranslation('settings');
  const {
    availableHosts,
    targetResolved,
    selectedHost,
    selectedHostId,
    selectedHostUnavailable,
    setSelectedHostId,
  } = useSettingsHost();
  const { isDirty } = useSettingsDirty();
  const isRemoteShared = isRemoteSharedHostId(selectedHostId);
  const { unavailableLabel, unavailableHint } = useUnavailableHostText();
  const hostSections = SETTINGS_SECTION_DEFINITIONS.filter(
    (section) =>
      section.group === 'host' &&
      isHostSectionAvailableForTarget(section.id, isRemoteShared)
  );
  const universalSections = SETTINGS_SECTION_DEFINITIONS.filter(
    (section) => section.group === 'universal'
  );
  const hostOptions = availableHosts.map((host) => ({
    value: host.id,
    label: host.status != null ? `${host.label} (${host.status})` : host.label,
  }));
  // A host that left the list stays the visible selection until the user
  // picks another; the picker must not name a host the form is not about.
  if (selectedHostUnavailable && selectedHostId) {
    hostOptions.push({
      value: selectedHostId,
      label: unavailableLabel,
    });
  }
  const hostSettingsDisabled = !targetResolved || !selectedHost;
  const sectionButtonRefs = useRef<Map<SettingsSectionType, HTMLButtonElement>>(
    new Map()
  );
  const hostHint = !targetResolved
    ? t('settings.general.loading')
    : selectedHostUnavailable
      ? unavailableHint
      : availableHosts.length === 0
        ? t('settings.hostPicker.pairMachineHint')
        : t('settings.hostPicker.selectMachineHint');

  const handlePairOtherMachines = () => {
    onSectionSelect('relay');
  };

  // Host sections are mounted per machine, so switching drops the open
  // section's draft instead of carrying it to the next host. Ask first.
  const isSwitchingRef = useRef(false);
  const handleHostChange = async (hostId: string) => {
    if (hostId === selectedHostId || isSwitchingRef.current) return;
    if (isDirty && isHostSpecificSettingsSection(activeSection)) {
      isSwitchingRef.current = true;
      try {
        const result = await ConfirmDialog.show({
          title: t('settings.unsavedChanges.title'),
          message: t(
            'settings.unsavedChanges.switchHostMessage',
            'You have unsaved changes for this machine. Switch machines and discard them?'
          ),
          confirmText: t('settings.unsavedChanges.discard'),
          cancelText: t('settings.unsavedChanges.cancel'),
          variant: 'destructive',
        });
        if (result !== 'confirmed') return;
      } finally {
        isSwitchingRef.current = false;
      }
    }
    setSelectedHostId(hostId);
  };

  const isSectionDisabled = useCallback(
    (sectionId: SettingsSectionType) => {
      if (!isHostSectionAvailableForTarget(sectionId, isRemoteShared)) {
        return true;
      }
      return isHostSpecificSettingsSection(sectionId) && hostSettingsDisabled;
    },
    [hostSettingsDisabled, isRemoteShared]
  );

  // Give the settings dialog an initial keyboard target when it was opened by
  // a shortcut. After that, the active section is the sole tab stop and arrow
  // keys move both the selection and focus through the sidebar.
  useEffect(() => {
    if (isSectionDisabled(activeSection)) return;
    focusIfVisible(sectionButtonRefs.current.get(activeSection));
  }, [activeSection, isSectionDisabled]);

  const handleSectionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sectionId: SettingsSectionType
  ) => {
    let nextSection: SettingsSectionType | undefined;

    switch (event.key) {
      case 'ArrowDown':
        nextSection = nextSettingsSection(
          SETTINGS_SECTION_DEFINITIONS.map((section) => section.id),
          sectionId,
          'next',
          isSectionDisabled
        );
        break;
      case 'ArrowUp':
        nextSection = nextSettingsSection(
          SETTINGS_SECTION_DEFINITIONS.map((section) => section.id),
          sectionId,
          'previous',
          isSectionDisabled
        );
        break;
      case 'Home':
        nextSection = SETTINGS_SECTION_DEFINITIONS.find(
          (section) => !isSectionDisabled(section.id)
        )?.id;
        break;
      case 'End':
        nextSection = [...SETTINGS_SECTION_DEFINITIONS]
          .reverse()
          .find((section) => !isSectionDisabled(section.id))?.id;
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextSection) onSectionSelect(nextSection);
  };

  const renderSectionButton = (sectionId: SettingsSectionType) => {
    const section = SETTINGS_SECTION_DEFINITIONS.find(
      (item) => item.id === sectionId
    );
    if (!section) return null;
    const Icon = section.icon;
    const isActive = activeSection === section.id;
    const isDisabled = isSectionDisabled(section.id);
    return (
      <button
        key={section.id}
        type="button"
        onClick={() => onSectionSelect(section.id)}
        onKeyDown={(event) => handleSectionKeyDown(event, section.id)}
        ref={(element) => {
          if (element) {
            sectionButtonRefs.current.set(section.id, element);
          } else {
            sectionButtonRefs.current.delete(section.id);
          }
        }}
        tabIndex={isActive && !isDisabled ? 0 : -1}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        className={cn(
          'flex items-center gap-3 text-left px-3 py-2 rounded-sm text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand',
          isDisabled
            ? 'text-low opacity-50 cursor-not-allowed'
            : isActive
              ? 'bg-brand/10 text-brand font-medium'
              : 'text-normal hover:bg-primary/10'
        )}
      >
        <Icon className="size-icon-sm shrink-0" weight="bold" />
        <span className="truncate">
          {t(`settings.layout.nav.${section.id}`)}
        </span>
      </button>
    );
  };

  return (
    <nav
      aria-label={t('settings.layout.nav.title')}
      className="flex-1 p-2 flex flex-col gap-4 overflow-y-auto"
    >
      <div className="space-y-2">
        <div className="px-3 pt-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-low">
            {t('settings.layout.nav.machineSettings')}
          </div>
        </div>
        <div className="px-2">
          <SettingsSelect
            value={selectedHostId ?? undefined}
            options={hostOptions}
            actions={[
              {
                label: t('settings.layout.nav.pairOtherMachines'),
                icon: PlusIcon,
                onClick: handlePairOtherMachines,
              },
            ]}
            onChange={(hostId) => void handleHostChange(hostId)}
            placeholder={t('settings.layout.nav.selectHost')}
          />
          {hostSettingsDisabled && (
            <p className="mt-2 px-1 text-xs text-low">{hostHint}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          {hostSections.map((section) => renderSectionButton(section.id))}
        </div>
      </div>
      <div className="space-y-2">
        <div className="px-3 pt-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-low">
            {t('settings.layout.nav.accountSettings')}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {universalSections.map((section) => renderSectionButton(section.id))}
        </div>
      </div>
    </nav>
  );
}

function SettingsDialogContent({
  initialSection,
  initialState,
  onClose,
}: SettingsDialogContentProps) {
  const { isTopLayer } = useModalKeyboardLayer(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const getContainer = useCallback(() => containerRef.current, []);
  const { t } = useTranslation('settings');
  const { isDirty } = useSettingsDirty();
  const {
    availableHosts,
    hostsResolved,
    targetResolved,
    selectedHost,
    selectedHostId,
    selectedHostUnavailable,
  } = useSettingsHost();
  const { unavailableHint } = useUnavailableHostText();
  const isRemoteShared = isRemoteSharedHostId(selectedHostId);

  const resolvedInitialSection = useMemo<SettingsSectionType>(() => {
    if (
      initialSection &&
      SETTINGS_SECTION_DEFINITIONS.some(
        (section) => section.id === initialSection
      )
    ) {
      return initialSection;
    }

    if (hostsResolved && availableHosts.length === 0) {
      return 'organizations';
    }

    return 'general';
  }, [availableHosts.length, hostsResolved, initialSection]);

  const [activeSection, setActiveSection] = useState<SettingsSectionType>(
    resolvedInitialSection
  );
  // On mobile, null means show the nav menu, a section means show that section
  const [mobileShowContent, setMobileShowContent] = useState<boolean>(
    initialSection === resolvedInitialSection
  );
  const isConfirmingRef = useRef(false);

  const handleCloseWithConfirmation = useCallback(async () => {
    if (isConfirmingRef.current) return;

    if (isDirty) {
      isConfirmingRef.current = true;
      try {
        const result = await ConfirmDialog.show({
          title: t('settings.unsavedChanges.title'),
          message: t('settings.unsavedChanges.message'),
          confirmText: t('settings.unsavedChanges.discard'),
          cancelText: t('settings.unsavedChanges.cancel'),
          variant: 'destructive',
        });
        if (result === 'confirmed') {
          onClose();
        }
      } finally {
        isConfirmingRef.current = false;
      }
    } else {
      onClose();
    }
  }, [isDirty, onClose, t]);

  const handleSectionSelect = (sectionId: SettingsSectionType) => {
    setActiveSection(sectionId);
    setMobileShowContent(true);
  };

  useEffect(() => {
    if (
      hostsResolved &&
      isHostSpecificSettingsSection(activeSection) &&
      availableHosts.length === 0
    ) {
      setActiveSection('organizations');
    }
  }, [activeSection, availableHosts.length, hostsResolved]);

  // Switching to the "Remote" device hides machine-only host sections; fall
  // back to the one host section it does support.
  // Not while the target is still a placeholder: its kind says nothing about
  // the host the dialog was opened for, and the requested section would be
  // gone by the time that host is selected.
  useEffect(() => {
    if (
      targetResolved &&
      !isHostSectionAvailableForTarget(activeSection, isRemoteShared)
    ) {
      setActiveSection('general');
    }
  }, [activeSection, isRemoteShared, targetResolved]);

  const handleMobileBack = () => {
    setMobileShowContent(false);
  };

  // Escape (close, with the unsaved-changes confirmation) and Tab trapping via
  // the shared dialog keyboard layer; it skips when an inner layer (the
  // confirmation dialog, an open select) already consumed the key.
  useDialogKeyboard({
    open: true,
    getContainer,
    isTopLayer,
    onClose: handleCloseWithConfirmation,
  });

  return (
    <>
      {/* Overlay */}
      <div
        data-tauri-drag-region
        className="fixed inset-0 z-[9998] bg-black/50 animate-in fade-in-0 duration-200"
        onClick={handleCloseWithConfirmation}
      />
      {/* Dialog wrapper - handles positioning; focus contract (initial focus,
          guard, restore) is the shared DialogFocusScope */}
      <DialogFocusScope isTopLayer={isTopLayer}>
        <div
          ref={containerRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          className={cn(
            'fixed z-[9999] outline-none',
            // Mobile: full screen
            'inset-0',
            // Desktop: centered with fixed size
            'md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2'
          )}
        >
          {/* Dialog content - handles animation */}
          <div
            className={cn(
              'h-full w-full flex overflow-hidden',
              'bg-panel/95 backdrop-blur-sm shadow-lg',
              'animate-in fade-in-0 slide-in-from-bottom-4 duration-200',
              // Mobile: full screen, no rounded corners
              'rounded-none border-0',
              // Desktop: wide dialog width (ui/src/lib/dialog-size.ts), rounded corners
              'md:w-[56rem] md:max-w-[calc(100vw-2rem)] md:h-[700px] md:rounded-sm md:border md:border-border/50'
            )}
          >
            {/* Sidebar - hidden on mobile when showing content */}
            <div
              className={cn(
                'bg-secondary/80 border-r border-border flex flex-col',
                // Mobile: full width, hidden when showing content
                'w-full',
                mobileShowContent && 'hidden',
                // Desktop: fixed width sidebar, always visible
                'md:w-56 md:block'
              )}
            >
              {/* Header */}
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h2 className="text-lg font-semibold text-high">
                  {t('settings.layout.nav.title')}
                </h2>
                {/* Close button - mobile only */}
                <button
                  onClick={handleCloseWithConfirmation}
                  className="p-1 rounded-sm hover:bg-secondary text-low hover:text-normal md:hidden"
                >
                  <XIcon className="size-icon-sm" weight="bold" />
                </button>
              </div>
              <SettingsDialogNavigation
                activeSection={activeSection}
                onSectionSelect={handleSectionSelect}
              />
            </div>
            {/* Content - hidden on mobile when showing nav */}
            <div
              className={cn(
                'flex-1 flex flex-col relative overflow-hidden',
                // Mobile: full width, hidden when showing nav
                !mobileShowContent && 'hidden',
                // Desktop: always visible
                'md:flex'
              )}
            >
              {/* Mobile header with back button */}
              <div className="flex items-center gap-2 p-3 border-b border-border md:hidden">
                <button
                  onClick={handleMobileBack}
                  className="p-1 rounded-sm hover:bg-secondary text-low hover:text-normal"
                >
                  <CaretLeftIcon className="size-icon-sm" weight="bold" />
                </button>
                <span className="text-sm font-medium text-high">
                  {t(`settings.layout.nav.${activeSection}`)}
                </span>
                <button
                  onClick={handleCloseWithConfirmation}
                  className="ml-auto p-1 rounded-sm hover:bg-secondary text-low hover:text-normal"
                >
                  <XIcon className="size-icon-sm" weight="bold" />
                </button>
              </div>
              {/* Section content */}
              <div className="flex-1 overflow-y-auto">
                {isHostSpecificSettingsSection(activeSection) ? (
                  // Until the target is final the selection is a placeholder:
                  // showing its settings as editable would let a save land on
                  // another host than the one the dialog was opened for.
                  !targetResolved ? (
                    <div className="px-6 py-8 text-sm text-low">
                      {t('settings.general.loading')}
                    </div>
                  ) : isRemoteShared ? (
                    <SettingsRemoteUserSystemProvider>
                      <SettingsSection
                        type={activeSection}
                        onClose={handleCloseWithConfirmation}
                        initialState={initialState}
                        onNavigate={handleSectionSelect}
                      />
                    </SettingsRemoteUserSystemProvider>
                  ) : selectedHost ? (
                    <>
                      {selectedHostUnavailable && (
                        <div className="mx-6 mt-4 rounded-sm border border-error/50 bg-error/10 p-3 text-sm text-error">
                          {unavailableHint}
                        </div>
                      )}
                      {/* Keyed by machine: a section's draft, dirty flag and
                          in-flight save all belong to the host they were made
                          for and are dropped with it, never applied to the
                          next. */}
                      <SettingsMachineUserSystemProvider key={selectedHost.id}>
                        <SettingsSection
                          type={activeSection}
                          onClose={handleCloseWithConfirmation}
                          initialState={initialState}
                          onNavigate={handleSectionSelect}
                        />
                      </SettingsMachineUserSystemProvider>
                    </>
                  ) : selectedHostUnavailable ? (
                    <div className="px-6 py-8 text-sm text-low">
                      {unavailableHint}
                    </div>
                  ) : availableHosts.length > 0 ? (
                    <div className="px-6 py-8 text-sm text-low">
                      {t('settings.hostPicker.selectMachineHint')}
                    </div>
                  ) : (
                    <div className="px-6 py-8 text-sm text-low">
                      {t('settings.hostPicker.noHostAvailable')}
                    </div>
                  )
                ) : (
                  <SettingsSection
                    type={activeSection}
                    onClose={handleCloseWithConfirmation}
                    initialState={initialState}
                    onNavigate={handleSectionSelect}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogFocusScope>
    </>
  );
}

const SettingsDialogImpl = create<SettingsDialogProps>(
  ({ initialSection, initialState, initialHostId }) => {
    const modal = useModal();
    const handleClose = useCallback(() => {
      modal.hide();
      modal.resolve();
      modal.remove();
    }, [modal]);

    return createPortal(
      <SettingsDirtyProvider>
        <SettingsHostProvider initialHostId={initialHostId}>
          <SettingsDialogContent
            initialSection={initialSection}
            initialState={initialState}
            onClose={handleClose}
          />
        </SettingsHostProvider>
      </SettingsDirtyProvider>,
      document.body
    );
  }
);

export const SettingsDialog = defineModal<SettingsDialogProps | void, void>(
  SettingsDialogImpl
);
