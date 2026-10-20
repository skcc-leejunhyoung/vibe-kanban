import type { CreateHostPreviewResponse } from 'shared/remote-types';
import { accountRequest } from '@/shared/lib/hostAccountApi';
import { requestAccountHost } from '@/shared/lib/accountHostTransport';
import { watchAccountConnectionCleanup } from '@/shared/lib/accountHostConnection';

export interface AccountPreviewExchange {
  url: URL;
  code: string;
}

/** Whether the protected preview host is same-site with this page, so its
 * SameSite=Lax cookie reaches an iframe here. True on the remote web, false on
 * the local web, which keeps the new-tab flow. */
export function canEmbedAccountPreview(
  suffix = (import.meta.env.VITE_RELAY_PREVIEW_HOST_SUFFIX ?? '').trim(),
  page: { hostname: string; protocol: string } = window.location
): boolean {
  const previewSite = suffix.replace(/^\./, '').toLowerCase();
  const pageHost = page.hostname.toLowerCase();
  return (
    page.protocol === 'https:' &&
    previewSite !== '' &&
    (previewSite === pageHost || previewSite.endsWith(`.${pageHost}`))
  );
}

/** Path the exchange redirects to; the relay falls back to `/` otherwise. */
export function accountPreviewNextPath(url: string): string | undefined {
  const { pathname, search } = new URL(url);
  const next = pathname + search;
  return next.length <= 1024 ? next : undefined;
}

/** Report the dev server port, mint a one-time code and check where it may be
 * posted. */
export async function requestAccountPreviewExchange(
  host: string,
  port: number
): Promise<AccountPreviewExchange> {
  const reported = await requestAccountHost(
    host,
    '/api/relay-auth/account/preview-ports',
    { method: 'POST' }
  );
  if (!reported.ok)
    throw new Error('개발 서버의 실행 상태를 확인할 수 없습니다.');
  const result = await accountRequest<{ data: CreateHostPreviewResponse }>(
    `/v1/hosts/${host}/previews`,
    { method: 'POST', body: JSON.stringify({ port }) }
  );
  const url = new URL(result.data.exchange_url);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.startsWith(`p-${port}--${host}.`) ||
    url.pathname !== '/__vk/authorize'
  )
    throw new Error('잘못된 미리보기 출처입니다.');
  return { url, code: result.data.code };
}

/** POST the code from `doc` into `target` (`_self` of a fresh tab, or an
 * iframe name). No token is placed in a URL, iframe src, referrer or browser
 * history; the Origin header is the app's, which the relay checks. */
export function submitAccountPreviewExchange(
  doc: Document,
  { url, code }: AccountPreviewExchange,
  target: string,
  next?: string
): void {
  const form = doc.createElement('form');
  form.method = 'POST';
  form.action = url.toString();
  form.target = target;
  for (const [name, value] of Object.entries({ code, next })) {
    if (value === undefined) continue;
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  doc.body.append(form);
  form.submit();
  form.remove();
}

/** Open synchronously from a user gesture, then POST the short-lived code. */
export async function openAccountPreview(
  host: string,
  port: number
): Promise<void> {
  const target = `vk-preview-${crypto.randomUUID()}`;
  const tab = window.open('', target);
  if (!tab) throw new Error('새 탭 열기를 허용한 후 다시 시도해 주세요.');
  tab.opener = null;
  tab.document.title = '보호된 미리보기 연결 중';
  tab.document.body.textContent = '개발 서버와 접근 권한을 확인하고 있습니다…';
  const remove = watchAccountConnectionCleanup(() => tab.close());
  try {
    const exchange = await requestAccountPreviewExchange(host, port);
    if (tab.closed)
      throw new Error('미리보기 창이 닫혔습니다. 다시 열어 주세요.');
    submitAccountPreviewExchange(tab.document, exchange, '_self');
  } catch (error) {
    tab.close();
    remove();
    throw error;
  }
}
