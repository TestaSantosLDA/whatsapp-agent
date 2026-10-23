import { isSensitiveText, profileValueSchemas } from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { noteFromAgent, profilingState } from '../../customers/profile.js';
import { ensureCustomer } from '../../customers/records.js';
import { messages } from '../../db/schema.js';
import { defineTool, ToolError } from '../tool.js';

const v = profileValueSchemas;

/**
 * Only the listed fields, each with its own closed set of values (strict: anything else is
 * refused). `price_tier` is not here: the team sets it.
 */
const inputSchema = z
  .object({
    detail_level: v.detail_level
      .optional()
      .describe('short: wants quick answers (a price, a yes). full: wants explanations.'),
    technical_depth: v.technical_depth
      .optional()
      .describe('basic: plain words. technical: specs, technical terms, standards.'),
    language: v.language
      .optional()
      .describe('Only if they asked to be served in a language, e.g. "en".'),
    usual_products: v.usual_products
      .optional()
      .describe(
        'Products they buy again, with the variant id when known and the typical quantity in their words ("200 m²"). Added to the ones already noted.',
      ),
    job_types: v.job_types
      .optional()
      .describe('Kinds of jobs they do, a few words each ("decks", "soalhos", "coberturas").'),
    delivery: v.delivery
      .optional()
      .describe('site: asks for delivery on site. pickup: picks up at a branch.'),
    negotiates_on_volume: v.negotiates_on_volume
      .optional()
      .describe('true when they ask for a better price on volume.'),
    evidence: z
      .string()
      .trim()
      .min(2)
      .max(160)
      .describe(
        "The customer's own words in this conversation that show it, copied exactly (a few words).",
      ),
  })
  .strict();

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[«»"“”'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Notes a customer's factual service preferences in their profile (WA-027), so later
 * conversations serve them the way they like. Only the listed fields; never a field the team set
 * or locked; nothing when profiling is off for the customer. On for clients with
 * `profiling.enabled`.
 */
export const noteProfile = defineTool({
  name: 'note_profile',
  description: `Note a factual service preference the customer stated, so future conversations serve them the way they like: how much detail they want, how technical, the language they asked for, the products and quantities they usually buy, the kinds of jobs they do, delivery on site or pickup, whether they negotiate on volume.

Only these fields, only facts the customer said or showed in this conversation, and evidence copied from their own words. Never note health, family, religion, politics, origin, finances, age, or opinions about the person: the tool refuses them.

Call it quietly alongside your reply; never tell the customer you noted anything. Do not call it when the turn context says profiling is off.

Returns saved (fields written) and kept_by_team (fields the team set or locked: leave them).`,
  inputSchema,
  async run(input, ctx) {
    const { evidence, ...values } = input;
    if (!ctx.client.profiling.enabled) {
      throw new ToolError('profiling_off', 'Profiling is not used for this company.');
    }
    if (Object.values(values).every((x) => x === undefined)) {
      throw new ToolError('nothing_to_note', 'Give at least one field.');
    }
    const customerId = await ensureCustomer(ctx.db, ctx.client.id, ctx.contact.id);
    if (!customerId) throw new ToolError('not_found', 'Unknown customer.');
    if ((await profilingState(ctx.db, ctx.client, customerId)) !== 'on') {
      throw new ToolError(
        'profiling_off',
        'The customer objected to profiling: do not note preferences. Answer them normally.',
      );
    }
    if (isSensitiveText(evidence)) {
      throw new ToolError(
        'not_allowed',
        'That is not a service preference. Never note health, beliefs, origin, family, finances, age or opinions about the person.',
      );
    }
    const said = await ctx.db
      .select({ text: messages.text })
      .from(messages)
      .where(
        and(eq(messages.conversationId, ctx.conversation.id), eq(messages.direction, 'inbound')),
      );
    const words = fold(evidence);
    if (!said.some((m) => m.text && fold(m.text).includes(words))) {
      throw new ToolError(
        'evidence_not_found',
        "The evidence must be the customer's own words from this conversation, copied exactly. Call again with a few words they wrote.",
      );
    }
    const result = await noteFromAgent(ctx.db, {
      clientId: ctx.client.id,
      customerId,
      conversationId: ctx.conversation.id,
      values,
      evidence,
      now: ctx.now,
    });
    return {
      ok: true,
      saved: result.saved,
      kept_by_team: result.kept,
      ...(result.rejected.length ? { rejected: result.rejected } : {}),
    };
  },
});
