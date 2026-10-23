/**
 * Customer records and profiles (WA-027): the profile's allowed fields and their values, request
 * bodies and the JSON the admin API answers with, below /api/admin/clients/:clientId/customers.
 *
 * The profile holds factual service preferences only. Every value is checked by the same schemas
 * whether the agent (note_profile) or the team writes it, so nothing else can be stored.
 */
import { z } from 'zod';
import type { QuoteStatus } from './quotes.js';

export const customerRoles = [
  'private',
  'carpenter',
  'builder',
  'architect',
  'reseller',
  'other',
] as const;
export type CustomerRole = (typeof customerRoles)[number];

export const customerRoleLabels: Record<CustomerRole, string> = {
  private: 'Particular',
  carpenter: 'Carpinteiro',
  builder: 'Empreiteiro',
  architect: 'Arquiteto',
  reseller: 'Revendedor',
  other: 'Outro',
};

// ---------- Guardrail on free text ----------

/**
 * Word stems (a trailing `$`: the whole word) that would make a value sensitive (health, beliefs, origin, sexuality, family,
 * finances, age) or a judgement about the person. Matched at the start of a word, ignoring case
 * and accents. A safety net under the field list, not a classifier: the fields themselves only
 * describe how the customer likes to be served.
 */
const SENSITIVE_STEMS = [
  // health
  'saude',
  'doen',
  'diabet',
  'cancro',
  'cancer',
  'gravid',
  'pregnan',
  'deficien',
  'disab',
  'depress',
  'ansiedad',
  'anxiet',
  'medicament',
  'medicat',
  'hospital',
  'illness',
  'sick',
  'alcool',
  'alcohol',
  'droga$',
  'drogas$',
  'drug',
  'terapi',
  'therap',
  'psic',
  'psych',
  'mental',
  // beliefs and politics
  'relig',
  'catolic',
  'catholic',
  'muculman',
  'muslim',
  'islam',
  'judeu',
  'judia',
  'jewish',
  'igreja',
  'church',
  'mesquita',
  'mosque$',
  'evangel',
  'politic',
  'sindica',
  'trade union',
  'comunist',
  'socialist',
  'fascist',
  'esquerdist',
  'direitist',
  // origin and sexuality
  'raca$',
  'racial',
  'etnia',
  'etnic',
  'ethnic',
  'cigan',
  'gypsy',
  'nacionalidad',
  'nationalit',
  'imigra',
  'immigra',
  'sexual',
  'gay$',
  'lesbi',
  'homossex',
  'homosex',
  'transgen',
  'bissex',
  'bisex',
  // family, finances, age
  'divorc',
  'viuv',
  'widow',
  'casad',
  'married',
  'solteir',
  'filhos$',
  'children',
  'idade',
  'idoso',
  'idosa',
  'elderly',
  'rico$',
  'rica$',
  'rich$',
  'wealthy',
  'pobre',
  'poor$',
  'divida',
  'debt',
  'falid',
  'bankrupt',
  'salario',
  'salary',
  'rendimento',
  'income',
  'criminal',
  'prisao',
  'prison',
  // judgements about the person
  'dificil',
  'difficult',
  'chato$',
  'chata$',
  'annoying',
  'rude',
  'mal-educad',
  'malcriad',
  'desconfiad',
  'suspicious',
  'forreta',
  'stingy',
  'tacanh',
  'caloteir',
  'mentiros',
  'liar$',
  'burro$',
  'burra$',
  'stupid',
  'estupid',
  'agressiv',
  'aggressiv',
  'nervos',
  'irritant',
  'impacient',
  'impatient',
  'arrogant',
  'teimos',
  'stubborn',
  'preguic',
  'lazy$',
  'pateta',
  'idiot',
  'crazy',
];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

const sensitivePattern = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${SENSITIVE_STEMS.map((s) =>
    s.endsWith('$') ? `${s.slice(0, -1)}(?![\\p{L}\\p{N}])` : s,
  ).join('|')})`,
  'u',
);

/** Whether a free-text profile value looks sensitive or like a judgement about the person. */
export function isSensitiveText(text: string): boolean {
  return sensitivePattern.test(fold(text));
}

const SENSITIVE_MESSAGE =
  'Only factual service preferences: no health, beliefs, origin, family, finances, age or opinions about the person.';

/** A short factual text: trimmed, one line, no sensitive words. */
const factual = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'One line only.')
    .refine((s) => !isSensitiveText(s), SENSITIVE_MESSAGE);

// ---------- Profile fields ----------

export const profileUsualProductSchema = z
  .object({
    /** As the catalogue or the customer names it, e.g. "Deck Ipê 21x145". */
    name: factual(80),
    /** Shopify variant id when the agent knows it. */
    variant_id: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'Variant id: digits only.')
      .optional(),
    /** Typical quantity in the customer's words, e.g. "200 m²", "40 caixas". */
    quantity: factual(40).optional(),
  })
  .strict();
export type ProfileUsualProduct = z.infer<typeof profileUsualProductSchema>;

/** Every field the profile can hold, and the only values it accepts. */
export const profileValueSchemas = {
  /** Short answers (a price, a yes) or full explanations. */
  detail_level: z.enum(['short', 'full']),
  /** Plain words, or technical terms and specifications. */
  technical_depth: z.enum(['basic', 'technical']),
  /** Language the customer asked to be served in, e.g. `pt-PT`, `en`. */
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'A language code such as pt-PT or en.'),
  /** Products and typical quantities they buy again. */
  usual_products: z.array(profileUsualProductSchema).min(1).max(8),
  /** Kinds of jobs they do, e.g. "decks", "soalhos", "coberturas". */
  job_types: z.array(factual(40)).min(1).max(5),
  /** Delivery on site or pickup at a branch. */
  delivery: z.enum(['site', 'pickup']),
  /** Asks for a better price on volume. */
  negotiates_on_volume: z.boolean(),
  /** Price list the team applies. Set by the team only: prices are always decided by people. */
  price_tier: z.enum(['retail', 'professional', 'reseller']),
} as const;

export type ProfileField = keyof typeof profileValueSchemas;
export type ProfileValue<F extends ProfileField = ProfileField> = z.infer<
  (typeof profileValueSchemas)[F]
>;

export const profileFields = Object.keys(profileValueSchemas) as ProfileField[];

/** Fields the agent may propose with note_profile. `price_tier` is the team's alone. */
export const agentProfileFields: ProfileField[] = profileFields.filter((f) => f !== 'price_tier');

export const isProfileField = (f: string): f is ProfileField => f in profileValueSchemas;

export const profileFieldLabels: Record<ProfileField, string> = {
  detail_level: 'Nível de detalhe',
  technical_depth: 'Linguagem técnica',
  language: 'Língua preferida',
  usual_products: 'Produtos habituais',
  job_types: 'Tipos de obra',
  delivery: 'Entrega',
  negotiates_on_volume: 'Negocia por volume',
  price_tier: 'Tabela de preços',
};

/** pt-PT labels of the enum values, for the dashboard. */
export const profileValueLabels: Record<string, string> = {
  short: 'Respostas curtas',
  full: 'Explicações completas',
  basic: 'Palavras simples',
  technical: 'Técnica',
  site: 'Entrega em obra',
  pickup: 'Levanta na loja',
  retail: 'Público',
  professional: 'Profissional',
  reseller: 'Revenda',
};

/** A value checked against its field's schema: the value, or the first problem. */
export function parseProfileValue(
  field: ProfileField,
  value: unknown,
): { ok: true; value: ProfileValue } | { ok: false; message: string } {
  const parsed = profileValueSchemas[field].safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as ProfileValue };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, message: `${where}${issue?.message ?? 'invalid value'}` };
}

/** Whether the profile is used: off for the whole client (config) or for this customer. */
export type ProfilingState = 'on' | 'opted_out' | 'disabled';

export interface CustomerProfileFieldView {
  field: ProfileField;
  /** Null for a field the team locked empty (the agent must not fill it). */
  value: ProfileValue | null;
  source: 'agent' | 'team';
  locked: boolean;
  /** Why: the customer's own words the agent noted it from. */
  evidence: string | null;
  conversationId: string | null;
  updatedAt: string;
  /** Name or email of the member who last edited it; null for the agent. */
  updatedBy: string | null;
}

// ---------- Records ----------

export interface CustomerContactView {
  id: string;
  /** WhatsApp number, digits only. */
  phone: string;
  /** WhatsApp profile name. */
  name: string | null;
  language: string | null;
  profilingOptOut: boolean;
  createdAt: string;
}

export interface CustomerListItem {
  id: string;
  /** The record's name, or the first contact's WhatsApp name. */
  name: string | null;
  company: string | null;
  role: CustomerRole | null;
  phones: string[];
  lastActivityAt: string;
  conversations: number;
  leads: number;
  profiling: ProfilingState;
}

export interface CustomerList {
  items: CustomerListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CustomerConversationView {
  id: string;
  contactId: string;
  status: 'bot' | 'human' | 'closed';
  createdAt: string;
  lastActivityAt: string;
  messages: number;
  /** The latest message, shortened. */
  lastText: string | null;
}

export interface CustomerLeadView {
  id: string;
  /** info, quote, sample, order (an order draft) or handoff. */
  type: string;
  status: string;
  branchId: string | null;
  branchName: string | null;
  createdAt: string;
  products: string | null;
  summary: string | null;
}

/** A quote (WA-025) for one of the record's numbers. */
export interface CustomerQuoteView {
  id: string;
  number: string;
  status: QuoteStatus;
  leadId: string | null;
  branchName: string | null;
  totalCents: number;
  validUntil: string;
  createdAt: string;
  sentAt: string | null;
}

export interface CustomerNoteView {
  id: string;
  body: string;
  author: { id: string; name: string | null; email: string } | null;
  createdAt: string;
}

export interface CustomerDetail {
  id: string;
  name: string | null;
  company: string | null;
  nif: string | null;
  role: CustomerRole | null;
  regions: string[];
  createdAt: string;
  updatedAt: string;
  contacts: CustomerContactView[];
  conversations: CustomerConversationView[];
  /** Leads and order drafts (type `order`), newest first; for sales, of their branches only. */
  leads: CustomerLeadView[];
  /** Quotes (WA-025), newest first; for sales, of their branches only. */
  quotes: CustomerQuoteView[];
  notes: CustomerNoteView[];
  profile: { state: ProfilingState; fields: CustomerProfileFieldView[] };
}

// ---------- Request bodies ----------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable();

/** PATCH /customers/:id. */
export const updateCustomerSchema = z
  .object({
    name: optionalText(120),
    company: optionalText(160),
    nif: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ''))
      .refine((s) => s === '' || /^[A-Z]{0,2}\d{9}$/i.test(s), 'NIF: 9 algarismos.')
      .transform((s) => s || null)
      .nullable(),
    role: z.enum(customerRoles).nullable(),
    regions: z.array(z.string().trim().min(1).max(60)).max(10),
  })
  .partial()
  .strict();
export type UpdateCustomerBody = z.input<typeof updateCustomerSchema>;

/** POST /customers/:id/notes. */
export const addCustomerNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });

/** PUT /customers/:id/profile/:field: the team sets a value (checked per field) and the lock. */
export const setProfileFieldSchema = z
  .object({ value: z.unknown().optional(), locked: z.boolean().optional() })
  .strict();
export type SetProfileFieldBody = z.infer<typeof setProfileFieldSchema>;

/** POST /customers/:id/contacts: link another WhatsApp number to the record. */
export const linkCustomerContactSchema = z.object({
  phone: z
    .string()
    .trim()
    .transform((s) => s.replace(/\D+/g, ''))
    .refine((s) => s.length >= 9 && s.length <= 15, 'Número com indicativo, ex.: 351912345678.'),
});

/** GET /customers query. */
export const customerListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(customerRoles).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
