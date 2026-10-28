import { beforeAll, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/i18n/locales/en/settings.json';
import ko from '@/i18n/locales/ko/settings.json';
import type { AutomationConnector } from '@/shared/lib/automationWorker';
import { GithubReviewScope } from './GithubReviewScope';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: { en: { settings: en }, ko: { settings: ko } },
  });
});
const connector: AutomationConnector = {
  id: 'github',
  name: 'My GitHub',
  type: 'github',
  enabled: true,
  config: {
    owner: 'example',
    repo: 'app',
    reviewPrs: true,
    reviewRepositories: ['example/app', 'example/search'],
  },
};
function render(c = connector, enabled = true, busy = false) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(GithubReviewScope, {
        connector: c,
        workerEnabled: enabled,
        busy,
        onEdit: () => {},
      })
    )
  );
}

test('shows selected repositories, explicit unmonitored scope and an edit path', () => {
  const html = render();
  expect(html).toContain(
    'Review requests monitored: example/app, example/search'
  );
  expect(html).toContain('Repositories outside this list are not monitored');
  expect(html).toContain('Edit monitored repositories');
  expect(html).not.toContain('org:example');
  expect(render(connector, false, true)).toContain('None (disabled)');
  expect(render(connector, true, true)).toContain('disabled=');
});

test('renders unreadable heads, target repair failures and isolated activity errors safely', () => {
  const html = render({
    ...connector,
    config: {
      ...connector.config,
      prCommentErrors: [
        { repository: 'example/search', error: 'Activity 403' },
      ],
      reviewPrReconciliation: {
        checkedAt: '2026-10-28T00:00:00Z',
        complete: false,
        open: [
          {
            repository: 'example/search',
            number: 42,
            headSha: null,
            targets: [
              {
                ruleId: 'import',
                connectorId: 'intended-target',
                projectId: 'project',
                issueId: 'issue',
                ready: false,
                error: '<script>unsafe</script>',
              },
            ],
          },
        ],
        missing: [
          {
            repository: 'example/search',
            number: 42,
            status: 'link_pending',
          },
        ],
        errors: [
          {
            repository: 'example/search',
            number: 42,
            error: 'Head API 503',
          },
        ],
      },
    },
  });
  expect(html).toContain('example/search#42');
  expect(html).toContain('Untracked or unlinked: 1');
  expect(html).toContain('intended-target');
  expect(html).toContain('Activity 403');
  expect(html).toContain('Head API 503');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

test('uses the primary repository for legacy config and translates the scope in Korean', async () => {
  await i18n.changeLanguage('ko');
  const html = render({
    ...connector,
    config: { owner: 'example', repo: 'app', reviewPrs: true },
  });
  expect(html).toContain('리뷰 요청 감시 저장소: example/app');
  expect(html).toContain('목록 밖 저장소의 리뷰 요청은 감시하지 않습니다.');
  expect(html).toContain('감시 저장소 편집');
});
