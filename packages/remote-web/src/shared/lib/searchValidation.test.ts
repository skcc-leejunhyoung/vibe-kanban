import { describe, expect, it, vi } from "vitest";
import { Route } from "../../routes/account";

vi.mock("../../pages/LoginPage", () => ({ default: () => null }));
vi.mock("@remote/shared/lib/route-auth", () => ({
  redirectAuthenticatedToHome: vi.fn(),
}));

describe("account search validation", () => {
  const validator = Route.options.validateSearch;
  if (!validator || !("~standard" in validator)) {
    throw new Error("Account search must expose a Standard Schema validator");
  }

  it("preserves valid redirect options and removes unknown query fields", async () => {
    expect(
      await validator["~standard"].validate({
        next: "/settings",
        reauthenticate: true,
        unknown: "discard",
      }),
    ).toEqual({ value: { next: "/settings", reauthenticate: true } });
  });

  it("rejects query fields with the wrong type", async () => {
    const result = await validator["~standard"].validate({
      reauthenticate: "true",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["reauthenticate"] }),
      ]),
    );
  });
});
