import type { PairedRelayHost } from "@/shared/lib/relayPairingStorage";
import {
  migratePairedHostKey,
  resolveSigningKey,
  subscribeRelayPairingChanges,
} from "@/shared/lib/relayPairingStorage";

import { base64ToBytes, toArrayBuffer } from "@remote/shared/lib/relay/bytes";

const signingKeyCache = new Map<string, CryptoKey>();
const serverVerifyKeyCache = new Map<string, CryptoKey>();

subscribeRelayPairingChanges(({ hostId }) => {
  clearRelayHostCryptoCaches(hostId);
});

export async function getSigningKey(
  pairedHost: PairedRelayHost,
): Promise<CryptoKey> {
  const signingSessionId = pairedHost.signing_session_id;
  if (!signingSessionId) {
    throw new Error("Missing signing session for paired host.");
  }

  const cacheKey = pairedHost.host_id;
  const cachedKey = signingKeyCache.get(cacheKey);
  if (cachedKey) {
    return cachedKey;
  }

  const signingKey = await resolveSigningKey(pairedHost);
  signingKeyCache.set(cacheKey, signingKey);

  // Opportunistically upgrade a legacy extractable JWK at rest to a
  // non-extractable CryptoKey. Fire-and-forget: signing already works with the
  // key above; the rewrite just strips the raw material from IndexedDB. The
  // resulting pairing-change event clears this cache, which then re-resolves
  // cleanly from `private_key`.
  if (!pairedHost.private_key && pairedHost.private_key_jwk) {
    void migratePairedHostKey(pairedHost).catch(() => {});
  }

  return signingKey;
}

export async function getServerVerifyKey(
  pairedHost: PairedRelayHost,
): Promise<CryptoKey> {
  const signingSessionId = pairedHost.signing_session_id;
  if (!signingSessionId) {
    throw new Error("Missing signing session for paired host.");
  }

  const cacheKey = pairedHost.host_id;
  const cachedKey = serverVerifyKeyCache.get(cacheKey);
  if (cachedKey) {
    return cachedKey;
  }

  const serverPublicKeyB64 = pairedHost.server_public_key_b64;
  if (!serverPublicKeyB64) {
    throw new Error("Missing server signing key for paired host.");
  }

  const importedKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(serverPublicKeyB64)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  serverVerifyKeyCache.set(cacheKey, importedKey);
  return importedKey;
}

export function clearRelayHostCryptoCaches(hostId: string): void {
  signingKeyCache.delete(hostId);
  serverVerifyKeyCache.delete(hostId);
}
