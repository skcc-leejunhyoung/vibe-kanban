import { RouterProvider } from "@tanstack/react-router";
import { HotkeysProvider } from "react-hotkeys-hook";
import { router } from "@remote/app/router";
import { AppRuntimeProvider } from "@/shared/hooks/useAppRuntime";
import { setDefaultRightSidebarVisible } from "@/shared/stores/useUiPreferencesStore";

// Remote web runs on narrow screens far more often than the desktop app, so a
// workspace opens with the git sidebar collapsed. Per-workspace toggles still
// override this.
setDefaultRightSidebarVisible(false);

export function AppRouter() {
  return (
    <AppRuntimeProvider runtime="remote">
      <HotkeysProvider
        initiallyActiveScopes={["global", "workspace", "kanban", "projects"]}
      >
        <RouterProvider router={router} />
      </HotkeysProvider>
    </AppRuntimeProvider>
  );
}
