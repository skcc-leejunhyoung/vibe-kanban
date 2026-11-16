import { createElement, useContext, useMemo, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { createHmrContext } from '@/shared/lib/hmrContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useSelfCloudHostId } from '@/shared/hooks/useSelfCloudHostId';
import {
  foldSelfHostDestination,
  type AppDestination,
} from '@/shared/lib/routes/appNavigation';

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
  // A route naming this machine by its own cloud host id is this machine.
  // The parser folds it once the id is known; folding again here, with the id
  // read in this hook, is what makes the route be parsed again when the id
  // arrives. The React Compiler derives memo inputs from what the body reads,
  // so an id listed only as a dependency would be dropped and the document
  // would keep addressing this machine through the relay until the URL moved.
  const { hostId: selfHostId } = useSelfCloudHostId();

  return useMemo(
    () =>
      override ??
      foldSelfHostDestination(
        appNavigation.resolveFromPath(location.href),
        selfHostId
      ),
    [override, appNavigation, location.href, selfHostId]
  );
}

/**
 * True inside a split-pane scope (a destination override is present). Chrome
 * hooks use this to distinguish "document chrome targeting the active pane"
 * from a pane's own subtree, which must stay scoped to itself.
 */
export function useHasAppDestinationOverride(): boolean {
  return useContext(AppDestinationOverrideContext) !== null;
}
