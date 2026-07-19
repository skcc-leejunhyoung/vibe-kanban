import { jwtDecode } from 'jwt-decode';

type AccessTokenClaims = {
  exp: number;
  aud: string;
  sub?: string;
};

const TOKEN_REFRESH_LEEWAY_MS = 20_000;
const ACCESS_TOKEN_AUD = 'access';

const getTokenExpiryMs = (token: string): number | null => {
  try {
    const { exp, aud } = jwtDecode<AccessTokenClaims>(token);
    if (aud !== ACCESS_TOKEN_AUD) return null;
    if (!Number.isFinite(exp)) return null;
    return exp * 1000;
  } catch {
    return null;
  }
};

export const shouldRefreshAccessToken = (token: string): boolean => {
  const expiresAt = getTokenExpiryMs(token);
  if (expiresAt === null) return true;
  return expiresAt - Date.now() <= TOKEN_REFRESH_LEEWAY_MS;
};

export const getAccessTokenSubject = (token: string): string | null => {
  try {
    const { aud, sub } = jwtDecode<AccessTokenClaims>(token);
    return aud === ACCESS_TOKEN_AUD && typeof sub === 'string' && sub.length > 0
      ? sub
      : null;
  } catch {
    return null;
  }
};
