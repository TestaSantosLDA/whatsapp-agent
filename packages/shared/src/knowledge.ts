/**
 * Knowledge base (WA-026): files the team uploads (technical sheets, price lists, catalogues),
 * the product data Claude proposes from them, and what the dashboard and the API exchange.
 */
import { z } from 'zod';

/** Largest file the API accepts. */
export const KNOWLEDGE_MAX_BYTES = 20 * 1024 * 1024;

/** File kinds the API accepts, by extension, with the content types stored for them. */
export const KNOWLEDGE_FILE_TYPES = {
  pdf: { label: 'PDF', mime: 'application/pdf' },
  xlsx: {
    label: 'Excel',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  csv: { label: 'CSV', mime: 'text/csv' },
  docx: {
    label: 'Word',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  png: { label: 'Imagem', mime: 'image/png' },
  jpg: { label: 'Imagem', mime: 'image/jpeg' },
} as const;
export type KnowledgeFileType = keyof typeof KNOWLEDGE_FILE_TYPES;

/** `accept` attribute for the file picker. */
export const KNOWLEDGE_ACCEPT =
  '.pdf,.xlsx,.csv,.docx,.png,.jpg,.jpeg,' +
  Object.values(KNOWLEDGE_FILE_TYPES)
    .map((t) => t.mime)
    .join(',');

/** The file type for a file name (by extension), or null when it is not accepted. */
export function knowledgeFileType(filename: string): KnowledgeFileType | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpeg') return 'jpg';
  return ext in KNOWLEDGE_FILE_TYPES ? (ext as KnowledgeFileType) : null;
}

export const documentStatuses = ['processing', 'needs_review', 'live', 'failed'] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export const proposalStatuses = ['pending', 'approved', 'rejected', 'edited'] as const;
export type ProposalStatus = (typeof proposalStatuses)[number];

/** Product fields Claude may propose. Approved values land in the product's `extra` data. */
export const productFields = [
  'm2_per_box',
  'dimensions',
  'weight_kg',
  'special_transport',
  'finishes',
] as const;
export type ProductField = (typeof productFields)[number];
export const productFieldSchema = z.enum(productFields);

export const PRODUCT_FIELD_LABELS: Record<ProductField, string> = {
  m2_per_box: 'm² por caixa',
  dimensions: 'Dimensões',
  weight_kg: 'Peso (kg)',
  special_transport: 'Transporte especial',
  finishes: 'Acabamentos',
};

export type ProductFieldValue = number | string | boolean | string[];

/**
 * A field value as stored, from text as Claude or a person wrote it ("2,2", "sim", "Natural;
 * Óleo"). Throws with a pt-PT message when the text does not fit the field.
 */
export function coerceProductField(field: ProductField, raw: unknown): ProductFieldValue {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  switch (field) {
    case 'm2_per_box':
    case 'weight_kg': {
      const n =
        typeof text === 'number'
          ? text
          : Number(
              String(text ?? '')
                .replace(/\s|m²|m2|kg/gi, '')
                .replace(',', '.'),
            );
      if (!Number.isFinite(n) || n <= 0) throw new Error('Indique um número maior que zero.');
      return Math.round(n * 10000) / 10000;
    }
    case 'special_transport': {
      if (typeof text === 'boolean') return text;
      const s = String(text ?? '').toLowerCase();
      if (['true', 'sim', 'yes', '1', 's'].includes(s)) return true;
      if (['false', 'não', 'nao', 'no', '0', 'n'].includes(s)) return false;
      throw new Error('Indique sim ou não.');
    }
    case 'finishes': {
      const list = Array.isArray(text) ? text.map(String) : String(text ?? '').split(/[;,\n]/);
      const clean = list.map((s) => s.trim()).filter(Boolean);
      if (clean.length === 0) throw new Error('Indique pelo menos um acabamento.');
      return clean;
    }
    case 'dimensions': {
      const s = String(text ?? '').trim();
      if (!s) throw new Error('Indique as dimensões.');
      return s.slice(0, 200);
    }
  }
}

/** A stored value as text, for display and for the edit box. */
export function formatProductField(field: ProductField, value: unknown): string {
  if (field === 'special_transport') return value === true ? 'sim' : value === false ? 'não' : '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'number') return String(value).replace('.', ',');
  return value == null ? '' : String(value);
}

export interface KnowledgeDocumentView {
  id: string;
  name: string;
  type: KnowledgeFileType;
  sizeBytes: number;
  status: DocumentStatus;
  /** Why processing failed, or a note (e.g. no Claude key: search only). */
  error: string | null;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
  passages: number;
  proposals: { pending: number; approved: number; rejected: number };
  /** Estimated cost of the extraction, USD. */
  costUsd: number | null;
  model: string | null;
}

export interface KnowledgeProposalView {
  id: string;
  page: number | null;
  /** handle, SKU or variant id the value is stored under; null when Claude found no match. */
  productKey: string | null;
  /** Catalogue title of the matched product, or the name Claude read in the file. */
  productLabel: string;
  field: ProductField;
  /** As Claude proposed it. */
  value: ProductFieldValue;
  /** What was approved: the value, or the edited one. */
  finalValue: ProductFieldValue | null;
  confidence: number;
  /** The words in the file the value was read from. */
  quote: string | null;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The value in effect for this product and field now (file config or approved), if any. */
  current: ProductFieldValue | null;
}

export interface KnowledgePassageView {
  page: number;
  label: string | null;
  text: string;
}

export interface KnowledgeDocumentDetail {
  document: KnowledgeDocumentView;
  proposals: KnowledgeProposalView[];
  passages: KnowledgePassageView[];
}

/** POST .../proposals/:id: approve (optionally with an edited value or product), or reject. */
export const proposalDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    /** An edited value, as text: the proposal becomes `edited`. */
    value: z.string().max(500).optional(),
    /** Another catalogue product (handle, SKU or variant id). */
    productKey: z.string().min(1).max(200).optional(),
  }),
  z.object({ action: z.literal('reject') }),
]);
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;

/** POST .../documents/:id/proposals: every pending proposal, or the ones listed. */
export const bulkDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  ids: z.array(z.uuid()).max(500).optional(),
});
export type BulkDecision = z.infer<typeof bulkDecisionSchema>;
