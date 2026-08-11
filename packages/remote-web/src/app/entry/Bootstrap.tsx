import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRouter } from "@remote/app/entry/App";
import { RemoteAuthProvider } from "@remote/app/providers/RemoteAuthProvider";
import { getIdentity } from "@remote/shared/lib/api";
import { getToken, triggerRefresh } from "@remote/shared/lib/auth/tokenManager";
import "@remote/app/styles/index.css";
import "@/i18n";
import { configureAuthRuntime } from "@/shared/lib/auth/runtime";
import { setRemoteApiBase } from "@/shared/lib/remoteApi";
import { setRelayApiBase } from "@/shared/lib/relayBackendApi";
import { setLocalApiTransport } from "@/shared/lib/localApiTransport";
import {
  applyPrimaryColor,
  applyTheme,
  loadPersistedPrimaryColor,
  loadPersistedTheme,
} from "@/shared/lib/themeColors";
import { loadPersistedLanguage, updateLanguageFromConfig } from "@/i18n/config";
import "@/shared/types/modals";
import { queryClient } from "@/shared/lib/queryClient";
import {
  requestLocalApiViaWebRtc,
  openLocalApiStreamViaWebRtc,
  openLocalApiWebSocketViaWebRtc,
} from "@remote/shared/lib/webrtc";
import { installRelayResumeReconnect } from "@remote/shared/lib/relay/resumeReconnect";
import { installKeyboardModalityTracker } from "@/shared/lib/keyboardModality";
import { installAppZoom } from "@/shared/lib/zoom";

setRemoteApiBase(import.meta.env.VITE_API_BASE_URL || window.location.origin);
setRelayApiBase(
  import.meta.env.VITE_RELAY_API_BASE_URL ||
    import.meta.env.VITE_API_BASE_URL ||
    window.location.origin,
);
setLocalApiTransport({
  request: requestLocalApiViaWebRtc,
  openWebSocket: openLocalApiWebSocketViaWebRtc,
  openStream: openLocalApiStreamViaWebRtc,
});
// Re-establish the relay transport after the (standalone PWA) app is resumed
// from suspension, so a stale signing session / dead data channel doesn't leave
// the app spinning until a manual reload.
installRelayResumeReconnect();
installKeyboardModalityTracker();
installAppZoom();

configureAuthRuntime({
  getToken,
  triggerRefresh,
  registerShape: () => () => {},
  getCurrentUser: async () => {
    const identity = await getIdentity();
    return { user_id: identity.user_id };
  },
});

// Apply cached UI preferences before first paint so they survive a refresh on
// routes that don't load host config (e.g. /projects/$projectId), where config
// is unavailable. applyTheme(null) falls back to the system preference.
applyTheme(loadPersistedTheme());
const cachedLanguage = loadPersistedLanguage();
if (cachedLanguage) {
  updateLanguageFromConfig(cachedLanguage);
}
const cachedPrimaryColor = loadPersistedPrimaryColor();
if (cachedPrimaryColor) {
  applyPrimaryColor(cachedPrimaryColor);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RemoteAuthProvider>
        <AppRouter />
      </RemoteAuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
