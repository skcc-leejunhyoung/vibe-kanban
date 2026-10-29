import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Notification } from 'shared/remote-types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { dismissDeliveredPushNotifications } from '@/shared/lib/webPush';
import { useNotifications } from './useNotifications';

const shape = vi.hoisted(() => ({
  data: [] as Notification[],
  updateMany: vi.fn(),
}));
vi.mock('@/shared/integrations/electric/hooks', () => ({
  useShape: () => shape,
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true, userId: 'synthetic-owner' }),
}));
vi.mock('@/shared/lib/webPush', async (original) => ({
  ...(await original<typeof import('@/shared/lib/webPush')>()),
  dismissDeliveredPushNotifications: vi.fn(),
}));

let dom: ReturnType<typeof installDomlessReact>;
let latest: ReturnType<typeof useNotifications>;
function Probe() {
  latest = useNotifications();
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  dom = installDomlessReact();
  const user: Notification = {
    id: 'synthetic-alert',
    revision: 2,
    intent: 'raw_event',
    routing_state: 'user',
    source_key: null,
    organization_id: 'synthetic-org',
    user_id: 'synthetic-owner',
    notification_type: 'workspace_task_completed',
    payload: {},
    issue_id: null,
    comment_id: null,
    seen: false,
    dismissed_at: null,
    created_at: '2026-01-01T00:00:00Z',
  };
  shape.data = [
    user,
    { ...user, id: 'synthetic-held', routing_state: 'autopilot_pending' },
  ];
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

it('filters held rows and dismisses only after the read persists', async () => {
  let accept = () => {};
  const persisted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  shape.updateMany.mockReturnValue({ persisted });
  await dom.render(<Probe />);
  expect(latest.data.map((n) => n.id)).toEqual(['synthetic-alert']);
  const mutation = latest.updateMany([
    { id: 'synthetic-alert', changes: { seen: true } },
  ]);
  expect(dismissDeliveredPushNotifications).not.toHaveBeenCalled();
  accept();
  await mutation.persisted;
  expect(dismissDeliveredPushNotifications).toHaveBeenCalledWith([
    'synthetic-alert',
    'synthetic-alert:2',
  ]);
});

it('keeps the native banner when the read is rejected as stale', async () => {
  let rejectRead: (error: Error) => void = () => {};
  const persisted = new Promise<void>((_, reject) => {
    rejectRead = reject;
  });
  shape.updateMany.mockReturnValue({ persisted });
  await dom.render(<Probe />);
  const mutation = latest.updateMany([
    { id: 'synthetic-alert', changes: { seen: true } },
  ]);
  rejectRead(new Error('synthetic revision conflict'));
  await expect(mutation.persisted).rejects.toThrow('revision conflict');
  expect(dismissDeliveredPushNotifications).not.toHaveBeenCalled();
});
it('rejects a read from an older rendered revision after the collection has advanced', async () => {
  await dom.render(<Probe />);
  const currentCollectionRevision = 3;
  shape.updateMany.mockImplementation((updates, metadata) => {
    // The collection uses the captured metadata before its current row revision.
    const expected =
      metadata?.notificationRevisions[updates[0].id] ??
      currentCollectionRevision;
    return {
      persisted:
        expected === currentCollectionRevision
          ? Promise.resolve()
          : Promise.reject(new Error('revision conflict')),
    };
  });
  const mutation = latest.updateMany([
    { id: 'synthetic-alert', changes: { seen: true } },
  ]);
  await expect(mutation.persisted).rejects.toThrow('revision conflict');
});
