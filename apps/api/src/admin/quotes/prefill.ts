/**
 * What a new quote starts with (WA-025): the lines, customer and delivery the agent gathered for
 * the lead. Lines come, in this order, from
 *
 * 1. an order draft's catalogue items (send_order_draft) and its items outside the catalogue;
 * 2. the quantity calculator (calculate_quantity) in the lead's conversation: the calculation is
 *    run again from its recorded input, so boxes and prices are the calculator's, at today's
 *    catalogue price, and never read back from what the model wrote. The latest calculation per
 *    product wins;
 * 3. otherwise, one line with the products the agent noted, without a price.
 *
 * Catalogue prices include IVA; quote lines are net, so they are converted with the client's
 * rate (25,00 € → 20,3252 € + 23 %), which gives back the catalogue total exactly.
 */
import { netFromGross, type ClientConfig, type QuoteDraft, type QuoteLine } from '@wa/shared';
import { asc, eq } from 'drizzle-orm';
import { calculateQuantityTool } from '../../agent/tools/calculate-quantity.js';
import type { ToolContext } from '../../agent/tool.js';
import { getVariants, type ProductRow } from '../../catalogue/repository.js';
import type { Db } from '../../db/index.js';
import { agentRuns, contacts, type leads } from '../../db/schema.js';
import { localDate, shortBranchName } from './pdf.js';

type LeadRow = typeof leads.$inferSelect;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

const title = (row: Pick<ProductRow, 'title' | 'variantTitle'>) =>
  row.variantTitle && row.variantTitle !== 'Default Title'
    ? `${row.title} – ${row.variantTitle}`
    : row.title;

/** `days` after today in the client's time zone, YYYY-MM-DD. */
export function addDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Calculations the agent ran in this conversation, oldest first: their recorded input. */
async function calculations(db: Db, conversationId: string): Promise<unknown[]> {
  const runs = await db
    .select({ toolCalls: agentRuns.toolCalls })
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId))
    .orderBy(asc(agentRuns.createdAt));
  return runs.flatMap((r) =>
    (r.toolCalls as { name: string; ok: boolean; input: unknown }[])
      .filter((c) => c.name === calculateQuantityTool.name && c.ok)
      .map((c) => c.input),
  );
}

/** One quote line per product the calculator worked out, with its boxes and box price. */
async function calculatorLines(
  db: Db,
  client: ClientConfig,
  conversationId: string,
  vat: number,
): Promise<QuoteLine[]> {
  const latest = new Map<string, QuoteLine>();
  const ctx = { db, client } as ToolContext;
  for (const raw of await calculations(db, conversationId)) {
    const input = calculateQuantityTool.inputSchema.safeParse(raw);
    if (!input.success) continue;
    try {
      const r = (await calculateQuantityTool.run(input.data, ctx)) as {
        product: { variant_id: string; title: string };
        boxes: number;
        covered_m2: number;
        price_per_box: number;
      };
      latest.delete(r.product.variant_id); // re-inserted last: keeps the order of the latest
      latest.set(r.product.variant_id, {
        variantId: r.product.variant_id,
        sku: null,
        description: `${r.product.title} (${String(r.covered_m2).replace('.', ',')} m²)`,
        quantity: r.boxes,
        unit: 'cx',
        unitPrice: netFromGross(r.price_per_box, vat),
        discountPercent: 0,
        vatPercent: vat,
      });
    } catch {
      // The product left the catalogue or lost its m² per box: nothing to prefill from it.
    }
  }
  return [...latest.values()];
}

export async function prefillQuote(
  db: Db,
  client: ClientConfig,
  lead: LeadRow,
  now: Date,
): Promise<QuoteDraft> {
  const fields = lead.fields as Record<string, unknown>;
  const vat = client.quotes.vat_percent;
  const lines: QuoteLine[] = [];

  // 1. An order draft's items, at today's catalogue price (the stored one if it is gone).
  const items = (Array.isArray(fields['items']) ? fields['items'] : []) as Record<
    string,
    unknown
  >[];
  const rows = await getVariants(
    db,
    client.id,
    items.map((i) => str(i['variant_id'])).filter((v): v is string => !!v),
  );
  for (const item of items) {
    const variantId = str(item['variant_id']);
    const row = rows.find((r) => r.variantId === variantId);
    const quantity = num(item['quantity']);
    if (!quantity) continue;
    const gross = row ? Number(row.price) : (num(item['unit_price_eur']) ?? 0);
    lines.push({
      variantId,
      sku: row?.sku ?? str(item['sku']),
      description: row
        ? title(row)
        : [str(item['title']), str(item['variant'])].filter(Boolean).join(' – ') || 'Produto',
      quantity,
      unit: 'un',
      unitPrice: netFromGross(gross, vat),
      discountPercent: 0,
      vatPercent: vat,
    });
  }
  const others = (Array.isArray(fields['other_items']) ? fields['other_items'] : []) as Record<
    string,
    unknown
  >[];
  for (const o of others) {
    const description = str(o['description']);
    if (!description) continue;
    const said = str(o['quantity']);
    lines.push({
      variantId: null,
      sku: null,
      description: said ? `${description} (${said})` : description,
      quantity: 1,
      unit: 'un',
      unitPrice: 0,
      discountPercent: 0,
      vatPercent: vat,
    });
  }

  // 2. The calculator's quantities for products not already on the quote.
  if (lead.conversationId) {
    for (const line of await calculatorLines(db, client, lead.conversationId, vat)) {
      if (!lines.some((l) => l.variantId && l.variantId === line.variantId)) lines.push(line);
    }
  }
  // Catalogue references for the calculator's lines.
  const missingSku = lines.filter((l) => l.variantId && !l.sku).map((l) => l.variantId!);
  if (missingSku.length) {
    const found = await getVariants(db, client.id, missingSku);
    for (const l of lines) l.sku ??= found.find((r) => r.variantId === l.variantId)?.sku ?? null;
  }

  // 3. What the agent noted, to price by hand.
  const products = str(fields['products']);
  if (!lines.length && products) {
    const area = num(fields['area_m2']);
    lines.push({
      variantId: null,
      sku: null,
      description: products,
      quantity: area ?? 1,
      unit: area ? 'm²' : 'un',
      unitPrice: 0,
      discountPercent: 0,
      vatPercent: vat,
    });
  }

  const [contact] = lead.contactId
    ? await db.select().from(contacts).where(eq(contacts.id, lead.contactId))
    : [];
  const pickup = client.branches.find((b) => b.id === str(fields['pickup_branch']));
  const delivery = str(fields['delivery_address']);
  const fulfilment =
    fields['fulfilment'] === 'pickup' && pickup
      ? `Levantamento em ${shortBranchName(pickup.name)}`
      : delivery
        ? `Entrega em ${delivery}`
        : null;

  return {
    customer: {
      name: str(fields['name']) ?? contact?.name ?? null,
      company: str(fields['company']),
      nif: str(fields['nif']),
      email: str(fields['email']),
      phone: str(fields['phone']) ?? (contact ? `+${contact.waId}` : null),
      address: delivery ?? str(fields['location']),
    },
    lines,
    discount: null,
    validUntil: addDays(localDate(now, client.timezone), client.quotes.validity_days),
    fulfilment,
    notes: null,
  };
}
