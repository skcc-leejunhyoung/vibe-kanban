import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginCompletePage from "./LoginCompletePage";
import { finishOAuthLogin, startOAuthLogin } from "@remote/shared/lib/oauth";

const harness = vi.hoisted(() => ({
  search: {} as Record<string, string>,
  effects: [] as Array<() => void | (() => void)>,
  state: [] as unknown[],
  cursor: 0,
  ref: { current: null as unknown },
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => harness.search,
  useNavigate: () => harness.navigate,
}));
vi.mock("@remote/shared/lib/oauth", () => ({
  finishOAuthLogin: vi.fn(),
  startOAuthLogin: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => harness.ref,
  useEffect: (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [
      harness.state[index],
      (value: unknown) => {
        harness.state[index] = value;
      },
    ];
  },
}));

const next =
  "/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F42#discussion";
const replace = vi.fn();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function render() {
  harness.cursor = 0;
  return LoginCompletePage();
}
function retryButton(
  node: ReactNode,
): ReactElement<{ onClick: () => void; disabled: boolean }> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === "button")
    return node as ReactElement<{ onClick: () => void; disabled: boolean }>;
  return Children.toArray(node.props.children).map(retryButton).find(Boolean);
}

beforeEach(() => {
  vi.resetAllMocks();
  harness.state = [];
  harness.effects = [];
  harness.ref.current = null;
  harness.search = {
    handoff_id: "handoff",
    app_code: "code",
    reconnect: "github",
    next,
  };
  vi.stubGlobal("window", { location: { replace } });
  vi.mocked(finishOAuthLogin).mockResolvedValue();
  vi.mocked(startOAuthLogin).mockResolvedValue();
});
afterEach(() => vi.unstubAllGlobals());

describe("OAuth callback recovery", () => {
  it.each(["denied", "redeem-failure", "missing-code"])(
    "restarts signed-in GitHub recovery directly after %s",
    async (failure) => {
      if (failure === "denied") harness.search.error = "access_denied";
      if (failure === "missing-code") delete harness.search.app_code;
      if (failure === "redeem-failure")
        vi.mocked(finishOAuthLogin).mockRejectedValue(
          new Error("redeem failed"),
        );
      render();
      harness.effects[0]();
      await flush();
      retryButton(render())!.props.onClick();
      await flush();
      expect(startOAuthLogin).toHaveBeenCalledWith("github", next, true);
      expect(harness.navigate).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("shows restart failures and re-enables retry", async () => {
    harness.search.error = "access_denied";
    vi.mocked(startOAuthLogin).mockRejectedValue(
      new Error("OAuth init failed (503)"),
    );
    render();
    harness.effects[0]();
    await flush();
    retryButton(render())!.props.onClick();
    await flush();
    expect(harness.state[0]).toBe("OAuth init failed (503)");
    expect(retryButton(render())!.props.disabled).toBe(false);
  });

  it("redeems once across StrictMode effect replay and returns to the PR", async () => {
    render();
    const effect = harness.effects[0];
    const cleanup = effect();
    if (cleanup) cleanup();
    effect();
    await flush();
    expect(finishOAuthLogin).toHaveBeenCalledExactlyOnceWith(
      "handoff",
      "code",
      "github",
    );
    expect(replace).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("keeps ordinary login retry on the account page", async () => {
    delete harness.search.reconnect;
    harness.search.error = "access_denied";
    render();
    harness.effects[0]();
    await flush();
    retryButton(render())!.props.onClick();
    await flush();
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/account",
      search: { next },
      replace: true,
    });
    expect(startOAuthLogin).not.toHaveBeenCalled();
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/\n/evil.example",
  ])("rejects an external callback destination %s", async (unsafe) => {
    harness.search.next = unsafe;
    render();
    harness.effects[0]();
    await flush();
    expect(replace).toHaveBeenCalledWith("/");
  });
});
