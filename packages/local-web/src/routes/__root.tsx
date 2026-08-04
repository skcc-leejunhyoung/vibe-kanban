import { Outlet, createRootRoute } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { ThemeMode } from 'shared/types';
import i18n from '@/i18n';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { ThemeProvider } from '@web/app/providers/ThemeProvider';
import { useUiPreferencesScratch } from '@/shared/hooks/useUiPreferencesScratch';
import { useServiceWorkerNavigation } from '@/shared/hooks/useServiceWorkerNavigation';
import { useWebPushReconcile } from '@/shared/hooks/useWebPushReconcile';
import { useApplyThemeVariant } from '@/shared/lib/themeVariant';
import { installKeyboardModalityTracker } from '@/shared/lib/keyboardModality';
import { UserProvider } from '@/shared/providers/remote/UserProvider';
import '@/app/styles/new/index.css';

installKeyboardModalityTracker();

function RootRouteComponent() {
  const { config } = useUserSystem();

  useUiPreferencesScratch();
  useServiceWorkerNavigation();
  useWebPushReconcile();
  useApplyThemeVariant();

  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider
        initialTheme={config?.theme || ThemeMode.SYSTEM}
        initialPrimaryColor={config?.primary_color}
      >
        <UserProvider>
          <Outlet />
        </UserProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
}

export const Route = createRootRoute({
  component: RootRouteComponent,
});
