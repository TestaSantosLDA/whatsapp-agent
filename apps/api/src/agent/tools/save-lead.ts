import type { LeadField } from '@wa/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { messages } from '../../db/schema.js';
import { routeBranch } from '../../leads/routing.js';
import { leadEmail, requestTypeLabel } from '../../mail/templates.js';
import { defineTool, ToolError, type ToolContext } from '../tool.js';
import { compact, emailContext, findBranch, leadContact, leadsOf, mailerOf } from './business.js';

const inputSchema = z.object({
  request_type: z
    .string()
    .optional()
    .describe(
      'What the customer wants: one of the request types in the system prompt (info, quote, sample). Orders that cannot use a checkout link go to send_order_draft instead.',
    ),
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Customer's name as they gave it. Omit to use their WhatsApp profile name."),
  email: z.email().optional().describe("Customer's email, only if they gave one."),
  location: z
    .string()
    .max(200)
    .optional()
    .describe('Where the work or delivery is: town and district, e.g. "Loulé, Faro".'),
  business_line: z
    .string()
    .optional()
    .describe('Business line id from the system prompt, when clear from the request.'),
  products: z
    .string()
    .max(2000)
    .optional()
    .describe('Products, variant ids or project the request is about, in a few words.'),
  area_m2: z.number().positive().max(1_000_000).optional().describe('Area in m², if known.'),
  timeline: z
    .string()
    .max(200)
    .optional()
    .describe('When the customer needs it, in their words ("em março", "o mais rápido possível").'),
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "What the colleague needs to know to follow up, in pt-PT. Quote the customer's own words as written when they are not in Portuguese.",
    ),
  branch_id: z
    .string()
    .optional()
    .describe('Only to override the routing, e.g. the customer asked for a specific store.'),
});

type Input = z.infer<typeof inputSchema>;

/** What the agent should ask for, per required field. */
const fieldPrompts: Record<LeadField, string> = {
  name: "name (the customer's name)",
  email: 'email',
  location: 'location (town and district of the work or delivery)',
  request_type: 'request_type (information, a quote or a sample?)',
  business_line: 'business_line (which kind of product or project)',
  products: 'products (which products or what project)',
  area_m2: 'area_m2 (approximate area in m²)',
  timeline: 'timeline (when they need it)',
};

export const saveLeadTool = defineTool({
  name: 'save_lead',
  description: `Register a request for the company's team to follow up: a quote, information or a sample request, typically for professionals, projects, large areas or products not sold online. The phone number is known from WhatsApp. The lead is routed to the right branch (from location and business line), stored, and emailed to that branch's team.

Before calling it: collect the required fields that are still missing, one or two questions at a time (never a form), then repeat the key details back to the customer and get their OK.

Errors: missing_fields lists what is still missing: ask for it (one or two at a time) and call again with everything. invalid_request_type or unknown_business_line: fix the value from the system prompt.

Returns who will contact the customer and the response time from the company's settings: tell the customer exactly that, never a shorter time.`,
  inputSchema,
  async run(input, ctx) {
    const client = ctx.client;
    const name = input.name ?? ctx.contact.name ?? undefined;
    const values: Record<LeadField, unknown> = {
      name,
      email: input.email,
      location: input.location,
      request_type: input.request_type,
      business_line: input.business_line,
      products: input.products,
      area_m2: input.area_m2,
      timeline: input.timeline,
    };
    const missing = client.lead.required_fields.filter(
      (f) => values[f] === undefined || values[f] === '',
    );
    if (missing.length) {
      throw new ToolError(
        'missing_fields',
        `Still missing: ${missing.map((f) => fieldPrompts[f]).join('; ')}. Ask the customer for one or two of these at a time, then call save_lead again with everything.`,
      );
    }
    if (input.request_type && !client.lead.request_types.includes(input.request_type)) {
      throw new ToolError(
        'invalid_request_type',
        `Request type must be one of: ${client.lead.request_types.join(', ')}.`,
      );
    }
    const line = input.business_line
      ? client.business_lines.find((l) => l.id === input.business_line)
      : undefined;
    if (input.business_line && !line) {
      throw new ToolError(
        'unknown_business_line',
        `Business line ids: ${client.business_lines.map((l) => l.id).join(', ')}.`,
      );
    }

    const branch = input.branch_id
      ? findBranch(client, input.branch_id)
      : routeBranch(client, { location: input.location, business_line: input.business_line });
    const requestType = input.request_type ?? client.lead.request_types[0]!;
    const attachments = await conversationAttachments(ctx);
    const fields = compact({
      request_type: requestType,
      name,
      phone: `+${ctx.contact.waId}`,
      email: input.email,
      location: input.location,
      business_line: input.business_line,
      products: input.products,
      area_m2: input.area_m2,
      timeline: input.timeline,
      summary: input.summary,
      attachments: attachments.length ? attachments : undefined,
    });

    const lead = await leadsOf(ctx).save({
      client,
      conversationId: ctx.conversation.id,
      contact: leadContact(ctx),
      type: requestType,
      branchId: branch.id,
      fields,
    });
    await mailerOf(ctx).send(
      leadEmail(emailContext(ctx, branch, name), {
        requestType,
        summary: input.summary,
        fields: emailFields(input, line?.name, requestType),
        attachments: attachments.length,
      }),
    );

    return {
      ok: true,
      lead_id: lead.id,
      branch: branch.name,
      response_time: client.lead.response_time,
      tell_customer: `The request is registered. The ${branch.name} team will contact them within ${client.lead.response_time}. Do not promise a shorter time, a price or a date.`,
    };
  },
});

function emailFields(
  input: Input,
  lineName: string | undefined,
  requestType: string,
): [string, string | number | undefined][] {
  return [
    ['Tipo de pedido', requestTypeLabel(requestType)],
    ['Email', input.email],
    ['Localidade', input.location],
    ['Linha de negócio', lineName],
    ['Produtos / projeto', input.products],
    ['Área', input.area_m2 === undefined ? undefined : `${input.area_m2} m²`],
    ['Prazo', input.timeline],
  ];
}

/** Images and documents the customer sent in this conversation (plans, photos of the site). */
async function conversationAttachments(ctx: ToolContext) {
  const rows = await ctx.db
    .select({ id: messages.channelMessageId, type: messages.type, payload: messages.payload })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, ctx.conversation.id),
        eq(messages.direction, 'inbound'),
        inArray(messages.type, ['image', 'document', 'video']),
      ),
    );
  return rows.map((r) => {
    const media = (r.payload as Record<string, { id?: string; caption?: string } | undefined>)[
      r.type
    ];
    return compact({
      type: r.type,
      message_id: r.id,
      media_id: media?.id,
      caption: media?.caption,
    });
  });
}
