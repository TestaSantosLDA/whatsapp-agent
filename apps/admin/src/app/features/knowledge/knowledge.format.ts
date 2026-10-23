import {
  formatProductField,
  KNOWLEDGE_FILE_TYPES,
  PRODUCT_FIELD_LABELS,
  type DocumentStatus,
  type KnowledgeDocumentView,
  type ProductField,
} from '@wa/shared';

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  processing: 'A ler…',
  needs_review: 'Para rever',
  live: 'Ativo',
  failed: 'Falhou',
};

export function statusLabel(doc: KnowledgeDocumentView): string {
  if (doc.status === 'needs_review') return `Para rever (${doc.proposals.pending})`;
  return STATUS_LABELS[doc.status];
}

export function typeLabel(doc: KnowledgeDocumentView): string {
  return KNOWLEDGE_FILE_TYPES[doc.type]?.label ?? doc.type.toUpperCase();
}

/** 1 234 567 bytes → "1,2 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} MB`;
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-PT', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fieldLabel(field: ProductField): string {
  return PRODUCT_FIELD_LABELS[field] ?? field;
}

export function fieldValue(field: ProductField, value: unknown): string {
  const text = formatProductField(field, value);
  return field === 'm2_per_box' && text
    ? `${text} m²`
    : field === 'weight_kg' && text
      ? `${text} kg`
      : text;
}

/** 0.92 → "92%". */
export function confidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
