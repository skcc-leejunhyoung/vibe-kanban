export function parseNotificationNavigationPath(path: string) {
  const url = new URL(path, 'http://localhost');
  return {
    pathname: url.pathname,
    search: Object.fromEntries(url.searchParams),
  };
}
