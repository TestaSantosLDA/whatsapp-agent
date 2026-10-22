import { z } from 'zod';
import { defineTool } from '../tool.js';

/**
 * Turns the agent's final text into a WhatsApp message with reply buttons. The choices are kept
 * in the turn state; the responder builds the interactive message once the text is known.
 */
export const offerChoices = defineTool({
  name: 'offer_choices',
  description:
    'Show tap-to-answer options under your reply, for a question with 2 to 10 short answers (e.g. "Interior ou exterior?"). Up to 3 options become buttons, more become a list. Call it at most once per turn, then write your reply text as usual: the options are attached to it. The customer\'s tap comes back as a normal message with the option title.',
  inputSchema: z.object({
    options: z
      .array(
        z
          .string()
          .min(1)
          .max(24)
          .describe('Option title, max 20 characters for 3 or fewer options, 24 otherwise.'),
      )
      .min(2)
      .max(10),
    list_button: z
      .string()
      .max(20)
      .optional()
      .describe(
        'Label of the button that opens the list, when there are more than 3 options (e.g. "Ver opções").',
      ),
  }),
  async run(input, ctx) {
    ctx.choices = { options: input.options, listButton: input.list_button };
    return { ok: true, shown_as: input.options.length <= 3 ? 'buttons' : 'list' };
  },
});
