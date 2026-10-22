import { z } from 'zod';
import { getVariants, isSpecialTransport } from '../../catalogue/repository.js';
import { orderDraftEmail, type DraftLine } from '../../mail/templates.js';
import { defineTool, ToolError } from '../tool.js';
import { compact, emailContext, findBranch, leadContact, leadsOf, mailerOf } from './business.js';
import { displayTitle } from './product-view.js';

const reasonLabels = {
  special_transport: 'Produto com transporte especial',
  islands_or_abroad: 'Entrega nas ilhas ou no estrangeiro',
  showroom_only: 'Produtos que não estão na loja online',
  other: 'Outro',
} as const;

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        variant_id: z.string().describe('Variant id from search_products or get_product.'),
        quantity: z.number().int().min(1).max(9999).describe('Units as the store sells them.'),
      }),
    )
    .max(30)
    .default([])
    .describe('Catalogue items, with the quantities the customer confirmed.'),
  other_items: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        quantity: z.string().max(60).optional().describe('As the customer said it ("40 m²").'),
      }),
    )
    .max(30)
    .default([])
    .describe(
      'Products not in the online catalogue (showroom only), as the customer described them.',
    ),
  reason: z
    .enum(['special_transport', 'islands_or_abroad', 'showroom_only', 'other'])
    .describe('Why this cannot go through a checkout link.'),
  fulfilment: z.enum(['delivery', 'pickup']),
  delivery_address: z
    .string()
    .max(300)
    .optional()
    .describe('For delivery: street, postal code and town (and island or country).'),
  pickup_branch_id: z.string().optional().describe('For pickup: the branch id.'),
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Customer's name. Omit to use their WhatsApp profile name."),
  email: z.email().optional(),
  nif: z.string().max(20).optional().describe('Tax number (NIF) for the invoice, if given.'),
  notes: z.string().max(1000).optional().describe('Anything else the customer asked for.'),
  summary: z.string().min(1).max(2000).describe('Short summary for the sales team, in pt-PT.'),
});

export const sendOrderDraftTool = defineTool({
  name: 'send_order_draft',
  description: `Pass an order to the sales team when it cannot go through a checkout link: create_checkout_link returned needs_order_draft (special transport), the delivery is to Madeira, the Azores or abroad, or the customer wants products only sold in the showrooms. The team confirms the final price, transport and payment with the customer.

Before calling it: have the items and quantities confirmed by the customer, and know whether it is delivery (full address) or pickup (which branch). Then call it once.

Errors: missing_fields (ask for what is listed), not_found (unknown variant id: search again), unknown_branch.

Returns the items with prices and what to tell the customer: the team will confirm price and transport; nothing is charged or reserved until then.`,
  inputSchema,
  async run(input, ctx) {
    const client = ctx.client;
    const name = input.name ?? ctx.contact.name ?? undefined;
    const missing = [
      ...(input.items.length || input.other_items.length ? [] : ['items or other_items']),
      ...(name ? [] : ['name']),
      ...(input.fulfilment === 'delivery' && !input.delivery_address ? ['delivery_address'] : []),
      ...(input.fulfilment === 'pickup' && !input.pickup_branch_id ? ['pickup_branch_id'] : []),
    ];
    if (missing.length) {
      throw new ToolError(
        'missing_fields',
        `Still missing: ${missing.join(', ')}. Ask the customer, one or two things at a time.`,
      );
    }
    const pickup =
      input.fulfilment === 'pickup' ? findBranch(client, input.pickup_branch_id!) : undefined;
    const branch =
      pickup ?? findBranch(client, client.lead.order_branch ?? client.routing.default_branch);

    // The same variant twice becomes one line with the quantities added up.
    const quantities = new Map<string, number>();
    for (const item of input.items) {
      quantities.set(item.variant_id, (quantities.get(item.variant_id) ?? 0) + item.quantity);
    }
    const rows = await getVariants(ctx.db, client.id, [...quantities.keys()]);
    const unknown = [...quantities.keys()].filter((id) => !rows.some((r) => r.variantId === id));
    if (unknown.length) {
      throw new ToolError('not_found', `Unknown variant id(s): ${unknown.join(', ')}.`);
    }

    let totalCents = 0;
    const items = rows.map((row) => {
      const quantity = quantities.get(row.variantId)!;
      const unitCents = Math.round(Number(row.price) * 100);
      totalCents += unitCents * quantity;
      return {
        variant_id: row.variantId,
        sku: row.sku,
        title: row.title,
        variant: row.variantTitle,
        quantity,
        unit_price_eur: unitCents / 100,
        line_total_eur: (unitCents * quantity) / 100,
        available: row.available,
        special_transport: isSpecialTransport(row),
      };
    });
    const subtotal = items.length ? totalCents / 100 : null;
    const fulfilment = pickup
      ? `Levantamento em ${pickup.name}`
      : `Entrega em ${input.delivery_address}`;

    const lead = await leadsOf(ctx).save({
      client,
      conversationId: ctx.conversation.id,
      contact: leadContact(ctx),
      type: 'order',
      branchId: branch.id,
      fields: compact({
        request_type: 'order',
        name,
        phone: `+${ctx.contact.waId}`,
        email: input.email,
        nif: input.nif,
        reason: input.reason,
        fulfilment: input.fulfilment,
        delivery_address: input.delivery_address,
        pickup_branch: pickup?.id,
        items,
        other_items: input.other_items.length ? input.other_items : undefined,
        subtotal_eur: subtotal,
        notes: input.notes,
        summary: input.summary,
      }),
    });

    const lines: DraftLine[] = [
      ...rows.map((row, i) => ({
        title: displayTitle(row),
        sku: row.sku,
        quantity: items[i]!.quantity,
        unitPriceEur: items[i]!.unit_price_eur,
        lineTotalEur: items[i]!.line_total_eur,
      })),
      ...input.other_items.map((o) => ({
        title: `${o.description}${o.quantity ? ` (${o.quantity})` : ''}`,
        quantity: 1,
      })),
    ];
    await mailerOf(ctx).send(
      orderDraftEmail(emailContext(ctx, branch, name), {
        lines,
        subtotalEur: subtotal,
        fulfilment,
        reason: reasonLabels[input.reason],
        summary: input.summary,
        fields: [
          ['Email', input.email],
          ['NIF', input.nif],
          ['Notas', input.notes],
          [
            'Esgotados online',
            items
              .filter((i) => !i.available)
              .map((i) => i.title)
              .join(', '),
          ],
        ],
      }),
    );

    return {
      ok: true,
      lead_id: lead.id,
      team: branch.name,
      items,
      products_subtotal_eur: subtotal,
      response_time: client.lead.response_time,
      tell_customer: `The order was passed to the ${branch.name} team. They will confirm the final price, the transport cost and how to pay within ${client.lead.response_time}. Nothing is charged or reserved until the customer accepts. The products subtotal (VAT included) excludes transport.`,
    };
  },
});
