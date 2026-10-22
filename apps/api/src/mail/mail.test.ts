import type { BackofficeEvent } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../bus.js';
import { outbox } from '../db/schema.js';
import { BackgroundTasks } from '../services/background.js';
import { BackofficeService } from '../services/backoffice.js';
import { testDb } from '../test/catalogue.js';
import { testClient } from '../test/helpers.js';
import { OutboxMailer, RedirectMailer, ResendMailer } from './mailer.js';
import { handoffEmail, leadEmail, orderDraftEmail, type EmailContext } from './templates.js';

const client = testClient();
const ctx: EmailContext = {
  client,
  branch: { ...client.branches[0]!, lead_emails: ['lisboa@example.invalid'] },
  contact: { name: 'Ana <Silva>', waId: '351911111111' },
};
const email = leadEmail(ctx, {
  requestType: 'quote',
  summary: 'Customer wrote: "I need 120 m² of decking"',
  fields: [
    ['Localidade', 'Faro'],
    ['Área', '120 m²'],
    ['Prazo', undefined],
  ],
  attachments: 1,
});

async function setup() {
  const handle = await testDb();
  const events: BackofficeEvent[] = [];
  const backoffice = new BackofficeService(handle.db, new EventBus<BackofficeEvent>());
  backoffice.bus.subscribe(EventBus.key(client.id, '351911111111'), (e) => events.push(e));
  return { handle, db: handle.db, backoffice, events };
}

describe('email templates', () => {
  it('carry the customer, the key fields, the summary and the WhatsApp link', () => {
    expect(email.to).toEqual(['lisboa@example.invalid']);
    expect(email.subject).toBe('Pedido de orçamento: Ana <Silva> (WhatsApp)');
    expect(email.text).toContain('Telefone: +351911111111');
    expect(email.text).toContain('Localidade: Faro');
    expect(email.text).not.toContain('Prazo');
    expect(email.text).toContain('Anexos: 1');
    expect(email.text).toContain('"I need 120 m² of decking"');
    expect(email.text).toContain('https://wa.me/351911111111');
    expect(email.html).toContain('href="https://wa.me/351911111111"');
    expect(email.html).toContain('Ana &lt;Silva&gt;');
    expect(email.html).not.toContain('<Silva>');
  });

  it('marks urgent handoffs and lists order lines', () => {
    const handoff = handoffEmail(ctx, { reason: 'complaint', urgency: 'high', summary: 's' });
    expect(handoff.subject).toMatch(/^\[URGENTE\]/);
    expect(handoff.text).toContain('Motivo: Reclamação');
    const draft = orderDraftEmail(ctx, {
      lines: [{ title: 'Viga GL24h', quantity: 2, unitPriceEur: 890, lineTotalEur: 1780 }],
      subtotalEur: 1780,
      fulfilment: 'Entrega em Rua 1, Faro',
      reason: 'Produto com transporte especial',
      summary: 's',
      fields: [],
    });
    expect(draft.kind).toBe('order_draft');
    expect(draft.text).toMatch(/Viga GL24h: 890,00\s€ x 2 = 1780,00\s€/);
  });
});

describe('RedirectMailer (MAIL_REDIRECT_TO)', () => {
  it('sends to the demo address and keeps the intended recipients in the subject', async () => {
    const t = await setup();
    const mailer = new RedirectMailer(new OutboxMailer({ db: t.db, backoffice: t.backoffice }), [
      'demo@example.invalid',
    ]);
    await mailer.send(email);
    const [row] = await t.db.select().from(outbox);
    expect(row?.to).toEqual(['demo@example.invalid']);
    expect(row?.subject).toBe(`[demo → lisboa@example.invalid] ${email.subject}`);
    await t.handle.close();
  });
});

describe('OutboxMailer (demo mode)', () => {
  it('writes the email to the outbox, marked sent, and publishes it', async () => {
    const t = await setup();
    const mailer = new OutboxMailer({ db: t.db, backoffice: t.backoffice });
    await mailer.send(email);
    const [row] = await t.db.select().from(outbox);
    expect(row).toMatchObject({ kind: 'lead', to: ['lisboa@example.invalid'], error: null });
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(t.events).toEqual([{ type: 'email', email: expect.objectContaining({ id: row!.id }) }]);
    await t.handle.close();
  });

  it('records an error when the branch has no recipients', async () => {
    const t = await setup();
    await new OutboxMailer({ db: t.db }).send({ ...email, to: [] });
    const [row] = await t.db.select().from(outbox);
    expect(row).toMatchObject({ sentAt: null, error: expect.stringMatching(/no recipients/) });
    await t.handle.close();
  });
});

describe('ResendMailer', () => {
  function fakeResend(statuses: number[]) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      const status = statuses[requests.length - 1] ?? 500;
      return status === 200
        ? Response.json({ id: 're_123' })
        : new Response('{"message":"boom"}', { status });
    }) as typeof fetch;
    return { fetchFn, requests };
  }

  it('posts to Resend in the background and records sentAt', async () => {
    const t = await setup();
    const resend = fakeResend([200]);
    const mailer = new ResendMailer({
      db: t.db,
      backoffice: t.backoffice,
      apiKey: 're_test',
      fetch: resend.fetchFn,
      background: new BackgroundTasks([0, 0]),
    });
    await mailer.send(email);
    // Queued, not sent yet.
    expect((await t.db.select().from(outbox))[0]?.sentAt).toBeNull();
    await mailer.flush();

    const [req] = resend.requests;
    expect(req?.url).toBe('https://api.resend.com/emails');
    const headers = new Headers(req?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer re_test');
    const [row] = await t.db.select().from(outbox);
    expect(headers.get('idempotency-key')).toBe(row!.id);
    expect(JSON.parse(String(req?.init.body))).toMatchObject({
      from: client.mail.from,
      to: ['lisboa@example.invalid'],
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    // Published on insert, then again once sent.
    expect(t.events.map((e) => e.type === 'email' && e.email.sentAt !== null)).toEqual([
      false,
      true,
    ]);
    await t.handle.close();
  });

  it('retries a failed send, then marks the error on the row without throwing', async () => {
    const t = await setup();
    const resend = fakeResend([500, 503, 422]);
    const mailer = new ResendMailer({
      db: t.db,
      backoffice: t.backoffice,
      apiKey: 're_test',
      fetch: resend.fetchFn,
      background: new BackgroundTasks([0, 0]),
    });
    await expect(mailer.send(email)).resolves.toBeUndefined();
    await mailer.flush();
    expect(resend.requests).toHaveLength(3);
    const [row] = await t.db.select().from(outbox);
    expect(row).toMatchObject({
      sentAt: null,
      error: expect.stringMatching(/Resend answered 422/),
    });
    const last = t.events.at(-1);
    expect(last?.type === 'email' && last.email.error).toMatch(/422/);
    await t.handle.close();
  });

  it('succeeds on a retry', async () => {
    const t = await setup();
    const resend = fakeResend([500, 200]);
    const mailer = new ResendMailer({
      db: t.db,
      apiKey: 're_test',
      fetch: resend.fetchFn,
      background: new BackgroundTasks([0, 0]),
    });
    await mailer.send(email);
    await mailer.flush();
    const [row] = await t.db.select().from(outbox);
    expect(row).toMatchObject({ error: null, sentAt: expect.any(Date) });
    await t.handle.close();
  });

  it('never throws, even when the outbox cannot be written', async () => {
    const t = await setup();
    await t.handle.close();
    const mailer = new ResendMailer({ db: t.db, apiKey: 're_test', fetch: fakeResend([]).fetchFn });
    await expect(mailer.send(email)).resolves.toBeUndefined();
  });
});
