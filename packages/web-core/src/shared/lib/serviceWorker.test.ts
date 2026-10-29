import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('versions push tags and keeps a newer banner when an older revision is read', async () => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const notifications = ['alert', 'alert:1', 'alert:2'].map((tag) => ({
    tag,
    close: vi.fn(),
  }));
  const showNotification = vi.fn();
  runInNewContext(
    readFileSync(new URL('../../../../public/sw.js', import.meta.url), 'utf8'),
    {
      self: {
        addEventListener: (
          name: string,
          callback: (event: unknown) => void
        ) => {
          listeners[name] = callback;
        },
        registration: {
          showNotification,
          getNotifications: async () => notifications,
        },
      },
    }
  );
  for (const revision of [undefined, 1, 2]) {
    listeners.push({
      data: { json: () => ({ notification_id: 'alert', revision }) },
      waitUntil: () => {},
    });
  }
  expect(showNotification.mock.calls.map(([, options]) => options.tag)).toEqual(
    ['alert', 'alert:1', 'alert:2']
  );
  let pending: Promise<void> | undefined;
  listeners.message({
    data: { type: 'vk-dismiss', tags: ['alert', 'alert:1'] },
    waitUntil: (promise: Promise<void>) => {
      pending = promise;
    },
  });
  await pending;
  expect(notifications[0].close).toHaveBeenCalledOnce();
  expect(notifications[1].close).toHaveBeenCalledOnce();
  expect(notifications[2].close).not.toHaveBeenCalled();
});
