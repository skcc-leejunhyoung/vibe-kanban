import { describe, expect, it } from "vitest";
import { legacyPullRequestsRedirectOptions } from "./hosts.$hostId.pull-requests";

describe("legacy pull request route", () => {
  it("redirects to the global screen without dropping the PR deep link", () => {
    const prUrl = "https://github.com/acme/widgets/pull/42";

    expect(legacyPullRequestsRedirectOptions(prUrl)).toEqual({
      to: "/pull-requests",
      search: { prUrl },
      replace: true,
    });
  });
});
