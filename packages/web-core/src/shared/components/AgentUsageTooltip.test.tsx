import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type AgentUsage } from 'shared/types';
import common from '@/i18n/locales/ko/common.json';
import { AgentUsageTooltip } from './AgentUsageTooltip';

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
  updated_at: '2026-10-28T01:00:00Z',
  reset_credits: null,
  next_refresh_at: '2026-10-28T01:05:00Z',
  unavailable: false,
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
        <AgentUsageTooltip agent={agent} name="Agent" hostId={hostId}>
          <span>icon</span>
        </AgentUsageTooltip>
      </QueryClientProvider>
    </I18nextProvider>
  );
  client.clear();
  return html;
}

describe('AgentUsageTooltip', () => {
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
            reset_description: 'resets 2026-11-02 04:48 UTC',
          },
        ],
      },
      BaseCodingAgent.CODEX
    );
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="주간"');
    expect(html).toContain('62%');
    expect(html).toContain('2026-11-02 04:48 UTC');
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
        unavailable: true,
      },
      BaseCodingAgent.CODEX
    );
    expect(html).toContain('리셋권 2개');
    expect(html).toContain('이전 값');
    expect(html).not.toContain('조회 불가');
  });
});
