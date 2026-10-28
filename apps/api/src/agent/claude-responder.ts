import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError as SdkToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import type {
  BetaMessage,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ClientConfig } from '@wa/shared';
import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import type { OutboundMessage } from '../channels/channel.js';
import type { Db } from '../db/index.js';
import { LeadSinks } from '../leads/sink.js';
import { OutboxMailer, type Mailer } from '../mail/mailer.js';
import type { BackofficeService } from '../services/backoffice.js';
import { agentRuns, contacts, conversations, messages } from '../db/schema.js';
import type { Responder, TurnInput } from '../jobs/process-conversation.js';
import { PermanentJobError } from '../queue/queue.js';
import { toOutbound } from './format.js';
import { toClaudeMessages, type TurnLog } from './history.js';
import { detectLanguage } from './language.js';
import { estimateCost, type Usage } from './pricing.js';
import { buildSystemPrompt, turnContext } from './prompt.js';
import { ToolError, type AgentTool, type ToolContext } from './tool.js';
import { offerChoices } from './tools/offer-choices.js';
import { handoffToHuman } from './tools/handoff-to-human.js';
import { requestDataDeletion } from './tools/request-data-deletion.js';
import { noteProfile } from './tools/note-profile.js';
import { customerTurnContext } from '../customers/context.js';

/** Tools every client gets. The rest are enabled per client in config `tools:`. */
const coreTools: AgentTool[] = [offerChoices, handoffToHuman, requestDataDeletion];

/** Asking for a person always reaches one, even if the model forgets to call handoff_to_human. */
const askForHuman =
  /\b(falar|conversar)\s+com\s+(uma?\s+)?(pessoa|humano|colega|algu[eé]m|funcion[aá]rio|comercial)|\b(talk|speak)\s+to\s+(a\s+)?(human|person|someone|agent)/i;

/** History is replayed in blocks of this many messages, so the cached prefix moves rarely. */
const HISTORY_BLOCK = 100;

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  /** The JSON result Claude saw, shortened. Replayed in later turns. */
  output?: string;
  error?: string;
  ms: number;
}

/** Longest tool result kept for later turns; search results are well under it. */
const LOG_OUTPUT_MAX = 3000;

/**
 * The agent (WA-009): one Claude tool-runner loop per customer turn. Claude sees the client's
 * frozen system prompt and tools (cached), the conversation so far, and a short system message
 * with this turn's facts (time, open branches, first contact).
 */
export class ClaudeResponder implements Responder {
  private readonly systemPrompts = new Map<string, { config: ClientConfig; prompt: string }>();
  private readonly leads: LeadSinks;
  private readonly mailer: Mailer;

  constructor(
    private readonly deps: {
      db: Db;
      anthropic: Anthropic;
      /** Tools that clients can enable by name. */
      tools: AgentTool[];
      now?: () => Date;
      maxIterations?: number;
      backoffice?: BackofficeService;
      /** Default: the database only. */
      leads?: LeadSinks;
      /** Default: the outbox only (demo mode). */
      mailer?: Mailer;
    },
  ) {
    this.leads = deps.leads ?? new LeadSinks({ db: deps.db, backoffice: deps.backoffice });
    this.mailer = deps.mailer ?? new OutboxMailer({ db: deps.db, backoffice: deps.backoffice });
  }

  async respond({
    client,
    conversation,
    contact,
    newMessages,
  }: TurnInput): Promise<OutboundMessage[]> {
    const started = Date.now();
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const calls: ToolCallRecord[] = [];
    const record = async (error?: string) => {
      const [row] = await this.deps.db
        .insert(agentRuns)
        .values({
          clientId: client.id,
          conversationId: conversation.id,
          model: client.model.id,
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costUsd: estimateCost(client.model.id, usage)?.toFixed(6),
          toolCalls: calls,
          latencyMs: Date.now() - started,
          error,
        })
        .returning();
      if (row) this.deps.backoffice?.publishTurn(client.id, contact.waId, row);
    };

    try {
      contact = await this.updateLanguage(contact, newMessages);
      const now = this.deps.now?.() ?? new Date();
      const ctx: ToolContext = {
        db: this.deps.db,
        client,
        conversation,
        contact,
        outbox: [],
        backoffice: this.deps.backoffice,
        leads: this.leads,
        mailer: this.mailer,
        now,
      };
      const runner = this.deps.anthropic.beta.messages.toolRunner({
        model: client.model.id,
        max_tokens: 16000,
        system: [
          { type: 'text', text: this.systemPrompt(client), cache_control: { type: 'ephemeral' } },
        ],
        tools: this.toolsFor(client).map((tool) => this.wrap(tool, ctx, calls)),
        messages: await this.buildMessages(client, conversation.id, contact, now),
        output_config: { effort: client.model.effort },
        // On a policy refusal, retry on the model's default fallback instead of failing the turn.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        max_iterations: this.deps.maxIterations ?? 8,
      });

      let final: BetaMessage | undefined;
      // Claude sometimes writes the reply next to a tool call (offer_choices) and then ends the
      // turn with no text: the reply is the last text it wrote in this turn.
      let lastText = '';
      const textOf = (m: BetaMessage) =>
        m.content
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join('\n\n')
          .trim();
      for await (const message of runner) {
        final = message;
        lastText = textOf(message) || lastText;
        usage.inputTokens += message.usage.input_tokens;
        usage.outputTokens += message.usage.output_tokens;
        usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      }
      const text = lastText;
      if (!final || final.stop_reason === 'refusal' || (!text && ctx.outbox.length === 0)) {
        const reason = `agent produced no reply (stop_reason ${final?.stop_reason ?? 'none'})`;
        // A refusal that survived the fallback will refuse again: hand over now, do not retry.
        throw final?.stop_reason === 'refusal' ? new PermanentJobError(reason) : new Error(reason);
      }
      const said = newMessages.map((m) => m.text ?? '').join('\n');
      if (askForHuman.test(said) && !calls.some((c) => c.name === handoffToHuman.name && c.ok)) {
        await handoffToHuman.run(
          { reason: 'customer_asked', urgency: 'normal', summary: said.slice(0, 1000) },
          ctx,
        );
        calls.push({ name: handoffToHuman.name, input: { forced: true }, ok: true, ms: 0 });
      }
      await record();
      return toOutbound(text, ctx, contact.language ?? client.default_language);
    } catch (error) {
      await record(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Drops a client's cached system prompt; the next turn builds it from the current config. */
  invalidate(clientId: string): void {
    this.systemPrompts.delete(clientId);
  }

  /**
   * Built once per client and config: a settings change (WA-022) hands in a new config object,
   * which rebuilds the prompt even if `invalidate` was not called.
   */
  private systemPrompt(client: ClientConfig): string {
    const cached = this.systemPrompts.get(client.id);
    if (cached?.config === client) return cached.prompt;
    const prompt = buildSystemPrompt(client);
    this.systemPrompts.set(client.id, { config: client, prompt });
    return prompt;
  }

  /** Core tools plus the client's enabled ones, sorted by name so the cached prefix is stable. */
  private toolsFor(client: ClientConfig): AgentTool[] {
    const byName = new Map(this.deps.tools.map((t) => [t.name, t]));
    const enabled = client.tools.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Client "${client.id}" enables unknown tool "${name}"`);
      return tool;
    });
    // WA-027: note_profile for clients with profiling on (fixed per client, so the cache holds).
    const core = client.profiling.enabled ? [...coreTools, noteProfile] : coreTools;
    return [...core, ...enabled].sort((a, b) => a.name.localeCompare(b.name));
  }

  private wrap(tool: AgentTool, ctx: ToolContext, calls: ToolCallRecord[]) {
    return betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (input) => {
        const t0 = Date.now();
        try {
          const output = JSON.stringify(await tool.run(input, ctx));
          calls.push({
            name: tool.name,
            input,
            ok: true,
            output: output.length > LOG_OUTPUT_MAX ? `${output.slice(0, LOG_OUTPUT_MAX)}…` : output,
            ms: Date.now() - t0,
          });
          return output;
        } catch (error) {
          const expected = error instanceof ToolError;
          const message = error instanceof Error ? error.message : String(error);
          calls.push({ name: tool.name, input, ok: false, error: message, ms: Date.now() - t0 });
          if (!expected) console.error(`[agent] tool ${tool.name} failed`, error);
          // Claude gets an error result and explains it to the customer; the turn goes on.
          throw new SdkToolError(
            JSON.stringify(
              expected
                ? { error: error.code, message }
                : {
                    error: 'internal_error',
                    message: 'The tool failed. Do not retry it; offer a colleague instead.',
                  },
            ),
          );
        }
      },
    });
  }

  private async updateLanguage(
    contact: TurnInput['contact'],
    newMessages: TurnInput['newMessages'],
  ) {
    const guess = detectLanguage(newMessages.map((m) => m.text ?? '').join(' '));
    if (!guess || guess === contact.language) return contact;
    await this.deps.db.update(contacts).set({ language: guess }).where(eq(contacts.id, contact.id));
    return { ...contact, language: guess };
  }

  private async buildMessages(
    client: ClientConfig,
    conversationId: string,
    contact: TurnInput['contact'],
    now: Date,
  ): Promise<BetaMessageParam[]> {
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const start =
      Math.floor(Math.max(0, rows.length - HISTORY_BLOCK) / HISTORY_BLOCK) * HISTORY_BLOCK;
    const window = rows.slice(start);
    const logs: TurnLog[] = window[0]
      ? (
          await this.deps.db
            .select({ createdAt: agentRuns.createdAt, toolCalls: agentRuns.toolCalls })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.conversationId, conversationId),
                isNull(agentRuns.error),
                gte(agentRuns.createdAt, window[0].createdAt),
              ),
            )
            .orderBy(asc(agentRuns.createdAt))
        ).map((r) => ({ createdAt: r.createdAt, toolCalls: r.toolCalls as TurnLog['toolCalls'] }))
      : [];
    const history = toClaudeMessages(window, logs);

    // Cache everything up to the customer's latest message; the next turn reads it back.
    const lastBlock = history.at(-1)?.content;
    if (Array.isArray(lastBlock)) {
      const block = lastBlock.at(-1);
      if (block?.type === 'text') block.cache_control = { type: 'ephemeral' };
    }

    const [earlier] = await this.deps.db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.contactId, contact.id), eq(messages.direction, 'outbound')))
      .limit(1);

    return [
      ...history,
      {
        role: 'system',
        content: turnContext({
          client,
          contact,
          now,
          firstContact: !earlier,
          newConversation: !rows.some((m) => m.direction === 'outbound'),
          customer: await customerTurnContext(this.deps.db, client, contact),
        }),
      },
    ];
  }
}
