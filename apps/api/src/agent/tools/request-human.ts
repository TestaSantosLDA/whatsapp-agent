import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { conversations, leads } from '../../db/schema.js';
import { defineTool, ToolError } from '../tool.js';

/**
 * Hands the conversation to a person: the bot stops answering it and a handoff lead is stored
 * for the branch. WA-016 adds the email to the branch.
 */
export const requestHuman = defineTool({
  name: 'request_human',
  description:
    'Hand this conversation to a colleague at the company. Use it when the customer asks for a person, complains, needs a decision you cannot make, or you could not help. After calling it, tell the customer a colleague will reply (and roughly when, from the lead response time). You will not answer this customer again until a colleague hands the conversation back.',
  inputSchema: z.object({
    reason: z
      .enum(['customer_asked', 'complaint', 'needs_decision', 'could_not_help', 'other'])
      .describe('Why a person is needed.'),
    summary: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        'What the customer wants, in the language of the company (pt-PT), for the colleague.',
      ),
    branch_id: z
      .string()
      .optional()
      .describe('Branch that should follow up, from the routing rules. Omit if unknown.'),
  }),
  async run(input, ctx) {
    const branchId = input.branch_id ?? ctx.client.routing.default_branch;
    const branch = ctx.client.branches.find((b) => b.id === branchId);
    if (!branch) throw new ToolError('unknown_branch', `No branch with id "${branchId}".`);
    const [lead] = await ctx.db
      .insert(leads)
      .values({
        clientId: ctx.client.id,
        conversationId: ctx.conversation.id,
        contactId: ctx.contact.id,
        type: 'handoff',
        branchId,
        fields: { reason: input.reason, summary: input.summary },
      })
      .returning();
    await ctx.db
      .update(conversations)
      .set({ status: 'human' })
      .where(eq(conversations.id, ctx.conversation.id));
    if (lead) ctx.backoffice?.publishLead(ctx.client, ctx.contact.waId, lead);
    ctx.backoffice?.publishStatus(ctx.client.id, ctx.contact.waId, 'human');
    return { ok: true, branch: branch.name, response_time: ctx.client.lead.response_time };
  },
});
