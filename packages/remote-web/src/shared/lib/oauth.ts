import {
  initOAuth,
  redeemOAuth,
  type OAuthProvider,
} from "@remote/shared/lib/api";
import {
  getAccessToken,
  beginOAuthReconnect,
  endOAuthReconnect,
  storeTokens,
} from "@remote/shared/lib/auth";
import { getAccessTokenSubject } from "shared/jwt";
import {
  generateChallenge,
  generateVerifier,
  storeVerifier,
  retrieveVerifier,
  clearVerifier,
} from "@remote/shared/lib/pkce";

const RECONNECT_KEY = "oauth_reconnect";
type ReconnectContext = {
  handoffId: string;
  userId: string;
  provider: OAuthProvider;
  guardId?: string;
};

function reconnectContext(): ReconnectContext | null {
  try {
    const saved = sessionStorage.getItem(RECONNECT_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

/** Returning from the provider without a callback cancels only this tab's guard. */
export async function cancelOAuthReconnect(): Promise<void> {
  const context = reconnectContext();
  if (!context?.guardId) return;
  await endOAuthReconnect(context.guardId);
  if (reconnectContext()?.guardId === context.guardId) {
    sessionStorage.removeItem(RECONNECT_KEY);
    clearVerifier();
  }
}

export async function startOAuthLogin(
  provider: OAuthProvider,
  next?: string,
  reauthenticate = false,
): Promise<void> {
  // Ordinary refresh validates the broken provider credential and can sign out
  // the user. Authorize only the recovery handoff with the app refresh token.
  // Install cross-tab protection atomically with reading the credential, before
  // even PKCE/init awaits. Failure releases only this attempt's protection.
  const recovery = reauthenticate ? await beginOAuthReconnect() : undefined;
  const userId = recovery?.userId;
  try {
    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    const appBase = import.meta.env.VITE_APP_BASE_URL || window.location.origin;
    const callbackUrl = new URL("/account/complete", appBase);
    if (next) callbackUrl.searchParams.set("next", next);
    if (reauthenticate) callbackUrl.searchParams.set("reconnect", provider);

    const { authorize_url, handoff_id } = await initOAuth(
      provider,
      callbackUrl.toString(),
      challenge,
      recovery?.refreshToken,
    );
    if (
      userId &&
      getAccessTokenSubject((await getAccessToken()) ?? "") !== userId
    ) {
      throw new Error(
        "The signed-in account changed. Please retry from your account.",
      );
    }
    // A failed init must not replace the verifier for an existing handoff.
    const previousGuard = reconnectContext()?.guardId;
    storeVerifier(verifier);
    if (userId) {
      sessionStorage.setItem(
        RECONNECT_KEY,
        JSON.stringify({
          handoffId: handoff_id,
          userId,
          provider,
          guardId: recovery?.id,
        } satisfies ReconnectContext),
      );
    } else {
      sessionStorage.removeItem(RECONNECT_KEY);
    }
    if (previousGuard) await endOAuthReconnect(previousGuard);
    window.location.assign(authorize_url);
  } catch (error) {
    if (recovery) await endOAuthReconnect(recovery.id);
    throw error;
  }
}

export async function redirectToOAuth(
  provider?: OAuthProvider,
  reauthenticate = false,
): Promise<void> {
  const { pathname, search, hash } = window.location;
  const next = `${pathname}${search}${hash}`;
  if (provider) {
    // Bypass /account's signed-in redirect when renewing provider credentials.
    await startOAuthLogin(provider, next, reauthenticate);
  } else {
    window.location.assign(`/account?${new URLSearchParams({ next })}`);
  }
}

export async function finishOAuthLogin(
  handoffId: string,
  appCode: string,
  reconnect?: OAuthProvider,
): Promise<void> {
  const verifier = retrieveVerifier();
  if (!verifier) throw new Error("OAuth session lost. Please try again.");
  const context = reconnectContext();
  // Both the server binding and this browser's initiating identity must agree.
  // Losing tab storage must not downgrade reconnection to an ordinary login.
  if (reconnect || context) {
    const currentToken = await getAccessToken();
    if (
      !context ||
      context.handoffId !== handoffId ||
      context.provider !== reconnect ||
      !context.userId ||
      !currentToken ||
      getAccessTokenSubject(currentToken) !== context.userId
    ) {
      throw new Error(
        "The signed-in account or OAuth session changed. Please retry from your account.",
      );
    }
  }
  const tokens = await redeemOAuth(handoffId, appCode, verifier);
  await storeTokens(
    tokens.access_token,
    tokens.refresh_token,
    context ? { expectedUserId: context.userId } : undefined,
  );
  // An older completion must not discard a newer handoff started in this tab.
  if (retrieveVerifier() === verifier) {
    clearVerifier();
    sessionStorage.removeItem(RECONNECT_KEY);
  }
}
