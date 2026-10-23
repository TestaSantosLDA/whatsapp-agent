/**
 * No-reply reminders (WA-024). Run by POST /jobs/lead-reminders (Cloud Scheduler, every 15
 * minutes during the day). A lead still `new` after the client's response time, counted in the
 * branch's working hours, gets one email to its owner; after 24 working hours, one to the
 * branch's admins. Each reminder is claimed in the database before it is sent, so two runs at
 * the same time never send it twice.
 */
import { leadTypeLabel, type Branch, type ClientConfig } from '@wa/shared';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { workingHoursBetween } from '../agent/hours.js';
import type { ClientRegistry } from '../clients/registry.js';
import type { Db } from '../db/index.js';
import { contacts, leadEvents, leads, teamMembers } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import { branchRecipients } from '../mail/templates.js';

/** Working hours after which the branch's admins hear about a lead nobody answered. */
export const ADMIN_REMINDER_HOURS = 24;
/** The client's response time in working hours (`lead.response_time_hours`, default 8). */
export const responseHours = (client: ClientConfig): number => client.lead.response_time_hours ?? 8;
/** Older leads are not chased any more (and keep the scan small). */
const LOOKBACK_DAYS = 60;

type LeadRow = typeof leads.$inferSelect;
type MemberRow = typeof teamMembers.$inferSelect;

export interface ReminderResult {
  checked: number;
  owner: number;
  admin: number;
}

export class LeadReminders {
  constructor(
    private readonly deps: {
      db: Db;
      clients: ClientRegistry;
      mailer: Mailer;
      /** The dashboard, e.g. https://<service>/admin (links to the lead page). */
      dashboardUrl: string;
    },
  ) {}

  async run(now = new Date()): Promise<ReminderResult> {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const rows = await this.deps.db
      .select({ lead: leads, contactName: contacts.name, waId: contacts.waId })
      .from(leads)
      .leftJoin(contacts, eq(contacts.id, leads.contactId))
      .where(
        and(eq(leads.status, 'new'), isNull(leads.adminRemindedAt), gt(leads.createdAt, since)),
      )
      .orderBy(asc(leads.createdAt));
    const result: ReminderResult = { checked: rows.length, owner: 0, admin: 0 };
    const teams = new Map<string, MemberRow[]>();
    const teamOf = async (clientId: string) => {
      if (!teams.has(clientId)) {
        teams.set(
          clientId,
          await this.deps.db
            .select()
            .from(teamMembers)
            .where(eq(teamMembers.clientId, clientId))
            .orderBy(asc(teamMembers.email)),
        );
      }
      return teams.get(clientId)!;
    };

    for (const { lead, contactName, waId } of rows) {
      const client = this.deps.clients.get(lead.clientId);
      const branch = client?.branches.find((b) => b.id === lead.branchId);
      if (!client || !branch) continue;
      const hours = workingHoursBetween(branch, lead.createdAt, now, client.timezone);
      const due = responseHours(client);
      const contact = { name: contactName, waId };
      const team = await teamOf(client.id);
      const admins = branchAdmins(team, branch.id);

      if (!lead.ownerRemindedAt && hours >= due) {
        const owner = team.find((m) => m.id === lead.ownerMemberId);
        const to = owner ? [owner.email] : emails(admins, branch);
        if (await this.claim(lead, 'ownerRemindedAt', now)) {
          await this.send(client, branch, lead, contact, 'owner', to, hours, owner, now);
          result.owner++;
        }
      }
      if (hours >= Math.max(ADMIN_REMINDER_HOURS, due)) {
        if (await this.claim(lead, 'adminRemindedAt', now)) {
          const owner = team.find((m) => m.id === lead.ownerMemberId);
          await this.send(
            client,
            branch,
            lead,
            contact,
            'admin',
            emails(admins, branch),
            hours,
            owner,
            now,
          );
          result.admin++;
        }
      }
    }
    return result;
  }

  /** Marks the reminder as sent unless another run already did. */
  private async claim(
    lead: LeadRow,
    column: 'ownerRemindedAt' | 'adminRemindedAt',
    now: Date,
  ): Promise<boolean> {
    const claimed = await this.deps.db
      .update(leads)
      .set({ [column]: now })
      .where(and(eq(leads.id, lead.id), isNull(leads[column]), eq(leads.status, 'new')))
      .returning({ id: leads.id });
    return claimed.length > 0;
  }

  private async send(
    client: ClientConfig,
    branch: Branch,
    lead: LeadRow,
    contact: { name: string | null; waId: string | null },
    stage: 'owner' | 'admin',
    to: string[],
    hours: number,
    owner: MemberRow | undefined,
    now: Date,
  ): Promise<void> {
    const fields = lead.fields as Record<string, unknown>;
    const who =
      (typeof fields['name'] === 'string' && fields['name']) ||
      contact.name ||
      (contact.waId ? `+${contact.waId}` : 'cliente');
    const label = leadTypeLabel(lead.type);
    const link = `${this.deps.dashboardUrl.replace(/\/+$/, '')}/leads/${lead.id}`;
    const shown = Math.floor(hours);
    const subject =
      stage === 'owner'
        ? `Pedido sem resposta: ${who} (${label})`
        : `[Sem resposta há ${shown} h úteis] ${who} (${label})`;
    const intro =
      stage === 'owner'
        ? `Este pedido de ${branch.name} continua sem resposta há ${shown} horas úteis (o prazo é ${client.lead.response_time}). Contacte o cliente e marque-o como contactado no painel.`
        : `Este pedido de ${branch.name} continua sem resposta há ${shown} horas úteis. Responsável: ${owner ? (owner.name ?? owner.email) : 'ninguém'}.`;
    const lines: [string, string][] = (
      [
        ['Cliente', who],
        ['Telefone', contact.waId ? `+${contact.waId}` : null],
        ['Tipo', label],
        ['Recebido', formatDate(lead.createdAt, client.timezone)],
        ['Resumo', typeof fields['summary'] === 'string' ? fields['summary'] : null],
      ] as [string, string | null][]
    ).filter((l): l is [string, string] => Boolean(l[1]));
    const text = [intro, '', ...lines.map(([k, v]) => `${k}: ${v}`), '', `Abrir: ${link}`].join(
      '\n',
    );
    const html = `<!doctype html>
<html lang="pt-PT"><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:6px;">
<p style="margin:0 0 16px;">${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;">
${lines.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;color:#666;">${esc(k)}</td><td style="padding:6px 0;vertical-align:top;"><strong>${esc(v)}</strong></td></tr>`).join('\n')}
</table>
<p style="margin:0;"><a href="${esc(link)}" style="display:inline-block;background:#008069;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:4px;font-weight:bold;">Abrir o pedido</a></p>
</div></body></html>`;

    await this.deps.mailer.send({
      clientId: client.id,
      conversationId: lead.conversationId ?? undefined,
      phone: contact.waId ?? '',
      kind: 'lead_reminder',
      from: client.mail.from,
      replyTo: client.mail.reply_to,
      to,
      subject,
      text,
      html,
    });
    await this.deps.db.insert(leadEvents).values({
      clientId: client.id,
      leadId: lead.id,
      kind: stage === 'owner' ? 'reminder_owner' : 'reminder_admin',
      data: { to, hours: Math.round(hours * 10) / 10 },
      createdAt: now,
    });
  }
}

/** Admins alerted for this branch; with none, every admin of the client. */
function branchAdmins(team: MemberRow[], branchId: string): MemberRow[] {
  const admins = team.filter((m) => m.role === 'admin');
  const forBranch = admins.filter((m) => m.branches.includes(branchId));
  return forBranch.length ? forBranch : admins;
}

/** Their emails; nobody on the team → the branch's lead recipients. */
function emails(members: MemberRow[], branch: Branch): string[] {
  return members.length ? members.map((m) => m.email) : branchRecipients(branch);
}

function formatDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
