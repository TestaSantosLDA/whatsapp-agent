/**
 * Overview and "couldn't answer" list (WA-029): what the API at
 * /api/admin/clients/:clientId/overview answers, for the dashboard's Resumo screen.
 */
import { z } from 'zod';
import type { LostReason } from './leads.js';

/** handoff_to_human reasons (WA-016), as the Overview shows them. */
export const handoffReasonLabels: Record<string, string> = {
  customer_asked: 'O cliente pediu uma pessoa',
  complaint: 'Reclamação',
  repeated_misunderstanding: 'Não se entenderam',
  needs_decision: 'Precisa de uma decisão',
  large_project: 'Projeto grande',
  could_not_help: 'Faltava informação',
  other: 'Outro motivo',
};

/** A count per key, with the pt-PT label to show. */
export interface OverviewCount<K extends string = string> {
  key: K;
  label: string;
  count: number;
}

/** The figures of one period (this week or this month, so far). */
export interface OverviewFigures {
  /** ISO times: the period starts at local midnight (Monday, or the 1st) and ends now. */
  from: string;
  to: string;
  /** Conversations with at least one customer message in the period. */
  conversations: number;
  /** Leads saved in the period, handoffs excluded. */
  leads: number;
  leadsByType: OverviewCount[];
  /** Conversations handed to a person (handoff leads) in the period. */
  handoffs: number;
  handoffsByReason: OverviewCount[];
  /** Leads that moved to `quoted` in the period (the pipeline status, WA-024). */
  quoted: number;
  /** Quotes sent from the dashboard (WA-025) in the period, counted once, on their first send. */
  quotesSent: number;
  /** Leads closed in the period. */
  won: number;
  lost: number;
  lostByReason: OverviewCount<LostReason>[];
  /**
   * The team's first response to the leads saved in the period: from saved to whichever comes
   * first, leaving `new` (WA-024's `contacted_at`) or a reply sent from the inbox (WA-023).
   */
  firstResponse: {
    /** Leads that have had a first response. */
    answered: number;
    /** Leads of the period still waiting (status `new`, no inbox reply yet). */
    waiting: number;
    medianMinutes: number | null;
    /** The same, counting only the branch's opening hours (like the no-reply reminders). */
    medianWorkingMinutes: number | null;
  };
  /** Claude's cost in the period. Admins, all branches only (it is not split by branch). */
  cost: {
    /** Agent turns. */
    turns: number;
    agentUsd: number;
    /** Reading uploaded documents (WA-026). */
    documentsUsd: number;
    totalUsd: number;
  } | null;
}

/** A branch's leads at a glance, for the table under the figures. */
export interface OverviewBranchFigures {
  leads: number;
  handoffs: number;
  won: number;
  lost: number;
}

export interface OverviewBranchRow {
  branchId: string;
  name: string;
  week: OverviewBranchFigures;
  month: OverviewBranchFigures;
}

export interface OverviewView {
  generatedAt: string;
  timezone: string;
  /** The branch filter in effect; null: every branch the member sees. */
  branch: string | null;
  week: OverviewFigures;
  month: OverviewFigures;
  branches: OverviewBranchRow[];
}

/** GET /overview?branch= */
export const overviewQuerySchema = z.object({
  branch: z.string().min(1).max(100).optional(),
});

/** GET /overview/products and /overview/gaps: the last `days` days. */
export const insightsRangeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export interface AskedProduct {
  productId: string;
  title: string;
  /** Conversations in which the agent looked it up or showed it. */
  conversations: number;
  /** Look-ups and cards in total. */
  mentions: number;
}

/** A search of the catalogue that found nothing: likely a product the store does not sell. */
export interface MissingSearch {
  /** The search words, as the agent last wrote them. */
  query: string;
  searches: number;
  conversations: number;
  lastAt: string;
}

export interface OverviewProductsView {
  from: string;
  to: string;
  products: AskedProduct[];
  missingSearches: MissingSearch[];
}

/**
 * Why a customer's question counts as "couldn't answer": the agent said it would check with a
 * colleague, handed over because it could not help, or a search (catalogue or documents) found
 * nothing.
 */
export const gapReasons = ['deferred', 'handoff', 'no_result'] as const;
export type GapReason = (typeof gapReasons)[number];

export const gapReasonLabels: Record<GapReason, string> = {
  deferred: 'Ficou de confirmar com um colega',
  handoff: 'Passou à equipa por falta de informação',
  no_result: 'A pesquisa não encontrou nada',
};

export interface GapExample {
  at: string;
  /** The customer's message the agent could not answer. */
  question: string;
  reasons: GapReason[];
  /** What the agent said when it deferred, if it did. */
  reply: string | null;
  conversationId: string | null;
}

export interface GapTopic {
  topic: string;
  count: number;
  lastAt: string;
  reasons: Record<GapReason, number>;
  /** Newest first, at most three. */
  examples: GapExample[];
}

export interface GapsView {
  from: string;
  to: string;
  /** Questions in every topic shown. */
  total: number;
  topics: GapTopic[];
}

/** POST /overview/gaps/dismiss: hides a topic's questions so far; new ones show again. */
export const dismissGapSchema = z.object({ topic: z.string().trim().min(1).max(100) });
export type DismissGapBody = z.infer<typeof dismissGapSchema>;
