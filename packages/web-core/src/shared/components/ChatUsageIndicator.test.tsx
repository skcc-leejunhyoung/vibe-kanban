import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type AgentUsage } from 'shared/types';
import common from '@/i18n/locales/ko/common.json';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { ChatUsageIndicator } from './ChatUsageIndicator';

vi.mock('@vibe/ui/components/Tooltip', () => ({
  Tooltip: ({
    children,
    content,
  }: {
    children: ReactNode;
    content: ReactNode;
  }) => (
    <>
      {children}
      {content}
    </>
  ),
}));
vi.mock('@/shared/lib/api', () => ({ agentsApi: { getUsage: vi.fn() } }));
vi.mock('@/shared/providers/HostIdProvider', () => ({ useHostId: () => null }));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'ko', resources: { ko: { common } } });
});

const usage: AgentUsage = {
  windows: [
    {
      label: 'Current session',
      used_percent: 25,
      reset_description: 'resets at 18:00',
    },
    {
      label: 'Current week (all models)',
      used_percent: 60,
      reset_description: null,
    },
    {
      label: 'Current week (Fable)',
      used_percent: 90,
      reset_description: null,
    },
  ],
  updated_at: '2030-01-01T01:00:00Z',
  reset_credits: null,
  reset_credit_expirations: [],
  next_refresh_at: '2030-01-01T01:05:00Z',
  unavailable: false,
  login_required: false,
};

function render(
  data = usage,
  agent = BaseCodingAgent.CLAUDE_CODE,
  hostId: string | null = null
) {
  const client = new QueryClient();
  client.setQueryData(['agentUsage', hostId ?? 'local', agent], data);
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ChatUsageIndicator
          agent={agent}
          hostId={hostId}
          tokenUsageInfo={{ total_tokens: 42000, model_context_window: 200000 }}
        />
      </QueryClientProvider>
    </I18nextProvider>
  );
  client.clear();
  return html;
}

describe('ChatUsageIndicator', () => {
  it('identifies a signed-out host without showing raw CLI diagnostics', () => {
    const html = render({
      ...usage,
      windows: [],
      unavailable: true,
      login_required: true,
    });
    expect(html).toContain('CLI 로그인 필요');
    expect(html).toContain('컨텍스트: 21%');
    expect(html).not.toContain('조회 불가');
  });
  it('shows all three independent Claude limits and their reset information', () => {
    const html = render();
    for (const [label, percent] of [
      ['5시간', 25],
      ['주간', 60],
      ['Fable', 90],
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`aria-valuenow="${percent}"`);
    }
    expect(html).toContain('18:00');
    expect(html).toContain('컨텍스트: 21%');
    expect(html).toContain('42K / 200K');
    expect(html).not.toContain('resets at');
    expect(html).not.toContain('기본 CLI 계정');
    expect(html).not.toContain('리셋권');
    expect(html).not.toContain('조회 ');
    expect(html).not.toContain('재조회');
  });

  it('does not invent an absent model limit or reset-credit count', () => {
    const html = render({ ...usage, windows: usage.windows.slice(0, 2) });
    expect(html).not.toContain('Fable');
    expect(html).not.toContain('리셋권');
  });

  it('keeps the selected host values and stale-data notice', () => {
    const html = render(
      { ...usage, unavailable: true },
      BaseCodingAgent.CLAUDE_CODE,
      'host-b'
    );
    expect(html).toContain('aria-label="Fable"');
    expect(html).toContain('이전 값');
  });

  it('shows only the weekly window when Codex returns no five-hour limit', () => {
    const html = render(
      {
        ...usage,
        windows: [
          {
            label: '7d',
            used_percent: 62,
            reset_description: 'resets 2030-01-03 00:00 UTC',
          },
        ],
      },
      BaseCodingAgent.CODEX
    );
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="주간"');
    expect(html).toContain('62%');
    expect(html).toContain('2030-01-03 00:00 UTC');
    expect(html).not.toContain('5시간');
    expect(html).not.toContain('리셋권');
  });

  it.each([0, 2])(
    'shows a known reset-credit count of %i without extra explanation',
    (count) => {
      const html = render(
        { ...usage, reset_credits: count },
        BaseCodingAgent.CODEX
      );
      expect(html).toContain(`리셋권 ${count}개`);
      expect(html).not.toContain('미제공');
      expect(html).not.toContain('재조회');
    }
  );

  it('marks cached reset credits as stale even without quota windows', () => {
    const html = render(
      {
        ...usage,
        windows: [],
        reset_credits: 2,
        reset_credit_expirations: ['2030-01-01T00:00:00Z'],
        unavailable: true,
      },
      BaseCodingAgent.CODEX
    );
    expect(html).toContain('리셋권 2개');
    expect(html).toContain('이전 값');
    expect(html).not.toContain('조회 불가');
    expect(html).toContain('만료');
  });

  it('groups each supplied expiry without replacing the authoritative total', () => {
    const first = '2030-01-01T00:00:00Z';
    const second = '2030-01-02T00:00:00Z';
    const html = render(
      {
        ...usage,
        reset_credits: 8,
        reset_credit_expirations: [first, first, second, null],
      },
      BaseCodingAgent.CODEX
    );
    expect(html).toContain('리셋권 8개');
    expect(html).toContain(`2개 · ${formatDateShortWithTime(first)} 만료`);
    expect(html).toContain(`1개 · ${formatDateShortWithTime(second)} 만료`);
    expect(html).toContain('1개 · 만료 없음');
    expect(html.match(/2개 · /g)).toHaveLength(1);
  });

  it('does not invent expiry dates when only a reset count is known', () => {
    const legacyUsage = { ...usage, reset_credits: 2 };
    Reflect.deleteProperty(legacyUsage, 'reset_credit_expirations');
    const html = render(legacyUsage, BaseCodingAgent.CODEX);
    expect(html).toContain('리셋권 2개');
    expect(html).not.toContain('만료');
  });
});
