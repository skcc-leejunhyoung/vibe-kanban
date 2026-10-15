import type { CreateHostPreviewResponse } from 'shared/remote-types';
import { accountRequest } from '@/shared/lib/hostAccountApi';
import { requestAccountHost } from '@/shared/lib/accountHostTransport';
import { watchAccountConnectionCleanup } from '@/shared/lib/accountHostConnection';

/** Open synchronously from a user gesture, then POST the short-lived code. No
 * token is placed in a URL, iframe src, referrer or browser history. */
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
    if (tab.closed)
      throw new Error('미리보기 창이 닫혔습니다. 다시 열어 주세요.');
    const form = tab.document.createElement('form');
    form.method = 'POST';
    form.action = url.toString();
    form.target = '_self';
    const code = tab.document.createElement('input');
    code.type = 'hidden';
    code.name = 'code';
    code.value = result.data.code;
    form.append(code);
    tab.document.body.append(form);
    form.submit();
    form.remove();
  } catch (error) {
    tab.close();
    remove();
    throw error;
  }
}
