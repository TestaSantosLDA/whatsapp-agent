import { describe, expect, it } from 'vitest';
import { loadClients } from '../clients/registry.js';
import type { MessageRow } from '../services/messages.js';
import { splitText, toOutbound } from './format.js';
import { toClaudeMessages } from './history.js';
import { isOpen, localTime, nextOpening } from './hours.js';
import { detectLanguage } from './language.js';
import { testClient } from '../test/helpers.js';
import { buildSystemPrompt } from './prompt.js';

describe('opening hours', () => {
  const branch = { hours: { mon: ['09:00-13:00', '14:00-18:00'], sat: ['10:00-13:00'] } };
  const open = (iso: string) => isOpen(branch as never, new Date(iso), 'Europe/Lisbon');

  it('uses Lisbon time, including summer time', () => {
    expect(localTime(new Date('2026-07-06T08:30:00Z'), 'Europe/Lisbon')).toEqual({
      weekday: 'mon',
      minutes: 9 * 60 + 30,
    });
    expect(open('2026-07-06T08:30:00Z')).toBe(true); // 09:30 summer time
    expect(open('2026-12-07T08:30:00Z')).toBe(false); // 08:30 winter time
  });

  it('is closed at lunch, at closing time and on days without hours', () => {
    expect(open('2026-12-07T13:30:00Z')).toBe(false);
    expect(open('2026-12-07T18:00:00Z')).toBe(false);
    expect(open('2026-12-08T10:00:00Z')).toBe(false); // Tuesday
    expect(open('2026-12-12T10:30:00Z')).toBe(true); // Saturday
  });
});

describe('next opening', () => {
  const branch = {
    hours: {
      mon: ['09:00-13:00', '14:00-18:00'],
      tue: ['09:00-13:00', '14:00-18:00'],
      wed: ['09:00-13:00', '14:00-18:00'],
      fri: ['09:00-13:00', '14:00-18:00'],
      sat: ['10:00-13:00'],
    },
  };
  const next = (iso: string) => nextOpening(branch, new Date(iso), 'Europe/Lisbon');

  it('is the next morning after closing time', () => {
    // Tuesday 22:00 in Lisbon (summer time) → Wednesday 09:00.
    expect(next('2026-10-20T21:00:00Z')).toEqual({
      at: new Date('2026-10-21T08:00:00Z'),
      weekday: 'wed',
      time: '09:00',
      inDays: 1,
    });
  });

  it('is after lunch the same day, and nothing while open', () => {
    expect(next('2026-10-20T12:30:00Z')).toMatchObject({ time: '14:00', inDays: 0 });
    expect(next('2026-10-20T09:00:00Z')).toBeUndefined();
  });

  it('skips closed days and handles the change to winter time', () => {
    // Wednesday evening → Friday (Thursday is closed).
    expect(next('2026-10-21T18:30:00Z')).toMatchObject({ weekday: 'fri', inDays: 2 });
    // Saturday 22:00 → Monday 09:00, after clocks go back on Sunday 25 October.
    expect(next('2026-10-24T21:00:00Z')).toMatchObject({
      at: new Date('2026-10-26T09:00:00Z'),
      weekday: 'mon',
    });
    expect(nextOpening({ hours: {} }, new Date(), 'Europe/Lisbon')).toBeUndefined();
  });
});

describe('language guess', () => {
  it.each([
    ['Olá, bom dia', 'pt-PT'],
    ['Preciso de pavimento para a casa de banho', 'pt-PT'],
    ['Quanto custa?', 'pt-PT'],
    ['Hello, do you have oak flooring?', 'en'],
    ['How much is it', 'en'],
    ['ok', undefined],
    ['👍', undefined],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });
});

describe('history', () => {
  const row = (direction: 'inbound' | 'outbound', text: string) =>
    ({ direction, text, type: 'text' }) as MessageRow;

  it('merges consecutive messages and starts with the customer', () => {
    expect(
      toClaudeMessages([
        row('outbound', 'old reply'),
        row('inbound', 'Olá'),
        row('inbound', 'Têm decks?'),
        row('outbound', 'Temos.'),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Olá' },
          { type: 'text', text: 'Têm decks?' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Temos.' }] },
    ]);
  });
});

describe('history with taps and tool logs', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, n));
  const row = (direction: 'inbound' | 'outbound', text: string, n: number, payload: unknown = {}) =>
    ({ direction, text, type: 'text', createdAt: at(n), payload }) as MessageRow;

  it('replays the id of a tapped list row', () => {
    const tapped = row('inbound', 'Pavimento Vinílico SPC…', 1, {
      interactive: { type: 'list_reply', list_reply: { id: 'product:123', title: 'x' } },
    });
    expect(toClaudeMessages([tapped])[0]!.content).toEqual([
      { type: 'text', text: 'Pavimento Vinílico SPC… [tapped: product:123]' },
    ]);
  });

  it("puts each turn's tool results in a system message before its reply", () => {
    const log = {
      createdAt: at(2),
      toolCalls: [
        { name: 'search_products', input: { query: 'deck' }, ok: true, output: '{"v":"9"}' },
      ],
    };
    const orphan = { createdAt: at(4), toolCalls: [{ name: 'x', input: {}, ok: true }] };
    const msgs = toClaudeMessages(
      [row('inbound', 'Têm decks?', 1), row('outbound', 'Temos.', 3), row('inbound', 'Ok', 5)],
      [log, orphan],
    );
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(msgs[1]!.content).toContain('search_products {"query":"deck"} → {"v":"9"}');
  });
});

describe('outbound formatting', () => {
  it('cuts at the last line break or space when a paragraph break is too early', () => {
    const chunks = splitText(`Olá.\n\n${'palavra '.repeat(600)}`);
    expect(chunks.every((c) => !c.endsWith(' pa') && /palavra$/.test(c))).toBe(true);
  });

  it('splits long text at paragraph boundaries', () => {
    const para = 'x'.repeat(3000);
    expect(splitText(`${para}\n\n${para}`)).toEqual([para, para]);
  });

  it('turns more than three choices into a list and keeps queued cards last', () => {
    const card = { type: 'image', url: 'https://x.test/a.jpg', caption: 'A' } as const;
    const out = toOutbound(
      'Qual prefere?',
      { outbox: [card], choices: { options: ['Carvalho', 'Pinho', 'Ipê', 'Cumaru'] } },
      'pt-PT',
    );
    expect(out[0]).toMatchObject({ type: 'list', body: 'Qual prefere?', button: 'Ver opções' });
    expect(out[1]).toEqual(card);
  });
});

describe('system prompt', () => {
  it('is stable for the Jular config and carries hours, routing and policies', () => {
    const jular = loadClients(new URL('../../../../clients', import.meta.url).pathname).get(
      'jular',
    );
    const prompt = buildSystemPrompt(jular!);
    expect(buildSystemPrompt(jular!)).toBe(prompt);
    expect(prompt).toContain('Mon 08:00-13:00, 14:00-18:00');
    expect(prompt).toContain('Customers in Algarve, Faro → albufeira');
    expect(prompt).toContain('MB Way');
  });

  it('adds the Treehouse playbook with its prices and lead fields', () => {
    const jular = loadClients(new URL('../../../../clients', import.meta.url).pathname).get(
      'jular',
    )!;
    const prompt = buildSystemPrompt(jular);
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('Treehouse SW T2A* €90.412,38');
    expect(prompt).toContain('to be confirmed with the Treehouse team');
    expect(prompt).toContain('request_type "quote" and business_line "casas-modulares"');
    expect(prompt).toContain('- land (required):');
    // The playbook's business line routes to the modular-house branch.
    const rule = jular.routing.rules.find((r) => r.business_line === 'casas-modulares');
    expect(rule?.branch).toBe('azambuja');
  });

  it('has no skills section when the client has none', () => {
    expect(buildSystemPrompt(testClient())).not.toContain('# Skills');
  });
});
