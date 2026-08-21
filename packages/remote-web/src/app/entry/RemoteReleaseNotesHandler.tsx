import { useEffect } from "react";
import { ReleaseNotesDialog } from "@/shared/dialogs/global/ReleaseNotesDialog";
import { useAuth } from "@/shared/hooks/auth/useAuth";

export function RemoteReleaseNotesHandler() {
  const { isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isSignedIn || !userId) return;

    const key = `vibe:remote:last-app-version:${userId}`;
    let previousVersion: string | null;
    try {
      previousVersion = localStorage.getItem(key);
      localStorage.setItem(key, __APP_VERSION__);
    } catch {
      return;
    }
    if (!previousVersion || previousVersion === __APP_VERSION__) return;

    void ReleaseNotesDialog.show().finally(() => ReleaseNotesDialog.hide());
  }, [isSignedIn, userId]);

  return null;
}
