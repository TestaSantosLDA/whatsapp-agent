import type { ClientConfig } from '@wa/shared';
import type { z } from 'zod';
import type { OutboundMessage } from '../channels/channel.js';
import type { Db } from '../db/index.js';
import type { BackofficeService } from '../services/backoffice.js';
import type { ContactRow, ConversationRow } from '../services/messages.js';

/** What a tool sees while it runs: the turn it belongs to, and a place to queue rich messages. */
export interface ToolContext {
  db: Db;
  client: ClientConfig;
  conversation: ConversationRow;
  contact: ContactRow;
  /**
   * Rich messages (product images, list messages) a tool wants the customer to see. They are sent
   * after the agent's text reply for this turn, in the order they were queued.
   */
  outbox: OutboundMessage[];
  /** Publishes leads, emails and status changes to the back-office panel. */
  backoffice?: BackofficeService;
  /** Tap-to-answer options for the agent's text reply, set by offer_choices. */
  choices?: { options: string[]; listButton?: string };
}

/**
 * A tool the agent can call. Tools are plain modules so they can be unit tested without Claude;
 * the agent wraps them for the SDK tool runner.
 *
 * Return a JSON-serialisable value: it is sent back to Claude as the tool result. Throw
 * `ToolError` for an expected failure Claude should explain to the customer (unknown product,
 * missing data); any other error is reported to Claude as an internal error.
 */
export interface AgentTool<Schema extends z.ZodType = z.ZodType> {
  /** Name used in client config `tools:` and by Claude. snake_case. */
  name: string;
  description: string;
  inputSchema: Schema;
  run(input: z.infer<Schema>, ctx: ToolContext): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    /** Machine-readable reason, e.g. `not_found`, `missing_data`, `unavailable`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Helper that keeps the input type when defining a tool. */
export function defineTool<Schema extends z.ZodType>(tool: AgentTool<Schema>): AgentTool<Schema> {
  return tool;
}
