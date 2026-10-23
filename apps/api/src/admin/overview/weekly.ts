/**
 * The Monday email (WA-029): last week's figures for every branch and the top five "couldn't
 * answer" topics, to each client's admins. Run by POST /jobs/weekly-insights (Cloud Scheduler,
 * Mondays). Each client's week is claimed in `insight_reports` before sending, so a retried or
 * repeated run never sends it twice.
 */
import type { ClientConfig, GapsView, OverviewFigures } from '@wa/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { ClientRegistry } from '../../clients/registry.js';
import type { Db } from '../../db/index.js';
import { insightReports, teamMembers } from '../../db/schema.js';
import type { Mailer } from '../../mail/mailer.js';
import { localDay, startOfWeek, type InsightsService } from './service.js';

const TOP_GAPS = 5;
const WEEK = 7 * 86_400_000;

export interface WeeklyResult {
  clientId: string;
  /** sent, already_sent (this week was claimed before) or no_admins. */
  status: 'sent' | 'already_sent' | 'no_admins';
  recipients: number;
}

export class WeeklyInsights {
  constructor(
    private readonly deps: {
      db: Db;
      clients: ClientRegistry;
      insights: InsightsService;
      mailer: Mailer;
      /** The dashboard, e.g. https://<service>/admin. */
      dashboardUrl: string;
    },
  ) {}

  /** Reports the full week (Monday to Sunday) before the one `now` is in. */
  async run(now = new Date(), clientId?: string): Promise<WeeklyResult[]> {
    const clients = clientId
      ? [this.deps.clients.get(clientId)].filter((c) => c !== undefined)
      : this.deps.clients.all();
    const results: WeeklyResult[] = [];
    for (const client of clients) results.push(await this.runClient(client, now));
    return results;
  }

  private async runClient(client: ClientConfig, now: Date): Promise<WeeklyResult> {
    const to = startOfWeek(now, client.timezone);
    // Noon of a day in the previous week, so a DST change cannot land on the wrong Monday.
    const from = startOfWeek(new Date(to.getTime() - WEEK + 12 * 3_600_000), client.timezone);
    const admins = await this.deps.db
      .select({ email: teamMembers.email })
      .from(teamMembers)
      .where(and(eq(teamMembers.clientId, client.id), eq(teamMembers.role, 'admin')))
      .orderBy(asc(teamMembers.email));
    if (admins.length === 0) return { clientId: client.id, status: 'no_admins', recipients: 0 };

    const weekStart = localDay(from, client.timezone);
    const claimed = await this.deps.db
      .insert(insightReports)
      .values({ clientId: client.id, weekStart, recipients: admins.length })
      .onConflictDoNothing()
      .returning({ id: insightReports.id });
    if (claimed.length === 0) {
      return { clientId: client.id, status: 'already_sent', recipients: 0 };
    }

    const range = { from, to };
    const figures = await this.deps.insights.figures({ client, includeCost: true }, range);
    const gaps = await this.deps.insights.gaps(client, range);
    const email = weeklyEmail(client, figures, gaps, this.deps.dashboardUrl);
    await this.deps.mailer.send({
      clientId: client.id,
      phone: '',
      kind: 'weekly_insights',
      from: client.mail.from,
      replyTo: client.mail.reply_to,
      to: admins.map((a) => a.email),
      ...email,
    });
    return { clientId: client.id, status: 'sent', recipients: admins.length };
  }
}

function formatDay(iso: string, timeZone: string, last = false): string {
  const at = new Date(new Date(iso).getTime() - (last ? 1 : 0));
  return new Intl.DateTimeFormat('pt-PT', { timeZone, day: '2-digit', month: '2-digit' }).format(
    at,
  );
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const money = (usd: number) => `${usd.toFixed(2)} USD`;
/** Customers' words are quoted short in an email. */
const short = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

export function weeklyEmail(
  client: ClientConfig,
  f: OverviewFigures,
  gaps: GapsView,
  dashboardUrl: string,
): { subject: string; text: string; html: string } {
  const tz = client.timezone;
  const period = `${formatDay(f.from, tz)} a ${formatDay(f.to, tz, true)}`;
  const subject = `Resumo da semana ${period}: ${f.leads} pedidos, ${f.handoffs} passagens`;
  const rows: [string, string][] = [
    ['Conversas', String(f.conversations)],
    [
      'Pedidos',
      `${f.leads}${f.leadsByType.length ? ` (${f.leadsByType.map((t) => `${t.label} ${t.count}`).join(', ')})` : ''}`,
    ],
    ['Passagens para a equipa', String(f.handoffs)],
    ['Orçamentados', `${f.quoted} · ${f.quotesSent} orçamentos enviados`],
    ['Ganhos / perdidos', `${f.won} / ${f.lost}`],
    [
      'Primeira resposta (mediana)',
      `${formatMinutes(f.firstResponse.medianWorkingMinutes)} em horário de funcionamento · ${f.firstResponse.waiting} por responder`,
    ],
  ];
  if (f.cost) rows.push(['Custo do Claude', money(f.cost.totalUsd)]);
  const top = gaps.topics.slice(0, TOP_GAPS);
  const link = `${dashboardUrl.replace(/\/+$/, '')}/overview`;
  const gapLines = top.map(
    (t) =>
      `${t.topic}: ${t.count} ${t.count === 1 ? 'pergunta' : 'perguntas'}, p. ex. "${short(t.examples[0]?.question ?? '')}"`,
  );
  const text = [
    `Resumo de ${client.name}, semana de ${period}.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    top.length
      ? 'O que o assistente não soube responder:'
      : 'O assistente respondeu a tudo esta semana.',
    ...gapLines.map((l) => `- ${l}`),
    '',
    `Abrir o resumo: ${link}`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-PT"><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:6px;">
<p style="margin:0 0 16px;">Resumo de <strong>${esc(client.name)}</strong>, semana de ${esc(period)}.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;color:#666;">${esc(k)}</td><td style="padding:6px 0;vertical-align:top;"><strong>${esc(v)}</strong></td></tr>`).join('\n')}
</table>
<p style="margin:0 0 8px;"><strong>${top.length ? 'O que o assistente não soube responder' : 'O assistente respondeu a tudo esta semana.'}</strong></p>
${top.length ? `<ol style="margin:0 0 16px;padding-left:20px;">${top.map((t) => `<li style="margin:0 0 6px;">${esc(t.topic)}: ${t.count} ${t.count === 1 ? 'pergunta' : 'perguntas'}${t.examples[0] ? `<br><span style="color:#666;">«${esc(short(t.examples[0].question))}»</span>` : ''}</li>`).join('')}</ol>` : ''}
<p style="margin:0;"><a href="${esc(link)}" style="display:inline-block;background:#008069;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:4px;font-weight:bold;">Abrir o resumo</a></p>
</div></body></html>`;
  return { subject, text, html };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
