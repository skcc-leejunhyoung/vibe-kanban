type PauseableShape = { pause: () => void; resume: () => void };

type CurrentUser = { user_id: string };

export interface AuthRuntime {
  getToken: () => Promise<string | null>;
  /** A 401 retry must keep the identity of the token the request used. */
  triggerRefresh: (rejectedAccessToken?: string) => Promise<string | null>;
  registerShape: (shape: PauseableShape) => () => void;
  getCurrentUser: () => Promise<CurrentUser>;
  /** Browser deployments authenticate centrally instead of opening the local handoff dialog. */
  redirectToOAuth?: (
    provider?: 'github' | 'google',
    reauthenticate?: boolean
  ) => Promise<void>;
}

let authRuntime: AuthRuntime | null = null;

export function configureAuthRuntime(runtime: AuthRuntime): void {
  authRuntime = runtime;
}

export function getAuthRuntime(): AuthRuntime {
  if (!authRuntime) {
    throw new Error('Auth runtime has not been configured');
  }

  return authRuntime;
}
