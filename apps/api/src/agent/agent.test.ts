import { describe, expect, it } from 'vitest';
import { loadClients } from '../clients/registry.js';
import type { MessageRow } from '../services/messages.js';
import { splitText, toOutbound } from './format.js';
import { toClaudeMessages } from './history.js';
import { isOpen, localTime } from './hours.js';
import { detectLanguage } from './language.js';
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

describe('outbound formatting', () => {
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
});
