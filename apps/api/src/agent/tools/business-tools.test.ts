import type { BackofficeEvent, ClientConfig } from '@wa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../bus.js';
import { loadClients } from '../../clients/registry.js';
import { contacts, conversations, leads, outbox } from '../../db/schema.js';
import type { DbHandle } from '../../db/index.js';
import { LeadSinks } from '../../leads/sink.js';
import { OutboxMailer } from '../../mail/mailer.js';
import { BackofficeService } from '../../services/backoffice.js';
import { seedCatalogue, shopClient, testDb, V } from '../../test/catalogue.js';
import { ToolError, type AgentTool, type ToolContext } from '../tool.js';
import { handoffToHuman } from './handoff-to-human.js';
import { saveLeadTool } from './save-lead.js';
import { sendOrderDraftTool } from './send-order-draft.js';

const jular = loadClients(new URL('../../../../../clients', import.meta.url).pathname).get(
  'jular',
)!;
const PHONE = '351911111111';

let handle: DbHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

/** A tool context backed by real contact and conversation rows, with the back-office wired. */
async function context(client: ClientConfig, now?: Date) {
  handle = await testDb();
  const db = handle.db;
  const [contact] = await db
    .insert(contacts)
    .values({ clientId: client.id, waId: PHONE, name: 'Ana' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ clientId: client.id, contactId: contact!.id })
    .returning();
  const events: BackofficeEvent[] = [];
  const backoffice = new BackofficeService(db, new EventBus<BackofficeEvent>());
  backoffice.bus.subscribe(EventBus.key(client.id, PHONE), (e) => events.push(e));
  const ctx: ToolContext = {
    db,
    client,
    contact: contact!,
    conversation: conversation!,
    outbox: [],
    backoffice,
    leads: new LeadSinks({ db, backoffice }),
    mailer: new OutboxMailer({ db, backoffice }),
    now,
  };
  return { ctx, db, events };
}

function call<T extends AgentTool>(tool: T, input: unknown, ctx: ToolContext) {
  return tool.run(tool.inputSchema.parse(input), ctx) as Promise<Record<string, unknown>>;
}

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe('save_lead', () => {
  it('lists the missing required fields so the agent can ask for them', async () => {
    const { ctx, db } = await context(jular);
    const error = await toolError(call(saveLeadTool, { summary: 'Quer um deck.' }, ctx));
    expect(error.code).toBe('missing_fields');
    expect(error.message).toMatch(/location .*request_type/);
    // The WhatsApp profile name counts as the name.
    expect(error.message).not.toMatch(/\bname\b/);
    expect(await db.select().from(leads)).toEqual([]);
  });

  it('routes a decking quote in Faro to Albufeira, stores it, emails the branch', async () => {
    const { ctx, db, events } = await context(jular);
    const result = await call(
      saveLeadTool,
      {
        request_type: 'quote',
        name: 'Ana Silva',
        location: 'Faro',
        business_line: 'madeiras-revestimentos',
        products: 'Deck de pinho tratado',
        area_m2: 120,
        summary: 'Pede orçamento para 120 m² de deck em Faro.',
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      branch: 'Sul (Albufeira)',
      response_time: 'um dia útil',
      tell_customer: expect.stringContaining('um dia útil'),
    });

    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({
      type: 'quote',
      branchId: 'albufeira',
      conversationId: ctx.conversation.id,
      fields: expect.objectContaining({ name: 'Ana Silva', area_m2: 120, phone: `+${PHONE}` }),
    });
    const [email] = await db.select().from(outbox);
    expect(email).toMatchObject({
      kind: 'lead',
      to: ['albufeira@example.invalid'],
      conversationId: ctx.conversation.id,
    });
    expect(email?.body).toContain('Área: 120 m²');
    expect(email?.body).toContain(`https://wa.me/${PHONE}`);
    expect(events.map((e) => e.type)).toEqual(['lead', 'email']);
  });

  it('rejects an unknown request type or business line', async () => {
    const { ctx } = await context(jular);
    const base = { name: 'Ana', location: 'Porto', summary: 's' };
    expect(
      (await toolError(call(saveLeadTool, { ...base, request_type: 'visit' }, ctx))).code,
    ).toBe('invalid_request_type');
    expect(
      (
        await toolError(
          call(saveLeadTool, { ...base, request_type: 'info', business_line: 'x' }, ctx),
        )
      ).code,
    ).toBe('unknown_business_line');
  });
});

describe('handoff_to_human', () => {
  it('hands over at 22:00 and says the branch opens at 09:00 the next day', async () => {
    // Tuesday 20 October 2026, 22:00 in Lisbon.
    const { ctx, db, events } = await context(jular, new Date('2026-10-20T21:00:00Z'));
    const result = await call(
      handoffToHuman,
      { reason: 'customer_asked', summary: 'Quer falar com alguém sobre uma encomenda.' },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      branch: expect.stringContaining('Camarate'),
      open_now: false,
      next_opening: { weekday: 'wed', time: '09:00', in_days: 1 },
      tell_customer: expect.stringContaining('tomorrow (Wednesday) at 09:00'),
    });
    const [conv] = await db.select().from(conversations);
    expect(conv?.status).toBe('human');
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({ type: 'handoff', branchId: 'camarate' });
    const [email] = await db.select().from(outbox);
    expect(email).toMatchObject({ kind: 'handoff', to: ['camarate@example.invalid'] });
    expect(events.map((e) => e.type)).toEqual(['lead', 'conversation', 'email']);
    expect(events[1]).toEqual({ type: 'conversation', status: 'human' });
  });

  it('routes by business line and says a colleague replies shortly when open', async () => {
    // Tuesday 20 October 2026, 10:00 in Lisbon.
    const { ctx } = await context(jular, new Date('2026-10-20T09:00:00Z'));
    const result = await call(
      handoffToHuman,
      {
        reason: 'large_project',
        urgency: 'high',
        summary: 'Pavilhão em Kerto.',
        business_line: 'engenharia-estruturas',
      },
      ctx,
    );
    expect(result).toMatchObject({ open_now: true, branch: expect.stringContaining('Azambuja') });
  });
});

describe('send_order_draft', () => {
  it('stores a special-transport order as an order lead and emails the draft', async () => {
    const client = shopClient();
    const { ctx, db } = await context(client);
    await seedCatalogue(db, client);
    const result = await call(
      sendOrderDraftTool,
      {
        items: [{ variant_id: V.beam, quantity: 2 }],
        reason: 'special_transport',
        fulfilment: 'delivery',
        delivery_address: 'Rua das Flores 1, 8000-000 Faro',
        summary: '2 vigas GL24h de 12 m para Faro.',
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      products_subtotal_eur: 1780,
      items: [
        expect.objectContaining({ variant_id: V.beam, quantity: 2, special_transport: true }),
      ],
      tell_customer: expect.stringContaining('transport'),
    });
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({ type: 'order', branchId: 'lisboa' });
    const [email] = await db.select().from(outbox);
    expect(email?.kind).toBe('order_draft');
    expect(email?.body).toContain('Entrega em Rua das Flores 1, 8000-000 Faro');
    expect(email?.body).toMatch(/1780,00/);
  });

  it('asks for the address or pickup branch and rejects unknown variants', async () => {
    const client = shopClient();
    const { ctx, db } = await context(client);
    await seedCatalogue(db, client);
    const items = [{ variant_id: V.beam, quantity: 1 }];
    const base = { items, reason: 'special_transport', summary: 's' };
    expect(
      (await toolError(call(sendOrderDraftTool, { ...base, fulfilment: 'delivery' }, ctx))).message,
    ).toMatch(/delivery_address/);
    expect(
      (await toolError(call(sendOrderDraftTool, { ...base, fulfilment: 'pickup' }, ctx))).message,
    ).toMatch(/pickup_branch_id/);
    expect(
      (
        await toolError(
          call(
            sendOrderDraftTool,
            {
              ...base,
              items: [{ variant_id: '1', quantity: 1 }],
              fulfilment: 'pickup',
              pickup_branch_id: 'lisboa',
            },
            ctx,
          ),
        )
      ).code,
    ).toBe('not_found');
    const pickup = await call(
      sendOrderDraftTool,
      { ...base, fulfilment: 'pickup', pickup_branch_id: 'lisboa' },
      ctx,
    );
    expect(pickup.team).toBe('Lisboa');
  });
});
