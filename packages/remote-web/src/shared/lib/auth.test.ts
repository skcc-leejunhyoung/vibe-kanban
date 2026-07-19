import { describe, expect, it } from "vitest";
import { accessTokensBelongToDifferentUsers } from "./auth";

function accessToken(subject: string, nonce: string): string {
  const payload = btoa(
    JSON.stringify({ aud: "access", sub: subject, exp: 4_000_000_000, nonce }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `e30.${payload}.signature`;
}

describe("accessTokensBelongToDifferentUsers", () => {
  it("keeps relay pairings across token refreshes for the same user", () => {
    expect(
      accessTokensBelongToDifferentUsers(
        accessToken("user-a", "old"),
        accessToken("user-a", "new"),
      ),
    ).toBe(false);
  });

  it("clears relay pairings for account changes or undecodable tokens", () => {
    expect(
      accessTokensBelongToDifferentUsers(
        accessToken("user-a", "old"),
        accessToken("user-b", "new"),
      ),
    ).toBe(true);
    expect(
      accessTokensBelongToDifferentUsers("old-invalid", "new-invalid"),
    ).toBe(true);
  });
});
