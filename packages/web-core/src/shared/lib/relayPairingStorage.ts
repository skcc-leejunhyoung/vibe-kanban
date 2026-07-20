const DB_NAME = 'vk-relay-pairing';
const DB_VERSION = 1;
const PAIRED_HOSTS_STORE = 'paired_hosts';

type RelayPairingChangeType = 'saved' | 'removed';

export interface RelayPairingChange {
  hostId: string;
  type: RelayPairingChangeType;
}

type RelayPairingChangeListener = (change: RelayPairingChange) => void;

const relayPairingChangeListeners = new Set<RelayPairingChangeListener>();

export interface PairedRelayHost {
  host_id: string;
  host_name: string;
  client_id?: string;
  client_name?: string;
  signing_session_id?: string;
  public_key_b64: string;
  /**
   * Non-extractable Ed25519 signing key, stored as a CryptoKey (structured
   * clone keeps it non-extractable) so an XSS cannot read the raw key material
   * out of IndexedDB. New pairings always set this.
   */
  private_key?: CryptoKey;
  /**
   * Legacy: an extractable private-key JWK persisted by older builds. Retained
   * only so pre-existing pairings keep working; `migratePairedHostKey` upgrades
   * these to `private_key` and drops the raw material.
   */
  private_key_jwk?: JsonWebKey;
  server_public_key_b64: string;
  paired_at: string;
}

export function subscribeRelayPairingChanges(
  listener: RelayPairingChangeListener
): () => void {
  relayPairingChangeListeners.add(listener);
  return () => {
    relayPairingChangeListeners.delete(listener);
  };
}

function emitRelayPairingChange(change: RelayPairingChange): void {
  for (const listener of relayPairingChangeListeners) {
    try {
      listener(change);
    } catch (error) {
      console.error('relay pairing change listener failed', error);
    }
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAIRED_HOSTS_STORE)) {
        db.createObjectStore(PAIRED_HOSTS_STORE, { keyPath: 'host_id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listPairedRelayHosts(): Promise<PairedRelayHost[]> {
  const db = await openDb();
  return new Promise<PairedRelayHost[]>((resolve, reject) => {
    const tx = db.transaction(PAIRED_HOSTS_STORE, 'readonly');
    const store = tx.objectStore(PAIRED_HOSTS_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const pairedHosts = (request.result as PairedRelayHost[]) ?? [];
      pairedHosts.sort((a, b) => b.paired_at.localeCompare(a.paired_at));
      resolve(pairedHosts);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
    };
  });
}

export async function savePairedRelayHost(
  host: PairedRelayHost
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAIRED_HOSTS_STORE, 'readwrite');
    const store = tx.objectStore(PAIRED_HOSTS_STORE);
    const request = store.put(host);

    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      emitRelayPairingChange({ hostId: host.host_id, type: 'saved' });
      resolve();
    };
  });
}

export async function removePairedRelayHost(hostId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAIRED_HOSTS_STORE, 'readwrite');
    const store = tx.objectStore(PAIRED_HOSTS_STORE);
    const request = store.delete(hostId);

    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => {
      db.close();
      emitRelayPairingChange({ hostId, type: 'removed' });
      resolve();
    };
  });
}

export async function clearPairedRelayHosts(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PAIRED_HOSTS_STORE, 'readwrite');
    const store = tx.objectStore(PAIRED_HOSTS_STORE);
    const keysRequest = store.getAllKeys();

    keysRequest.onerror = () => reject(keysRequest.error);
    keysRequest.onsuccess = () => {
      const hostIds = keysRequest.result.filter(
        (key): key is string => typeof key === 'string'
      );
      const clearRequest = store.clear();
      clearRequest.onerror = () => reject(clearRequest.error);
      tx.oncomplete = () => {
        db.close();
        hostIds.forEach((hostId) =>
          emitRelayPairingChange({ hostId, type: 'removed' })
        );
        resolve();
      };
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Resolve a paired host's Ed25519 signing key as a NON-EXTRACTABLE CryptoKey.
 * New pairings persist `private_key` directly. Legacy pairings only have an
 * extractable `private_key_jwk`; it is imported as a non-extractable key so
 * signing keeps working, while `migratePairedHostKey` removes the raw material
 * at rest.
 */
export async function resolveSigningKey(
  host: PairedRelayHost
): Promise<CryptoKey> {
  if (host.private_key) {
    return host.private_key;
  }
  if (host.private_key_jwk) {
    return crypto.subtle.importKey(
      'jwk',
      host.private_key_jwk,
      { name: 'Ed25519' },
      false,
      ['sign']
    );
  }
  throw new Error('This host pairing is missing its signing key. Re-pair it.');
}

/**
 * Upgrade a legacy pairing (extractable `private_key_jwk`) in place to the
 * non-extractable `private_key` CryptoKey form, removing the raw key material
 * from IndexedDB. No-op for already-migrated or unpaired hosts.
 */
export async function migratePairedHostKey(
  host: PairedRelayHost
): Promise<PairedRelayHost> {
  if (host.private_key || !host.private_key_jwk) {
    return host;
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    host.private_key_jwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
  const migrated: PairedRelayHost = { ...host, private_key: privateKey };
  delete migrated.private_key_jwk;
  await savePairedRelayHost(migrated);
  return migrated;
}
