/**
 * Quote drafts (WA-025): the lines, discounts and IVA of a quote, the maths that turns them into
 * totals, and what the dashboard and the API at /api/admin/clients/:clientId/quotes exchange.
 *
 * Totals are computed here, by code, on scaled integers: never by the model. The API computes
 * them for the PDF and what it stores; the dashboard runs the same function to show them live.
 *
 * Unit prices are net (without IVA), with up to 4 decimals so that a catalogue price with IVA
 * included converts back without drifting (25,00 € with 23 % → 20,3252 € net → 25,00 €).
 */
import { z } from 'zod';

/** Decimals kept for each kind of number. */
const QTY_DP = 3;
const PRICE_DP = 4;
const PERCENT_DP = 2;
const MONEY_DP = 2;

const hasDecimals = (dp: number) => (v: number) => {
  const scaled = v * 10 ** dp;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

const decimal = (dp: number, label: string) =>
  z
    .number({ error: `${label}: indique um número.` })
    .refine(Number.isFinite, `${label}: indique um número.`)
    .refine(hasDecimals(dp), `${label}: no máximo ${dp} casas decimais.`);

export const quoteStatuses = ['draft', 'sent'] as const;
export type QuoteStatus = (typeof quoteStatuses)[number];

export const quoteStatusLabels: Record<QuoteStatus, string> = {
  draft: 'Rascunho',
  sent: 'Enviado',
};

export const quoteChannels = ['whatsapp', 'email'] as const;
export const quoteChannelSchema = z.enum(quoteChannels);
export type QuoteChannel = z.infer<typeof quoteChannelSchema>;

export const quoteChannelLabels: Record<QuoteChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
};

export const quoteLineSchema = z.object({
  /** Catalogue variant the line came from, if any. */
  variantId: z.string().max(64).nullable().default(null),
  sku: z.string().trim().max(64).nullable().default(null),
  description: z.string().trim().min(1, 'Descreva a linha.').max(300),
  quantity: decimal(QTY_DP, 'Quantidade')
    .refine((v) => v > 0, 'Quantidade: tem de ser maior que zero.')
    .refine((v) => v <= 1_000_000, 'Quantidade: demasiado grande.'),
  /** Short unit shown on the quote: un, cx, m², m. */
  unit: z.string().trim().min(1).max(10).default('un'),
  /** Net unit price in euros, without IVA. */
  unitPrice: decimal(PRICE_DP, 'Preço')
    .refine((v) => v >= 0, 'Preço: não pode ser negativo.')
    .refine((v) => v <= 10_000_000, 'Preço: demasiado grande.'),
  discountPercent: decimal(PERCENT_DP, 'Desconto')
    .refine((v) => v >= 0 && v <= 100, 'Desconto: entre 0 e 100 %.')
    .default(0),
  vatPercent: decimal(PERCENT_DP, 'IVA').refine((v) => v >= 0 && v <= 100, 'IVA: entre 0 e 100 %.'),
});
export type QuoteLine = z.output<typeof quoteLineSchema>;
export type QuoteLineInput = z.input<typeof quoteLineSchema>;

/** A discount on the whole quote, on top of the line discounts: a percentage or an amount. */
export const quoteDiscountSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('percent'),
      value: decimal(PERCENT_DP, 'Desconto global').refine(
        (v) => v >= 0 && v <= 100,
        'Desconto global: entre 0 e 100 %.',
      ),
    }),
    z.object({
      kind: z.literal('amount'),
      /** Euros, taken off the net subtotal (before IVA). */
      value: decimal(MONEY_DP, 'Desconto global').refine(
        (v) => v >= 0 && v <= 100_000_000,
        'Desconto global: valor inválido.',
      ),
    }),
  ])
  .nullable();
export type QuoteDiscount = z.output<typeof quoteDiscountSchema>;

export const quoteCustomerSchema = z.object({
  name: z.string().trim().max(160).nullable().default(null),
  company: z.string().trim().max(160).nullable().default(null),
  nif: z.string().trim().max(20).nullable().default(null),
  email: z
    .union([z.email('Email inválido.'), z.literal('')])
    .nullable()
    .default(null)
    .transform((v) => v || null),
  phone: z.string().trim().max(40).nullable().default(null),
  address: z.string().trim().max(300).nullable().default(null),
});
export type QuoteCustomer = z.output<typeof quoteCustomerSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');

/** PUT /quotes/:id: everything the salesperson edits. */
export const quoteDraftSchema = z.object({
  customer: quoteCustomerSchema,
  lines: z.array(quoteLineSchema).max(100, 'No máximo 100 linhas.'),
  discount: quoteDiscountSchema.default(null),
  /** Last day the quote is valid. */
  validUntil: isoDate,
  /** Delivery or pickup, as shown on the quote. */
  fulfilment: z.string().trim().max(300).nullable().default(null),
  /** Shown on the quote, above the conditions. */
  notes: z.string().trim().max(4000).nullable().default(null),
});
export type QuoteDraft = z.output<typeof quoteDraftSchema>;
export type QuoteDraftInput = z.input<typeof quoteDraftSchema>;

/** POST /quotes: a new draft for a lead, prefilled from what the agent gathered. */
export const createQuoteSchema = z.object({ leadId: z.uuid() });
export type CreateQuoteBody = z.infer<typeof createQuoteSchema>;

/** POST /quotes/:id/send. Email goes to `email` (default: the customer's on the quote). */
export const sendQuoteSchema = z.object({
  channel: quoteChannelSchema,
  email: z.email('Email inválido.').optional(),
  /** Caption of the WhatsApp document, or the email's text. */
  message: z.string().trim().max(1000).optional(),
});
export type SendQuoteBody = z.infer<typeof sendQuoteSchema>;

// ---------- Totals ----------

export interface QuoteLineTotals {
  /** quantity × unit price, rounded to cents. */
  grossCents: number;
  discountCents: number;
  /** gross − discount: the line total without IVA. */
  netCents: number;
}

export interface QuoteVatGroup {
  percent: number;
  /** Net amount at this rate, after the global discount. */
  baseCents: number;
  vatCents: number;
}

export interface QuoteTotals {
  lines: QuoteLineTotals[];
  /** Sum of the line totals (after line discounts), without IVA. */
  subtotalCents: number;
  /** The global discount in euros (cents), at most the subtotal. */
  discountCents: number;
  /** subtotal − global discount: the taxable amount. */
  netCents: number;
  /** One group per IVA rate, highest rate first. */
  vat: QuoteVatGroup[];
  vatCents: number;
  totalCents: number;
}

const scaled = (v: number, dp: number) => BigInt(Math.round(v * 10 ** dp));

/** a / b rounded half up, for a ≥ 0 and b > 0. */
const divRound = (a: bigint, b: bigint) => (a * 2n + b) / (b * 2n);

/**
 * Line totals, discounts, IVA per rate and the total of a quote, in cents. Every amount is rounded
 * half up to the cent once, where an invoice would round it: each line, the line discount, the
 * global discount, and the IVA of each rate on its (discounted) base. A global discount is spread
 * over the IVA rates in proportion to their net amounts (largest remainder).
 */
export function computeQuoteTotals(
  lines: Pick<QuoteLine, 'quantity' | 'unitPrice' | 'discountPercent' | 'vatPercent'>[],
  discount: QuoteDiscount = null,
): QuoteTotals {
  const lineTotals = lines.map((l) => {
    // quantity (10^3) × price (10^4) = 10^7; cents are 10^2.
    const gross = divRound(scaled(l.quantity, QTY_DP) * scaled(l.unitPrice, PRICE_DP), 100_000n);
    const disc = divRound(gross * scaled(l.discountPercent ?? 0, PERCENT_DP), 10_000n);
    return { gross, disc, net: gross - disc };
  });
  const subtotal = lineTotals.reduce((s, l) => s + l.net, 0n);

  let globalDiscount = 0n;
  if (discount?.kind === 'percent') {
    globalDiscount = divRound(subtotal * scaled(discount.value, PERCENT_DP), 10_000n);
  } else if (discount?.kind === 'amount') {
    globalDiscount = scaled(discount.value, MONEY_DP);
  }
  if (globalDiscount > subtotal) globalDiscount = subtotal;

  // Net per IVA rate (rates in hundredths of a percent).
  const byRate = new Map<bigint, bigint>();
  lines.forEach((l, i) => {
    const rate = scaled(l.vatPercent, PERCENT_DP);
    byRate.set(rate, (byRate.get(rate) ?? 0n) + lineTotals[i]!.net);
  });
  const groups = [...byRate.entries()]
    .map(([rate, net]) => ({ rate, net, share: 0n, remainder: 0n }))
    .sort((a, b) => (a.rate === b.rate ? 0 : a.rate > b.rate ? -1 : 1));

  // Spread the global discount: floor shares, then the leftover cents by largest remainder.
  if (globalDiscount > 0n && subtotal > 0n) {
    let given = 0n;
    for (const g of groups) {
      g.share = (globalDiscount * g.net) / subtotal;
      g.remainder = (globalDiscount * g.net) % subtotal;
      given += g.share;
    }
    const order = [...groups].sort((a, b) =>
      a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1,
    );
    for (let i = 0; given < globalDiscount; i++, given++) order[i % order.length]!.share += 1n;
  }

  const vat = groups.map((g) => {
    const base = g.net - g.share;
    return {
      percent: Number(g.rate) / 100,
      baseCents: Number(base),
      vatCents: Number(divRound(base * g.rate, 10_000n)),
    };
  });
  const net = subtotal - globalDiscount;
  const vatCents = vat.reduce((s, g) => s + g.vatCents, 0);
  return {
    lines: lineTotals.map((l) => ({
      grossCents: Number(l.gross),
      discountCents: Number(l.disc),
      netCents: Number(l.net),
    })),
    subtotalCents: Number(subtotal),
    discountCents: Number(globalDiscount),
    netCents: Number(net),
    vat,
    vatCents,
    totalCents: Number(net) + vatCents,
  };
}

/**
 * The net unit price (4 decimals) of a price with IVA included, e.g. a catalogue price:
 * 25 € at 23 % → 20,3252 €.
 */
export function netFromGross(grossEuros: number, vatPercent: number): number {
  const gross = scaled(grossEuros, PRICE_DP); // in 10^-4 €
  const factor = 10_000n + scaled(vatPercent, PERCENT_DP); // (1 + rate) in 10^-4
  return Number(divRound(gross * 10_000n, factor)) / 10 ** PRICE_DP;
}

/** "1 234,56 €" (pt-PT). */
export function formatCents(cents: number): string {
  return `${formatDecimal(cents / 100, 2, 2)} €`;
}

/** A number in pt-PT with a space as thousands separator and a comma for decimals. */
export function formatDecimal(value: number, minDp: number, maxDp: number): string {
  const fixed = value.toFixed(maxDp);
  let [int = '0', frac = ''] = fixed.replace('-', '').split('.');
  frac = frac.replace(/0+$/, '');
  if (frac.length < minDp) frac = frac.padEnd(minDp, '0');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 && Number(fixed) !== 0 ? '-' : ''}${int}${frac ? `,${frac}` : ''}`;
}

// ---------- API answers ----------

export interface QuotePerson {
  id: string;
  name: string | null;
  email: string;
}

/** One delivery of a sent quote. */
export interface QuoteSend {
  channel: QuoteChannel;
  /** Email address, or the WhatsApp number. */
  to: string;
  at: string;
  by: QuotePerson | null;
}

export interface QuoteListItem {
  id: string;
  number: string;
  status: QuoteStatus;
  leadId: string | null;
  customerName: string | null;
  totalCents: number;
  validUntil: string;
  createdAt: string;
  sentAt: string | null;
}

export interface QuoteDetail extends QuoteDraft {
  id: string;
  number: string;
  status: QuoteStatus;
  leadId: string | null;
  branchId: string | null;
  branchName: string | null;
  totals: QuoteTotals;
  /** The client's IVA rate, for new lines. */
  defaultVatPercent: number;
  /** Whether the quote can go to the customer's WhatsApp (the lead has a conversation). */
  canSendWhatsapp: boolean;
  sends: QuoteSend[];
  createdBy: QuotePerson | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}
