// Apply service worker updates immediately so notification deep-link changes
// take effect without needing the app to be fully relaunched twice.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_error) {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || 'Vibe Kanban';
  const options = {
    body: payload.body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: payload.notification_id || payload.deeplink_path || 'vibe-kanban',
    data: {
      deeplinkPath: payload.deeplink_path || '/notifications',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Dismiss already-delivered OS notifications (lock screen / notification
// centre) when the app marks the matching in-app notification as read/seen —
// e.g. the user opened the workspace directly instead of tapping the push.
// The page posts the notification ids, which equal the `tag` set in the push
// handler above (tag = payload.notification_id), so we close any currently
// displayed notification whose tag matches. Running this in the service worker
// keeps it reliable on iOS standalone PWAs, where page-context
// getNotifications() is flaky. Note: this only clears notifications on THIS
// device — iOS forbids a silent push, so a notification sitting on another
// device cannot be cleared remotely.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'vk-dismiss' || !Array.isArray(data.tags)) {
    return;
  }

  const tags = new Set(data.tags.filter((tag) => typeof tag === 'string'));
  if (tags.size === 0) {
    return;
  }

  event.waitUntil(
    self.registration.getNotifications().then((notifications) => {
      for (const notification of notifications) {
        if (tags.has(notification.tag)) {
          notification.close();
        }
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const deeplinkPath = event.notification.data?.deeplinkPath || '/notifications';
  // Take only the PATH and resolve it onto THIS service worker's origin, so a
  // cross-origin deeplink (e.g. the server builds http://localhost:47823/... but
  // the installed app runs on http://vibe-kanban.localhost) still navigates
  // inside the app instead of failing client.navigate() / opening another origin.
  const src = new URL(deeplinkPath, self.location.origin);
  const targetPath = src.pathname + src.search + src.hash;
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin !== self.location.origin) continue;

          await client.focus();
          // Let the app select the destination pane. In split-screen mode an
          // iframe may be the matched client; client.navigate() would then
          // navigate that arbitrary iframe instead of the last active pane.
          client.postMessage({ type: 'vk-navigate', path: targetPath });
          return;
        }

        return self.clients.openWindow(targetUrl);
      })
  );
});
