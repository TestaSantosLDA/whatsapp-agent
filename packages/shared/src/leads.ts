/**
 * The leads pipeline in the team dashboard (WA-024): statuses, owners, notes and activity, as the
 * API at /api/admin/clients/:clientId/leads answers them.
 */
import { z } from 'zod';

export const leadStatuses = ['new', 'contacted', 'quoted', 'won', 'lost'] as const;
export const leadStatusSchema = z.enum(leadStatuses);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

export const leadStatusLabels: Record<LeadStatus, string> = {
  new: 'Novo',
  contacted: 'Contactado',
  quoted: 'Orçamentado',
  won: 'Ganho',
  lost: 'Perdido',
};

/** Why a lead was lost: a short list, so the Overview (WA-029) can count them. */
export const lostReasons = [
  'price',
  'competitor',
  'no_reply',
  'stock_or_lead_time',
  'out_of_area',
  'gave_up',
  'other',
] as const;
export const lostReasonSchema = z.enum(lostReasons);
export type LostReason = z.infer<typeof lostReasonSchema>;

export const lostReasonLabels: Record<LostReason, string> = {
  price: 'Preço',
  competitor: 'Comprou noutro lado',
  no_reply: 'O cliente deixou de responder',
  stock_or_lead_time: 'Sem stock ou prazo longo',
  out_of_area: 'Fora da zona de serviço',
  gave_up: 'Desistiu do projeto',
  other: 'Outro motivo',
};

/** Lead types: the client's request types (info, quote, sample, order) and `handoff`. */
export const leadTypeLabels: Record<string, string> = {
  info: 'Informação',
  quote: 'Orçamento',
  sample: 'Amostra',
  order: 'Encomenda',
  handoff: 'Passagem para a equipa',
};

export const leadTypeLabel = (type: string): string => leadTypeLabels[type] ?? type;

/** What the activity history records. `created` carries the automatic owner. */
export type LeadEventKind =
  'created' | 'status' | 'owner' | 'note' | 'reminder_owner' | 'reminder_admin';

export interface AdminLeadPerson {
  id: string;
  name: string | null;
  email: string;
}

export interface AdminLeadListItem {
  id: string;
  createdAt: string;
  type: string;
  branchId: string | null;
  branchName: string | null;
  status: LeadStatus;
  lostReason: LostReason | null;
  owner: AdminLeadPerson | null;
  /** The customer's name, from the lead or their contact. */
  name: string | null;
  /** +351…, from the lead or the contact's WhatsApp number. */
  phone: string | null;
  summary: string | null;
  /** Products or project as the agent noted them; order lines for an order draft. */
  products: string | null;
  conversationId: string | null;
  /** Working hours of the branch since the lead arrived, while it is `new`; else null. */
  waitingHours: number | null;
  /** Still `new` after the client's response time (in working hours). */
  overdue: boolean;
}

export interface AdminLeadList {
  items: AdminLeadListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminLeadAttachment {
  type: string;
  messageId: string | null;
  mediaId: string | null;
  caption: string | null;
}

export interface AdminLeadNote {
  id: string;
  body: string;
  author: AdminLeadPerson | null;
  createdAt: string;
}

export interface AdminLeadEvent {
  id: string;
  kind: LeadEventKind;
  /** Who did it; null for the assistant and the scheduled reminders. */
  actor: AdminLeadPerson | null;
  /**
   * created: `{ owner, rule }`; status: `{ from, to, lostReason?, noteId? }`; owner: `{ from, to }` (member
   * ids, with `fromName` / `toName`); note: `{ noteId }`; reminder_*: `{ to: string[], hours }`.
   */
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AdminLeadDetail extends AdminLeadListItem {
  /** Everything the agent collected. */
  fields: Record<string, unknown>;
  attachments: AdminLeadAttachment[];
  contact: { id: string; name: string | null; waId: string } | null;
  contactedAt: string | null;
  quotedAt: string | null;
  closedAt: string | null;
  ownerRemindedAt: string | null;
  adminRemindedAt: string | null;
  /** The client's response time in working hours (`lead.response_time_hours`, default 8). */
  responseTimeHours: number;
  notes: AdminLeadNote[];
  /** Newest first. */
  events: AdminLeadEvent[];
  /** Who may own this lead: the branch's members and the client's admins. */
  owners: AdminLeadPerson[];
}

const commaList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

/** Query string of GET /leads and GET /leads/export.csv. Lists are comma separated. */
export const leadListQuerySchema = z.object({
  branch: commaList,
  /** Lead types, e.g. `info,quote,sample`, `order` or `handoff`. */
  type: commaList,
  status: commaList.pipe(z.array(leadStatusSchema)),
  /** `me`, `none` or a member id. */
  owner: z.string().trim().optional(),
  /** Name, phone or product. */
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LeadListQuery = z.input<typeof leadListQuerySchema>;

export const updateLeadStatusSchema = z
  .object({
    status: leadStatusSchema,
    lostReason: lostReasonSchema.optional(),
    /** Optional note added with the change (e.g. details of why it was lost). */
    note: z.string().trim().max(4000).optional(),
  })
  .refine((b) => b.status !== 'lost' || b.lostReason, {
    message: 'Indique o motivo da perda.',
    path: ['lostReason'],
  });
export type UpdateLeadStatusBody = z.input<typeof updateLeadStatusSchema>;

export const updateLeadOwnerSchema = z.object({ ownerId: z.uuid().nullable() });
export type UpdateLeadOwnerBody = z.infer<typeof updateLeadOwnerSchema>;

export const addLeadNoteSchema = z.object({
  body: z.string().trim().min(1, 'Escreva a nota.').max(4000),
});
export type AddLeadNoteBody = z.infer<typeof addLeadNoteSchema>;
