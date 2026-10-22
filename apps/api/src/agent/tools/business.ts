/** Shared plumbing for the tools that produce business outputs: leads, emails, branches. */
import type { Branch, ClientConfig } from '@wa/shared';
import { LeadSinks } from '../../leads/sink.js';
import { OutboxMailer, type Mailer } from '../../mail/mailer.js';
import type { EmailContext } from '../../mail/templates.js';
import { ToolError, type ToolContext } from '../tool.js';

/** The context's lead sinks, or the database alone. */
export function leadsOf(ctx: ToolContext): LeadSinks {
  return ctx.leads ?? new LeadSinks({ db: ctx.db, backoffice: ctx.backoffice });
}

/** The context's mailer, or the outbox alone. */
export function mailerOf(ctx: ToolContext): Mailer {
  return ctx.mailer ?? new OutboxMailer({ db: ctx.db, backoffice: ctx.backoffice });
}

export function findBranch(client: ClientConfig, id: string): Branch {
  const branch = client.branches.find((b) => b.id === id);
  if (!branch) {
    throw new ToolError(
      'unknown_branch',
      `No branch with id "${id}". Branch ids: ${client.branches.map((b) => b.id).join(', ')}.`,
    );
  }
  return branch;
}

/** `name` is the name the customer gave, when it differs from their WhatsApp profile. */
export function emailContext(ctx: ToolContext, branch: Branch, name?: string): EmailContext {
  return {
    client: ctx.client,
    branch,
    conversationId: ctx.conversation.id,
    contact: { name: name ?? ctx.contact.name, waId: ctx.contact.waId },
  };
}

/** The contact as the lead sinks need it. */
export function leadContact(ctx: ToolContext) {
  return { id: ctx.contact.id, name: ctx.contact.name, waId: ctx.contact.waId };
}

/** Drops undefined values, so stored lead fields only hold what was collected. */
export function compact<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}
