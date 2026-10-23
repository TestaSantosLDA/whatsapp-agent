/**
 * Overview and "couldn't answer" list (WA-029), computed from what is already stored:
 * conversations and messages, leads with their status dates (WA-024), the agent's turns and
 * their tool calls and cost (`agent_runs`), and document reading cost (WA-026).
 */
import {
  handoffReasonLabels,
  leadTypeLabel,
  lostReasonLabels,
  lostReasons,
  type AskedProduct,
  type ClientConfig,
  type GapExample,
  type GapReason,
  type GapsView,
  type GapTopic,
  type LostReason,
  type MissingSearch,
  type OverviewBranchFigures,
  type OverviewBranchRow,
  type OverviewCount,
  type OverviewFigures,
  type OverviewProductsView,
  type OverviewView,
} from '@wa/shared';
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ToolCallRecord } from '../../agent/claude-responder.js';
import { workingHoursBetween } from '../../agent/hours.js';
import type { Db } from '../../db/index.js';
import {
  agentRuns,
  documents,
  insightGapDismissals,
  leads,
  messages,
  products,
} from '../../db/schema.js';
import { adminError, assertBranch, isAdmin, type AdminContext } from '../context.js';
import {
  emptySearches,
  isDeferral,
  normalise,
  NO_INFO_HANDOFF_REASONS,
  searchFoundNothing,
  searchQuery,
  topicOf,
  type GapEvent,
} from './gaps.js';

const DAY = 86_400_000;
/** Lists of products and searches. */
const TOP = 10;
const EXAMPLES = 3;

/** Which data a set of figures covers. */
export interface InsightsScope {
  client: ClientConfig;
  /** Branches to count leads for; undefined: every lead, with or without a branch. */
  branchIds?: string[];
  /** Claude's cost; only for admins looking at every branch. */
  includeCost: boolean;
}

interface Range {
  from: Date;
  to: Date;
}

type LeadFact = {
  type: string;
  branchId: string | null;
  status: string;
  lostReason: string | null;
  reason: string | null;
  createdAt: Date;
  contactedAt: Date | null;
  quotedAt: Date | null;
  closedAt: Date | null;
};

const within = (at: Date | null, r: Range) =>
  at !== null && at.getTime() >= r.from.getTime() && at.getTime() < r.to.getTime();

function counted<K extends string>(
  values: K[],
  label: (k: K) => string,
  order?: readonly K[],
): OverviewCount<K>[] {
  const map = new Map<K, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  const rows = [...map].map(([key, n]) => ({ key, label: label(key), count: n }));
  return order
    ? rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    : rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Local calendar date of `at` in a time zone. */
function localDate(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
  };
}

/** The instant of local midnight on a calendar day (day may overflow, as with Date.UTC). */
export function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  let t = wall;
  // Twice: the offset at the guess can differ from the offset at the answer around DST.
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
    const asWall = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    t = wall - (asWall - t);
  }
  return new Date(t);
}

/** Monday 00:00 (local) of the week `at` is in. */
export function startOfWeek(at: Date, timeZone: string): Date {
  const d = localDate(at, timeZone);
  return localMidnight(d.year, d.month, d.day - d.weekday, timeZone);
}

/** The 1st 00:00 (local) of the month `at` is in. */
export function startOfMonth(at: Date, timeZone: string): Date {
  const d = localDate(at, timeZone);
  return localMidnight(d.year, d.month, 1, timeZone);
}

/** `YYYY-MM-DD` of `at` in a time zone. */
export function localDay(at: Date, timeZone: string): string {
  const d = localDate(at, timeZone);
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

const usd = (value: unknown) => Math.round(Number(value ?? 0) * 1e6) / 1e6;

export class InsightsService {
  constructor(private readonly deps: { db: Db; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The member's scope: one branch (checked), or every branch they see. */
  scopeFor(ctx: AdminContext, branch?: string): InsightsScope {
    if (branch) {
      if (!ctx.client.branches.some((b) => b.id === branch)) {
        throw adminError(400, 'invalid_branch', 'Filial desconhecida.');
      }
      assertBranch(ctx, branch);
      return { client: ctx.client, branchIds: [branch], includeCost: false };
    }
    return isAdmin(ctx)
      ? { client: ctx.client, includeCost: true }
      : { client: ctx.client, branchIds: ctx.branchIds, includeCost: false };
  }

  async overview(ctx: AdminContext, branch?: string): Promise<OverviewView> {
    const scope = this.scopeFor(ctx, branch);
    const now = this.now();
    const tz = ctx.client.timezone;
    const week = { from: startOfWeek(now, tz), to: now };
    const month = { from: startOfMonth(now, tz), to: now };
    const facts = await this.leadFacts(scope, {
      from: new Date(Math.min(week.from.getTime(), month.from.getTime())),
      to: now,
    });
    const shown = scope.branchIds ?? ctx.branchIds;
    const branches: OverviewBranchRow[] = ctx.client.branches
      .filter((b) => shown.includes(b.id))
      .map((b) => {
        const mine = facts.filter((f) => f.branchId === b.id);
        return {
          branchId: b.id,
          name: b.name,
          week: branchFigures(mine, week),
          month: branchFigures(mine, month),
        };
      });
    return {
      generatedAt: now.toISOString(),
      timezone: tz,
      branch: branch ?? null,
      week: await this.figures(scope, week, facts),
      month: await this.figures(scope, month, facts),
      branches,
    };
  }

  /** The figures of one period. `facts` may cover a wider range (they are filtered here). */
  async figures(scope: InsightsScope, range: Range, facts?: LeadFact[]): Promise<OverviewFigures> {
    const client = scope.client;
    facts ??= await this.leadFacts(scope, range);
    const created = facts.filter((f) => within(f.createdAt, range));
    const handoffs = created.filter((f) => f.type === 'handoff');
    const saved = created.filter((f) => f.type !== 'handoff');
    const closed = facts.filter((f) => within(f.closedAt, range));
    const lost = closed.filter((f) => f.status === 'lost');

    const answered = created.filter((f) => f.contactedAt);
    const minutes = answered.map((f) => (f.contactedAt!.getTime() - f.createdAt.getTime()) / 60000);
    const working = answered.flatMap((f) => {
      const branch = client.branches.find((b) => b.id === f.branchId);
      return branch
        ? [workingHoursBetween(branch, f.createdAt, f.contactedAt!, client.timezone) * 60]
        : [];
    });
    const round = (v: number | null) => (v === null ? null : Math.round(v));

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      conversations: await this.conversationCount(scope, range),
      leads: saved.length,
      leadsByType: counted(
        saved.map((f) => f.type),
        leadTypeLabel,
      ),
      handoffs: handoffs.length,
      handoffsByReason: counted(
        handoffs.map((f) => f.reason ?? 'other'),
        (k) => handoffReasonLabels[k] ?? k,
      ),
      quoted: facts.filter((f) => within(f.quotedAt, range)).length,
      // TODO(WA-025): count the quotes sent in the period once quote drafts exist.
      quotesSent: null,
      won: closed.filter((f) => f.status === 'won').length,
      lost: lost.length,
      lostByReason: counted(
        lost.map((f) => (f.lostReason ?? 'other') as LostReason),
        (k) => lostReasonLabels[k] ?? k,
        lostReasons,
      ),
      // TODO(WA-023): include the first reply a member sends from the inbox (handoffs).
      firstResponse: {
        answered: answered.length,
        waiting: created.filter((f) => f.status === 'new').length,
        medianMinutes: round(median(minutes)),
        medianWorkingMinutes: round(median(working)),
      },
      cost: scope.includeCost ? await this.cost(client.id, range) : null,
    };
  }

  private leadScope(scope: InsightsScope): SQL | undefined {
    if (!scope.branchIds) return undefined;
    if (scope.branchIds.length === 0) return sql`false`;
    return inArray(leads.branchId, scope.branchIds);
  }

  /** Leads created, quoted or closed in the range. */
  private async leadFacts(scope: InsightsScope, r: Range): Promise<LeadFact[]> {
    const inRange = (column: PgColumn) => and(gte(column, r.from), lt(column, r.to));
    return this.deps.db
      .select({
        type: leads.type,
        branchId: leads.branchId,
        status: leads.status,
        lostReason: leads.lostReason,
        reason: sql<string | null>`${leads.fields}->>'reason'`,
        createdAt: leads.createdAt,
        contactedAt: leads.contactedAt,
        quotedAt: leads.quotedAt,
        closedAt: leads.closedAt,
      })
      .from(leads)
      .where(
        and(
          eq(leads.clientId, scope.client.id),
          this.leadScope(scope),
          or(inRange(leads.createdAt), inRange(leads.quotedAt), inRange(leads.closedAt)),
        ),
      );
  }

  /**
   * Conversations with a customer message in the range. Conversations have no branch: for a
   * branch, the ones with a lead of that branch.
   */
  private async conversationCount(scope: InsightsScope, r: Range): Promise<number> {
    const branchScope = this.leadScope(scope);
    const [row] = await this.deps.db
      .select({ n: sql<number>`count(distinct ${messages.conversationId})::int` })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, scope.client.id),
          eq(messages.direction, 'inbound'),
          gte(messages.createdAt, r.from),
          lt(messages.createdAt, r.to),
          branchScope &&
            inArray(
              messages.conversationId,
              this.deps.db
                .select({ id: sql<string>`${leads.conversationId}` })
                .from(leads)
                .where(
                  and(
                    eq(leads.clientId, scope.client.id),
                    isNotNull(leads.conversationId),
                    branchScope,
                  ),
                ),
            ),
        ),
      );
    return Number(row?.n ?? 0);
  }

  private async cost(clientId: string, r: Range): Promise<NonNullable<OverviewFigures['cost']>> {
    const [agent] = await this.deps.db
      .select({ turns: count(), usd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientId, clientId),
          gte(agentRuns.createdAt, r.from),
          lt(agentRuns.createdAt, r.to),
        ),
      );
    const [docs] = await this.deps.db
      .select({ usd: sql<string>`coalesce(sum(${documents.costUsd}), 0)` })
      .from(documents)
      .where(
        and(
          eq(documents.clientId, clientId),
          gte(documents.createdAt, r.from),
          lt(documents.createdAt, r.to),
        ),
      );
    const agentUsd = usd(agent?.usd);
    const documentsUsd = usd(docs?.usd);
    return {
      turns: Number(agent?.turns ?? 0),
      agentUsd,
      documentsUsd,
      totalUsd: usd(agentUsd + documentsUsd),
    };
  }

  /** The last `days` days, ending now. */
  lastDays(days: number): Range {
    const to = this.now();
    return { from: new Date(to.getTime() - days * DAY), to };
  }

  private async runsWithTools(clientId: string, r: Range, names: string[]) {
    const pattern = names.join('|');
    const rows = await this.deps.db
      .select({
        id: agentRuns.id,
        conversationId: agentRuns.conversationId,
        toolCalls: agentRuns.toolCalls,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.clientId, clientId),
          isNull(agentRuns.error),
          gte(agentRuns.createdAt, r.from),
          lt(agentRuns.createdAt, r.to),
          sql`${agentRuns.toolCalls}::text ~ ${pattern}`,
        ),
      )
      .orderBy(asc(agentRuns.createdAt));
    return rows.map((row) => ({ ...row, calls: (row.toolCalls ?? []) as ToolCallRecord[] }));
  }

  /** Products the agent looked up or showed most, and catalogue searches that found nothing. */
  async products(client: ClientConfig, r: Range): Promise<OverviewProductsView> {
    const runs = await this.runsWithTools(client.id, r, [
      'get_product',
      'show_products',
      'search_products',
    ]);
    const asked: { key: string; conversation: string }[] = [];
    const missing = new Map<
      string,
      { query: string; searches: number; conversations: Set<string>; lastAt: Date }
    >();
    for (const run of runs) {
      const conversation = run.conversationId ?? `run:${run.id}`;
      for (const call of run.calls) {
        if (!call.ok) continue;
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (call.name === 'get_product') {
          const key = [input['variant_id'], input['product_id'], input['sku']].find(
            (v): v is string => typeof v === 'string' && v !== '',
          );
          if (key) asked.push({ key, conversation });
        } else if (call.name === 'show_products' && Array.isArray(input['variant_ids'])) {
          for (const id of input['variant_ids']) {
            if (typeof id === 'string') asked.push({ key: id, conversation });
          }
        } else if (call.name === 'search_products' && searchFoundNothing(call)) {
          const query = searchQuery(call);
          if (!query) continue;
          const key = normalise(query);
          const entry = missing.get(key) ?? {
            query,
            searches: 0,
            conversations: new Set<string>(),
            lastAt: run.createdAt,
          };
          entry.query = query;
          entry.searches++;
          entry.conversations.add(conversation);
          entry.lastAt = run.createdAt;
          missing.set(key, entry);
        }
      }
    }

    const keys = [...new Set(asked.map((a) => a.key))];
    const rows = keys.length
      ? await this.deps.db
          .select({
            variantId: products.variantId,
            productId: products.productId,
            sku: products.sku,
            title: products.title,
          })
          .from(products)
          .where(
            and(
              eq(products.clientId, client.id),
              or(
                inArray(products.variantId, keys),
                inArray(products.productId, keys),
                inArray(products.sku, keys),
              ),
            ),
          )
      : [];
    const productOf = new Map<string, { productId: string; title: string }>();
    for (const row of rows) {
      const p = { productId: row.productId, title: row.title };
      productOf.set(row.productId, p);
      if (row.sku) productOf.set(row.sku, p);
    }
    // Variant ids win over a product id or SKU that happens to be equal.
    for (const row of rows)
      productOf.set(row.variantId, { productId: row.productId, title: row.title });

    const byProduct = new Map<
      string,
      { title: string; conversations: Set<string>; mentions: number }
    >();
    for (const a of asked) {
      const p = productOf.get(a.key);
      if (!p) continue; // no longer in the catalogue
      const entry = byProduct.get(p.productId) ?? {
        title: p.title,
        conversations: new Set<string>(),
        mentions: 0,
      };
      entry.mentions++;
      entry.conversations.add(a.conversation);
      byProduct.set(p.productId, entry);
    }

    return {
      from: r.from.toISOString(),
      to: r.to.toISOString(),
      products: [...byProduct]
        .map(([productId, e]): AskedProduct => ({
          productId,
          title: e.title,
          conversations: e.conversations.size,
          mentions: e.mentions,
        }))
        .sort(
          (a, b) =>
            b.conversations - a.conversations ||
            b.mentions - a.mentions ||
            a.title.localeCompare(b.title),
        )
        .slice(0, TOP),
      missingSearches: [...missing.values()]
        .map((e): MissingSearch => ({
          query: e.query,
          searches: e.searches,
          conversations: e.conversations.size,
          lastAt: e.lastAt.toISOString(),
        }))
        .sort(
          (a, b) =>
            b.conversations - a.conversations ||
            b.searches - a.searches ||
            b.lastAt.localeCompare(a.lastAt),
        )
        .slice(0, TOP),
    };
  }

  /** Signs that the agent could not answer, in the range. */
  private async gapEvents(clientId: string, r: Range): Promise<GapEvent[]> {
    const events: GapEvent[] = [];
    // TODO(WA-023): leave out messages a team member sent from the inbox once they are marked.
    const deferrals = await this.deps.db
      .select({
        conversationId: messages.conversationId,
        text: messages.text,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.direction, 'outbound'),
          gte(messages.createdAt, r.from),
          lt(messages.createdAt, r.to),
          sql`${messages.text} ~* '(colega|colleague|compa|coll|equipa|team)'`,
        ),
      );
    for (const m of deferrals) {
      if (isDeferral(m.text)) {
        events.push({
          conversationId: m.conversationId,
          at: m.createdAt,
          reason: 'deferred',
          reply: m.text!,
        });
      }
    }

    const handoffs = await this.deps.db
      .select({
        conversationId: leads.conversationId,
        createdAt: leads.createdAt,
        summary: sql<string | null>`${leads.fields}->>'summary'`,
      })
      .from(leads)
      .where(
        and(
          eq(leads.clientId, clientId),
          eq(leads.type, 'handoff'),
          isNotNull(leads.conversationId),
          inArray(sql<string>`${leads.fields}->>'reason'`, NO_INFO_HANDOFF_REASONS),
          gte(leads.createdAt, r.from),
          lt(leads.createdAt, r.to),
        ),
      );
    for (const h of handoffs) {
      events.push({
        conversationId: h.conversationId!,
        at: h.createdAt,
        reason: 'handoff',
        fallback: h.summary ?? undefined,
      });
    }

    for (const run of await this.runsWithTools(clientId, r, [
      'search_products',
      'search_documents',
    ])) {
      if (!run.conversationId) continue;
      const empty = emptySearches(run.calls);
      if (empty.length === 0) continue;
      events.push({
        conversationId: run.conversationId,
        at: run.createdAt,
        reason: 'no_result',
        queries: empty.map(searchQuery).filter((q): q is string => q !== null),
      });
    }
    return events;
  }

  /**
   * The "couldn't answer" list: each customer question the agent deferred, handed over for lack
   * of information, or searched for in vain, grouped by topic; dismissed topics hide what came
   * before the dismissal.
   */
  async gaps(client: ClientConfig, r: Range): Promise<GapsView> {
    const events = await this.gapEvents(client.id, r);
    const conversationIds = [...new Set(events.map((e) => e.conversationId))];
    const inbound = conversationIds.length
      ? await this.deps.db
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            text: messages.text,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              inArray(messages.conversationId, conversationIds),
              eq(messages.direction, 'inbound'),
              gte(messages.createdAt, new Date(r.from.getTime() - DAY)),
              lt(messages.createdAt, r.to),
            ),
          )
          .orderBy(asc(messages.createdAt))
      : [];
    const byConversation = new Map<string, typeof inbound>();
    for (const m of inbound) {
      const list = byConversation.get(m.conversationId) ?? [];
      list.push(m);
      byConversation.set(m.conversationId, list);
    }

    type Item = {
      at: Date;
      question: string;
      reasons: Set<GapReason>;
      reply: string | null;
      conversationId: string;
      queries: string[];
    };
    const items = new Map<string, Item>();
    for (const e of events) {
      const asked = (byConversation.get(e.conversationId) ?? [])
        .filter((m) => m.createdAt.getTime() <= e.at.getTime() && m.text)
        .at(-1);
      const question = asked?.text ?? e.fallback;
      if (!question) continue;
      const key = asked?.id ?? `${e.conversationId}:${e.at.getTime()}`;
      const item = items.get(key) ?? {
        at: asked?.createdAt ?? e.at,
        question,
        reasons: new Set<GapReason>(),
        reply: null,
        conversationId: e.conversationId,
        queries: [],
      };
      item.reasons.add(e.reason);
      if (e.reply && !item.reply) item.reply = e.reply;
      item.queries.push(...(e.queries ?? []));
      items.set(key, item);
    }

    const types = (
      await this.deps.db
        .selectDistinct({ type: products.productType })
        .from(products)
        .where(and(eq(products.clientId, client.id), isNotNull(products.productType)))
    ).map((t) => t.type!);
    const dismissed = new Map(
      (
        await this.deps.db
          .select()
          .from(insightGapDismissals)
          .where(eq(insightGapDismissals.clientId, client.id))
      ).map((d) => [d.topic, d.dismissedAt]),
    );

    const topics = new Map<string, Item[]>();
    for (const item of items.values()) {
      const topic = topicOf([item.question, ...item.queries].join(' '), types);
      const hiddenUntil = dismissed.get(topic);
      if (hiddenUntil && item.at.getTime() <= hiddenUntil.getTime()) continue;
      topics.set(topic, [...(topics.get(topic) ?? []), item]);
    }

    const list: GapTopic[] = [...topics].map(([topic, list]) => {
      const newest = [...list].sort((a, b) => b.at.getTime() - a.at.getTime());
      const reasons: Record<GapReason, number> = { deferred: 0, handoff: 0, no_result: 0 };
      for (const i of list) for (const reason of i.reasons) reasons[reason]++;
      return {
        topic,
        count: list.length,
        lastAt: newest[0]!.at.toISOString(),
        reasons,
        examples: newest.slice(0, EXAMPLES).map((i): GapExample => ({
          at: i.at.toISOString(),
          question: i.question,
          reasons: [...i.reasons],
          reply: i.reply,
          conversationId: i.conversationId,
        })),
      };
    });
    list.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
    return {
      from: r.from.toISOString(),
      to: r.to.toISOString(),
      total: list.reduce((n, t) => n + t.count, 0),
      topics: list,
    };
  }

  /** Hides a topic's questions up to now. Dismissing again moves the mark forward. */
  async dismiss(ctx: AdminContext, topic: string): Promise<void> {
    const now = this.now();
    await this.deps.db
      .insert(insightGapDismissals)
      .values({ clientId: ctx.client.id, topic, dismissedBy: ctx.member.id, dismissedAt: now })
      .onConflictDoUpdate({
        target: [insightGapDismissals.clientId, insightGapDismissals.topic],
        set: { dismissedAt: now, dismissedBy: ctx.member.id },
      });
  }
}

function branchFigures(facts: LeadFact[], r: Range): OverviewBranchFigures {
  const created = facts.filter((f) => within(f.createdAt, r));
  const closed = facts.filter((f) => within(f.closedAt, r));
  return {
    leads: created.filter((f) => f.type !== 'handoff').length,
    handoffs: created.filter((f) => f.type === 'handoff').length,
    won: closed.filter((f) => f.status === 'won').length,
    lost: closed.filter((f) => f.status === 'lost').length,
  };
}
