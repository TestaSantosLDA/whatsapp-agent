import { z } from 'zod';
import { openPrivacyRequest } from '../../privacy/requests.js';
import { defineTool } from '../tool.js';

const inputSchema = z.object({
  request: z
    .enum(['delete', 'export', 'clear_profile'])
    .default('delete')
    .describe(
      'delete: erase their data. export: a copy of the data held about them. clear_profile: stop personalising replies and forget their preferences, keeping the history.',
    ),
  confirmed: z
    .literal(true)
    .describe('Only true after the customer confirmed, in this conversation, what they want.'),
});

/**
 * A customer's request about their personal data (WA-028): opens a privacy request for an admin
 * to approve in the dashboard. Nothing is deleted or sent here; the customer gets a WhatsApp
 * confirmation once the admin has carried it out. Always on, for every client.
 */
export const requestDataDeletion = defineTool({
  name: 'request_data_deletion',
  description: `Open a request about the customer's personal data, for the company's administrator to carry out: deletion ("apague os meus dados", "delete my data"), a copy of their data, or to stop personalising replies.

Before calling, confirm in one short message what they want (for deletion: that their conversations and details will be erased). Call only after they confirm.

Nothing happens at once: an administrator handles it and the customer is told here on WhatsApp when it is done. Use tell_customer from the result; never say the data is already deleted.`,
  inputSchema,
  async run(input, ctx) {
    const { request, existing } = await openPrivacyRequest(ctx.db, {
      clientId: ctx.client.id,
      contactId: ctx.contact.id,
      type: input.request,
      source: 'whatsapp',
    });
    return {
      ok: true,
      request_id: request.id,
      already_open: existing,
      tell_customer: existing
        ? 'This request was already passed to the team. They will confirm here on WhatsApp once it is done.'
        : 'The request was passed to the team. An administrator will handle it and the customer will get a confirmation here on WhatsApp once it is done.',
    };
  },
});
