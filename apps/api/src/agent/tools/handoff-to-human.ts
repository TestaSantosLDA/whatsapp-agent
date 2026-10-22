import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { conversations } from '../../db/schema.js';
import { routeBranch } from '../../leads/routing.js';
import { handoffEmail } from '../../mail/templates.js';
import { isOpen, nextOpening, type Opening } from '../hours.js';
import { defineTool } from '../tool.js';
import { emailContext, findBranch, leadContact, leadsOf, mailerOf } from './business.js';

const inputSchema = z.object({
  reason: z
    .enum([
      'customer_asked',
      'complaint',
      'repeated_misunderstanding',
      'needs_decision',
      'large_project',
      'could_not_help',
      'other',
    ])
    .describe('Why a person is needed.'),
  urgency: z
    .enum(['normal', 'high'])
    .default('normal')
    .describe('high: an upset customer, a problem with a delivery today, or a safety issue.'),
  summary: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "What the customer wants and what was already said, in pt-PT, for the colleague. Quote the customer's own words as written when they are not in Portuguese.",
    ),
  branch_id: z
    .string()
    .optional()
    .describe('Branch that should follow up, if known. Otherwise give location or business_line.'),
  location: z.string().max(200).optional().describe("Customer's town or district, if known."),
  business_line: z.string().optional().describe('Business line id, if clear.'),
});

const weekdayNames = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
} as const;

function when(opening: Opening): string {
  const day =
    opening.inDays === 0
      ? 'today'
      : opening.inDays === 1
        ? `tomorrow (${weekdayNames[opening.weekday]})`
        : weekdayNames[opening.weekday];
  return `${day} at ${opening.time}`;
}

/**
 * Hands the conversation to a person (WA-016): the bot stops answering it, a handoff lead is
 * stored and the routed branch gets an email. The result says when the branch opens, so the
 * agent can tell the customer when to expect a reply.
 */
export const handoffToHuman = defineTool({
  name: 'handoff_to_human',
  description: `Hand this conversation to a colleague at the company. Use it when the customer asks for a person or a call, complains or is upset, needs a decision you cannot make (custom prices, damaged goods, invoices, existing orders), you misunderstood them twice, or in the extra situations listed in the system prompt.

The branch is routed from branch_id, or else from location and business line. The colleague gets an email with your summary.

Returns whether the branch is open now and, if not, when it opens next. Tell the customer, in their language, that a colleague will reply here on WhatsApp and when (from tell_customer). After this call you will not answer this customer again until a colleague hands the conversation back.`,
  inputSchema,
  async run(input, ctx) {
    const client = ctx.client;
    const branch = input.branch_id
      ? findBranch(client, input.branch_id)
      : routeBranch(client, { location: input.location, business_line: input.business_line });

    const lead = await leadsOf(ctx).save({
      client,
      conversationId: ctx.conversation.id,
      contact: leadContact(ctx),
      type: 'handoff',
      branchId: branch.id,
      fields: { reason: input.reason, urgency: input.urgency, summary: input.summary },
    });
    await ctx.db
      .update(conversations)
      .set({ status: 'human' })
      .where(eq(conversations.id, ctx.conversation.id));
    ctx.backoffice?.publishStatus(client.id, ctx.contact.waId, 'human');
    await mailerOf(ctx).send(
      handoffEmail(emailContext(ctx, branch), {
        reason: input.reason,
        urgency: input.urgency,
        summary: input.summary,
        fields: [['Localidade', input.location]],
      }),
    );

    const now = ctx.now ?? new Date();
    const open = isOpen(branch, now, client.timezone);
    const opening = open ? undefined : nextOpening(branch, now, client.timezone);
    return {
      ok: true,
      lead_id: lead.id,
      branch: branch.name,
      open_now: open,
      next_opening: opening
        ? { weekday: opening.weekday, time: opening.time, in_days: opening.inDays }
        : null,
      tell_customer: open
        ? `A colleague from ${branch.name} will reply here shortly.`
        : opening
          ? `${branch.name} is closed now. A colleague will reply here after it opens, ${when(opening)}.`
          : `A colleague from ${branch.name} will reply here within ${client.lead.response_time}.`,
    };
  },
});
