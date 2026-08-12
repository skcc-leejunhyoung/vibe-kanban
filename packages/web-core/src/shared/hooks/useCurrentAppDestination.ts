import { createElement, useContext, useMemo, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { createHmrContext } from '@/shared/lib/hmrContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';

// Split panes render workspace views whose "current destination" is the pane's
// own, not the document URL's. Providing an override here scopes every
// destination-derived provider (host id, workspace, actions) to the pane.
const AppDestinationOverrideContext = createHmrContext<AppDestination | null>(
  'AppDestinationOverrideContext',
  null
);

export function AppDestinationOverrideProvider({
  value,
  children,
}: {
  value: AppDestination;
  children: ReactNode;
}) {
  return createElement(
    AppDestinationOverrideContext.Provider,
    { value },
    children
  );
}

export function useCurrentAppDestination(): AppDestination | null {
  const appNavigation = useAppNavigation();
  const location = useLocation();
  const override = useContext(AppDestinationOverrideContext);

  return useMemo(
    () => override ?? appNavigation.resolveFromPath(location.pathname),
    [override, appNavigation, location.pathname]
  );
}
