import { describe, expect, it } from "vitest";
import { advanceNotificationSoundState } from "./RemoteSharedConfigProvider";

describe("advanceNotificationSoundState", () => {
  it("plays only for a new or refreshed unseen notification", () => {
    const initial = [
      { id: "notification-1", seen: false, created_at: "2026-09-06T00:00:00Z" },
    ];
    const first = advanceNotificationSoundState(null, initial);
    expect(first.shouldPlay).toBe(false);

    const seen = advanceNotificationSoundState(first.next, [
      { ...initial[0], seen: true },
    ]);
    expect(seen.shouldPlay).toBe(false);

    const refreshedNotification = {
      ...initial[0],
      created_at: "2026-09-06T00:01:00Z",
    };
    const refreshed = advanceNotificationSoundState(seen.next, [
      refreshedNotification,
    ]);
    expect(refreshed.shouldPlay).toBe(true);

    const added = advanceNotificationSoundState(refreshed.next, [
      refreshedNotification,
      { id: "notification-2", seen: false, created_at: "2026-09-06T00:02:00Z" },
    ]);
    expect(added.shouldPlay).toBe(true);
  });
});
