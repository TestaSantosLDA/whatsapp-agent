/**
 * "Couldn't answer" (WA-029): how a deferral, a handoff for lack of information or an empty
 * search is recognised in the data the agent already writes, and how questions are grouped
 * into topics without calling Claude.
 */
import type { GapReason } from '@wa/shared';
import type { ToolCallRecord } from '../../agent/claude-responder.js';

/**
 * The agent saying it will check with a colleague (pt, en, es, fr), as the system prompt asks it
 * to when a tool or the policies lack the answer. "A colleague will reply here" (a handoff) is
 * not a deferral: handoffs are counted from their lead and only when the agent could not help.
 */
const DEFERRAL =
  /\b(confirm(ar|o|amos)|verific(ar|o|amos)|pergunt(ar|o|amos)|consult(ar|o|amos)|check(ing)?|confirm(ing)?|ask(ing)?|v[ée]rifier|confirmer|demander)\b[^.!?\n]{0,50}\b(colega|colleague|compa[ñn]er[oa]|coll[èe]gue|equipa|team)/i;

export function isDeferral(text: string | null | undefined): boolean {
  return !!text && DEFERRAL.test(text);
}

/** Handoff reasons that mean the agent lacked the information (handoff_to_human `reason`). */
export const NO_INFO_HANDOFF_REASONS = ['could_not_help'];

/** Tools whose empty result means the agent had nothing to answer with. */
const SEARCH_TOOLS = ['search_products', 'search_documents'] as const;

function parsed(output: string | undefined): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null; // shortened output: it had results
  }
}

/** Whether a successful search call returned nothing; undefined when it is not a search. */
export function searchFoundNothing(call: ToolCallRecord): boolean | undefined {
  if (!call.ok || !(SEARCH_TOOLS as readonly string[]).includes(call.name)) return undefined;
  const out = parsed(call.output);
  if (!out) return false;
  if (call.name === 'search_products') return out['count'] === 0;
  return Array.isArray(out['results']) && out['results'].length === 0;
}

/** The search words of a search call. */
export function searchQuery(call: ToolCallRecord): string | null {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const words = [input['query'], input['use']].filter(
    (w): w is string => typeof w === 'string' && w.trim() !== '',
  );
  return words.length ? words.join(' ').trim() : null;
}

/**
 * Searches of one turn that found nothing, when no other search with the same tool in that
 * turn found something (the agent retried with other words and then answered).
 */
export function emptySearches(calls: ToolCallRecord[]): ToolCallRecord[] {
  const empty = calls.filter((c) => searchFoundNothing(c) === true);
  return empty.filter(
    (c) => !calls.some((other) => other.name === c.name && searchFoundNothing(other) === false),
  );
}

/** Lower case, without accents or punctuation, single spaces. */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Themes for questions that name no product type. Stems match the start of a word. */
export const THEMES: { topic: string; stems: string[] }[] = [
  {
    topic: 'Entregas e transporte',
    stems: ['entreg', 'transport', 'envio', 'enviar', 'portes', 'deliver', 'shipping', 'recolh'],
  },
  {
    topic: 'Instalação e manutenção',
    stems: ['instal', 'montag', 'assent', 'aplic', 'manuten', 'limp', 'tratament'],
  },
  {
    topic: 'Especificações técnicas',
    stems: [
      'medid',
      'dimens',
      'espessur',
      'densidad',
      'peso',
      'resisten',
      'classe',
      'ficha',
      'tecnic',
      'espacament',
      'largur',
      'comprim',
    ],
  },
  { topic: 'Stock e prazos', stems: ['stock', 'dispon', 'prazo', 'esgot', 'reposi'] },
  { topic: 'Preços e descontos', stems: ['preco', 'precos', 'desconto', 'price', 'custa', 'iva'] },
  { topic: 'Garantia e devoluções', stems: ['garanti', 'devol', 'troca', 'reclama', 'warrant'] },
  {
    topic: 'Encomendas e faturas',
    stems: ['fatur', 'encomend', 'pagament', 'pagar', 'invoice', 'recibo'],
  },
  { topic: 'Lojas e horários', stems: ['horari', 'morada', 'loja', 'aberto', 'abrem', 'fecham'] },
];

export const OTHER_TOPIC = 'Outros';

const words = (text: string) => normalise(text).split(' ').filter(Boolean);

/**
 * The topic of a question: the most specific catalogue product type it names (every word of the
 * type, allowing plurals), else the first theme with a matching word, else "Outros".
 */
export function topicOf(text: string, productTypes: string[]): string {
  const said = words(text);
  const has = (stem: string) => said.some((w) => w.startsWith(stem));
  let best: { type: string; size: number } | null = null;
  for (const type of productTypes) {
    const parts = words(type).filter((w) => w.length >= 3);
    if (parts.length === 0 || !parts.every(has)) continue;
    if (!best || parts.length > best.size) best = { type, size: parts.length };
  }
  if (best) return best.type;
  for (const theme of THEMES) if (theme.stems.some(has)) return theme.topic;
  return OTHER_TOPIC;
}

/** One sign that the agent could not answer, before it is matched to the customer's question. */
export interface GapEvent {
  conversationId: string;
  at: Date;
  reason: GapReason;
  /** The agent's deferral message. */
  reply?: string;
  /** Search words of an empty search, to help find the topic. */
  queries?: string[];
  /** Used when the customer's message cannot be found (the handoff summary). */
  fallback?: string;
}
