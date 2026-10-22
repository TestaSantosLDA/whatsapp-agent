import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { outbox } from '../db/schema.js';
import { BackgroundTasks } from '../services/background.js';
import type { BackofficeService } from '../services/backoffice.js';

export type EmailKind = 'lead' | 'handoff' | 'order_draft';

/** An email to the client's team about one conversation (WA-015). */
export interface Email {
  clientId: string;
  conversationId?: string;
  /** The customer's WhatsApp number, so the back-office panel shows it on their conversation. */
  phone: string;
  kind: EmailKind;
  from: string;
  replyTo?: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends business emails. `send` never throws and never waits for the provider: the email is
 * written to `outbox` (and shown in the back-office panel) and delivered in the background.
 */
export interface Mailer {
  send(email: Email): Promise<void>;
  /** Waits for background deliveries started so far. For tests and graceful shutdown. */
  flush(): Promise<void>;
}

/** Delivers one email to a provider. Throws on failure; the mailer retries. */
export interface MailTransport {
  readonly name: string;
  deliver(email: Email, idempotencyKey: string): Promise<void>;
}

type OutboxRow = typeof outbox.$inferSelect;

/**
 * The demo mailer (WA-015's MockMailer): every email becomes an `outbox` row, published to the
 * back-office panel, and stops there (`sentAt` is set at once). With a transport, the row is
 * delivered in the background with retries, and `sentAt` or `error` is recorded on it.
 */
export class OutboxMailer implements Mailer {
  protected readonly background: BackgroundTasks;

  constructor(
    protected readonly deps: {
      db: Db;
      backoffice?: BackofficeService;
      transport?: MailTransport;
      background?: BackgroundTasks;
    },
  ) {
    this.background = deps.background ?? new BackgroundTasks();
  }

  async send(email: Email): Promise<void> {
    try {
      const transport = this.deps.transport;
      const noRecipients = email.to.length === 0;
      const row = await this.insert(email, {
        sentAt: transport || noRecipients ? null : new Date(),
        error: noRecipients ? 'no recipients configured for this branch' : null,
      });
      if (!transport || noRecipients) return;
      this.background.run(
        `${transport.name} email ${row.id}`,
        async () => {
          await transport.deliver(email, row.id);
          await this.update(email, row.id, { sentAt: new Date(), error: null });
        },
        async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          await this.update(email, row.id, { error: message.slice(0, 1000) });
        },
      );
    } catch (error) {
      // An email is never worth failing the customer's turn.
      console.error(`[mail] could not queue ${email.kind} email for ${email.clientId}`, error);
    }
  }

  flush(): Promise<void> {
    return this.background.flush();
  }

  private async insert(
    email: Email,
    state: { sentAt: Date | null; error: string | null },
  ): Promise<OutboxRow> {
    const [row] = await this.deps.db
      .insert(outbox)
      .values({
        clientId: email.clientId,
        conversationId: email.conversationId,
        kind: email.kind,
        to: email.to,
        subject: email.subject,
        body: email.text,
        ...state,
      })
      .returning();
    this.deps.backoffice?.publishEmail(email.clientId, email.phone, row!);
    return row!;
  }

  private async update(
    email: Email,
    id: string,
    state: { sentAt?: Date; error: string | null },
  ): Promise<void> {
    const [row] = await this.deps.db.update(outbox).set(state).where(eq(outbox.id, id)).returning();
    // Same id again: the panel replaces the email it already shows.
    if (row) this.deps.backoffice?.publishEmail(email.clientId, email.phone, row);
  }
}

/** Resend's REST API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendTransport implements MailTransport {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async deliver(email: Email, idempotencyKey: string): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        // A retry after a lost response does not send the email twice.
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend answered ${res.status}: ${detail.slice(0, 300)}`);
    }
  }
}

/** Outbox plus delivery through Resend. */
export class ResendMailer extends OutboxMailer {
  constructor(deps: {
    db: Db;
    apiKey: string;
    backoffice?: BackofficeService;
    fetch?: typeof fetch;
    background?: BackgroundTasks;
  }) {
    super({ ...deps, transport: new ResendTransport(deps.apiKey, deps.fetch) });
  }
}

/** Resend when RESEND_API_KEY is set, else the outbox only (demo mode). */
export function mailerFromEnv(deps: {
  db: Db;
  backoffice?: BackofficeService;
  resendApiKey?: string;
}): Mailer {
  return deps.resendApiKey
    ? new ResendMailer({ db: deps.db, backoffice: deps.backoffice, apiKey: deps.resendApiKey })
    : new OutboxMailer({ db: deps.db, backoffice: deps.backoffice });
}
