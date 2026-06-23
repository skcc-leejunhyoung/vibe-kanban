import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayHostContext } from "@remote/shared/lib/relay/types";

// context.ts pulls in the relay storage + backend API layers; mock them so the
// test exercises only the refresh orchestration (single-flight + client_id
// guard) without touching IndexedDB or the network.
const refreshRelaySigningSessionMock = vi.fn();
const savePairedRelayHostMock = vi.fn();
const buildPayloadMock = vi.fn();

vi.mock("@/shared/lib/relayPairingStorage", () => ({
  listPairedRelayHosts: vi.fn(async () => []),
  savePairedRelayHost: (...args: unknown[]) => savePairedRelayHostMock(...args),
  subscribeRelayPairingChanges: () => () => {},
}));

vi.mock("@/shared/lib/relayBackendApi", () => ({
  createRemoteSession: vi.fn(async () => ({ session_id: "relay-session" })),
  refreshRelaySigningSession: (...args: unknown[]) =>
    refreshRelaySigningSessionMock(...args),
}));

vi.mock("@/shared/lib/relaySigningSessionRefresh", () => ({
  buildRelaySigningSessionRefreshPayload: (...args: unknown[]) =>
    buildPayloadMock(...args),
}));

import { tryRefreshRelayHostSigningSession } from "./context";

function makeContext(
  overrides: Partial<RelayHostContext["pairedHost"]> = {},
  sessionId = "relay-session-1",
): RelayHostContext {
  return {
    pairedHost: {
      host_id: "host-1",
      host_name: "Host",
      client_id: "client-1",
      public_key_b64: "pk",
      private_key_jwk: {} as JsonWebKey,
      server_public_key_b64: "spk",
      paired_at: "2026-01-01T00:00:00Z",
      signing_session_id: "old-session",
      ...overrides,
    },
    sessionId,
  };
}

beforeEach(() => {
  refreshRelaySigningSessionMock.mockReset();
  savePairedRelayHostMock.mockReset();
  savePairedRelayHostMock.mockResolvedValue(undefined);
  buildPayloadMock.mockReset();
  buildPayloadMock.mockResolvedValue({
    client_id: "client-1",
    timestamp: 1,
    nonce: "nonce",
    signature_b64: "sig",
  });
});

describe("tryRefreshRelayHostSigningSession", () => {
  it("collapses concurrent refreshes for the same host into one network call", async () => {
    let resolveRefresh!: (value: { signing_session_id: string }) => void;
    refreshRelaySigningSessionMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    // Two requests 401 at the same time (e.g. workspaces + sessions on entry),
    // each carrying its own relay session id.
    const pA = tryRefreshRelayHostSigningSession(makeContext({}, "relay-A"));
    const pB = tryRefreshRelayHostSigningSession(makeContext({}, "relay-B"));

    resolveRefresh({ signing_session_id: "new-session" });
    const [rA, rB] = await Promise.all([pA, pB]);

    // One shared refresh, both callers get the fresh signing session...
    expect(refreshRelaySigningSessionMock).toHaveBeenCalledTimes(1);
    expect(rA?.pairedHost.signing_session_id).toBe("new-session");
    expect(rB?.pairedHost.signing_session_id).toBe("new-session");
    // ...while preserving each caller's own relay session id.
    expect(rA?.sessionId).toBe("relay-A");
    expect(rB?.sessionId).toBe("relay-B");
  });

  it("returns null without any network call when the pairing has no client_id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await tryRefreshRelayHostSigningSession(
      makeContext({ client_id: undefined }),
    );

    expect(result).toBeNull();
    expect(refreshRelaySigningSessionMock).not.toHaveBeenCalled();
    expect(savePairedRelayHostMock).not.toHaveBeenCalled();
  });

  it("starts a fresh refresh once the previous one has settled", async () => {
    refreshRelaySigningSessionMock
      .mockResolvedValueOnce({ signing_session_id: "s1" })
      .mockResolvedValueOnce({ signing_session_id: "s2" });

    const r1 = await tryRefreshRelayHostSigningSession(makeContext());
    const r2 = await tryRefreshRelayHostSigningSession(makeContext());

    expect(refreshRelaySigningSessionMock).toHaveBeenCalledTimes(2);
    expect(r1?.pairedHost.signing_session_id).toBe("s1");
    expect(r2?.pairedHost.signing_session_id).toBe("s2");
  });

  it("returns null and clears in-flight state when the refresh fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refreshRelaySigningSessionMock.mockRejectedValueOnce(
      new Error("missing or expired signing session (401)"),
    );

    const r1 = await tryRefreshRelayHostSigningSession(makeContext());
    expect(r1).toBeNull();

    // The in-flight entry must be cleared so a later attempt can retry rather
    // than forever awaiting the failed promise.
    refreshRelaySigningSessionMock.mockResolvedValueOnce({
      signing_session_id: "recovered",
    });
    const r2 = await tryRefreshRelayHostSigningSession(makeContext());
    expect(r2?.pairedHost.signing_session_id).toBe("recovered");
    expect(refreshRelaySigningSessionMock).toHaveBeenCalledTimes(2);
  });
});
