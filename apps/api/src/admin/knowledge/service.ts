/**
 * Knowledge base (WA-026): upload, list, review and delete documents; approve the product data
 * Claude proposed. Approved values become product_data_overrides and are written into the
 * catalogue at once (catalogue/overrides.ts).
 */
import {
  coerceProductField,
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_MAX_BYTES,
  knowledgeFileType,
  type BulkDecision,
  type ClientConfig,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentView,
  type KnowledgeFileType,
  type KnowledgeProposalView,
  type ProductField,
  type ProductFieldValue,
  type ProposalDecision,
} from '@wa/shared';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  applyProductOverrides,
  productExtra,
  loadProductOverrides,
} from '../../catalogue/overrides.js';
import type { Db } from '../../db/index.js';
import {
  documentPassages,
  documents,
  productDataOverrides,
  productDataProposals,
  teamMembers,
} from '../../db/schema.js';
import type { FileStore } from '../../knowledge/file-store.js';
import { storageKey } from '../../knowledge/file-store.js';
import {
  loadCatalogue,
  PROCESS_DOCUMENT,
  resolveProduct,
  type CatalogueProduct,
  type ProcessDocumentPayload,
} from '../../knowledge/process.js';
import type { Queue } from '../../queue/queue.js';
import { adminError } from '../context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DocumentRow = typeof documents.$inferSelect;
type ProposalRow = typeof productDataProposals.$inferSelect;

export interface UploadedFile {
  name: string;
  body: Uint8Array;
}

export class KnowledgeService {
  constructor(private readonly deps: { db: Db; files: FileStore; queue: Queue }) {}

  async upload(
    clientId: string,
    file: UploadedFile,
    memberId: string,
  ): Promise<KnowledgeDocumentView> {
    const type = validateFile(file);
    const id = crypto.randomUUID();
    const storagePath = storageKey(clientId, id, file.name);
    const contentType = KNOWLEDGE_FILE_TYPES[type].mime;
    await this.deps.files.put(storagePath, file.body, contentType);
    await this.deps.db.insert(documents).values({
      id,
      clientId,
      name: cleanName(file.name),
      type,
      contentType,
      sizeBytes: file.body.byteLength,
      storagePath,
      uploadedBy: memberId,
    });
    await this.enqueue({ clientId, documentId: id, version: 1 });
    return this.view(clientId, id);
  }

  /** A new file for the same document: passages and pending proposals are redone. */
  async replace(
    clientId: string,
    documentId: string,
    file: UploadedFile,
    memberId: string,
  ): Promise<KnowledgeDocumentView> {
    const doc = await this.row(clientId, documentId);
    const type = validateFile(file);
    const storagePath = storageKey(clientId, documentId, file.name);
    const contentType = KNOWLEDGE_FILE_TYPES[type].mime;
    await this.deps.files.put(storagePath, file.body, contentType);
    const version = doc.version + 1;
    await this.deps.db.transaction(async (tx) => {
      await tx.delete(documentPassages).where(eq(documentPassages.documentId, doc.id));
      await tx
        .delete(productDataProposals)
        .where(
          and(
            eq(productDataProposals.documentId, doc.id),
            eq(productDataProposals.status, 'pending'),
          ),
        );
      await tx
        .update(documents)
        .set({
          name: cleanName(file.name),
          type,
          contentType,
          sizeBytes: file.body.byteLength,
          storagePath,
          status: 'processing',
          error: null,
          version,
          uploadedBy: memberId,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));
    });
    if (doc.storagePath !== storagePath) await this.deleteFile(doc.storagePath);
    await this.enqueue({ clientId, documentId, version });
    return this.view(clientId, documentId);
  }

  /**
   * Deletes the document, its passages and its proposals. Approved data stays in the catalogue
   * unless `removeData`.
   */
  async remove(client: ClientConfig, documentId: string, removeData: boolean): Promise<void> {
    const doc = await this.row(client.id, documentId);
    await this.deps.db.transaction(async (tx) => {
      if (removeData) {
        await tx
          .delete(productDataOverrides)
          .where(
            and(
              eq(productDataOverrides.clientId, client.id),
              eq(productDataOverrides.documentId, doc.id),
            ),
          );
      }
      await tx.delete(documents).where(eq(documents.id, doc.id));
    });
    await this.deleteFile(doc.storagePath);
    if (removeData) await applyProductOverrides(this.deps.db, client);
  }

  async list(clientId: string): Promise<KnowledgeDocumentView[]> {
    const rows = await this.deps.db
      .select({ doc: documents, by: teamMembers.email })
      .from(documents)
      .leftJoin(teamMembers, eq(teamMembers.id, documents.uploadedBy))
      .where(eq(documents.clientId, clientId))
      .orderBy(desc(documents.createdAt));
    const ids = rows.map((r) => r.doc.id);
    const stats = await this.stats(ids);
    return rows.map((r) => toView(r.doc, r.by, stats.get(r.doc.id)));
  }

  async view(clientId: string, documentId: string): Promise<KnowledgeDocumentView> {
    const [row] = await this.deps.db
      .select({ doc: documents, by: teamMembers.email })
      .from(documents)
      .leftJoin(teamMembers, eq(teamMembers.id, documents.uploadedBy))
      .where(and(eq(documents.clientId, clientId), eq(documents.id, documentId)));
    if (!row) throw notFound();
    const stats = await this.stats([documentId]);
    return toView(row.doc, row.by, stats.get(documentId));
  }

  async detail(client: ClientConfig, documentId: string): Promise<KnowledgeDocumentDetail> {
    const document = await this.view(client.id, documentId);
    const [proposals, passages, catalogue, overrides] = await Promise.all([
      this.deps.db
        .select({ p: productDataProposals, by: teamMembers.email })
        .from(productDataProposals)
        .leftJoin(teamMembers, eq(teamMembers.id, productDataProposals.decidedBy))
        .where(eq(productDataProposals.documentId, documentId))
        .orderBy(asc(productDataProposals.page), asc(productDataProposals.productLabel)),
      this.deps.db
        .select({
          page: documentPassages.page,
          label: documentPassages.label,
          text: documentPassages.text,
        })
        .from(documentPassages)
        .where(eq(documentPassages.documentId, documentId))
        .orderBy(asc(documentPassages.page)),
      loadCatalogue(this.deps.db, client.id),
      loadProductOverrides(this.deps.db, client.id),
    ]);
    const current = (key: string | null, field: string): ProductFieldValue | null => {
      if (!key) return null;
      const lower = key.toLowerCase();
      const item = catalogue.find(
        (c) => c.variantId === key || c.sku?.toLowerCase() === lower || c.handle === key,
      );
      if (!item) return null;
      const extra = productExtra(item, client.product_data, overrides);
      return (extra[field] as ProductFieldValue | undefined) ?? null;
    };
    return {
      document,
      passages,
      proposals: proposals.map(({ p, by }) =>
        toProposalView(p, by, current(p.productKey, p.field)),
      ),
    };
  }

  /** Approves (as proposed, or edited) or rejects one proposal. */
  async decide(
    client: ClientConfig,
    proposalId: string,
    decision: ProposalDecision,
    memberId: string,
  ): Promise<KnowledgeProposalView> {
    if (!UUID.test(proposalId)) throw adminError(404, 'not_found', 'Proposta não encontrada.');
    const [proposal] = await this.deps.db
      .select()
      .from(productDataProposals)
      .where(
        and(eq(productDataProposals.clientId, client.id), eq(productDataProposals.id, proposalId)),
      );
    if (!proposal) throw adminError(404, 'not_found', 'Proposta não encontrada.');
    const doc = await this.row(client.id, proposal.documentId);
    const catalogue = await loadCatalogue(this.deps.db, client.id);
    await this.applyDecision(client, doc, proposal, decision, memberId, catalogue);
    await this.refreshStatus(doc.id);
    await applyProductOverrides(this.deps.db, client);
    const detail = await this.detail(client, doc.id);
    return detail.proposals.find((p) => p.id === proposal.id)!;
  }

  /**
   * Approves or rejects every pending proposal of a document (or the listed ones). Proposals
   * without a catalogue product are skipped by approve: they need a product first.
   */
  async decideMany(
    client: ClientConfig,
    documentId: string,
    body: BulkDecision,
    memberId: string,
  ): Promise<{ decided: number; skipped: number }> {
    const doc = await this.row(client.id, documentId);
    const pending = await this.deps.db
      .select()
      .from(productDataProposals)
      .where(
        and(
          eq(productDataProposals.documentId, documentId),
          eq(productDataProposals.status, 'pending'),
          body.ids ? inArray(productDataProposals.id, body.ids) : undefined,
        ),
      );
    const catalogue = await loadCatalogue(this.deps.db, client.id);
    let decided = 0;
    let skipped = 0;
    for (const p of pending) {
      if (body.action === 'approve' && !resolveProduct(catalogue, p.productKey ?? '')) {
        skipped++;
        continue;
      }
      await this.applyDecision(client, doc, p, { action: body.action }, memberId, catalogue);
      decided++;
    }
    await this.refreshStatus(doc.id);
    if (decided) await applyProductOverrides(this.deps.db, client);
    return { decided, skipped };
  }

  private async applyDecision(
    client: ClientConfig,
    doc: DocumentRow,
    proposal: ProposalRow,
    decision: ProposalDecision,
    memberId: string,
    catalogue: CatalogueProduct[],
  ): Promise<void> {
    if (doc.status === 'processing') {
      throw adminError(409, 'processing', 'O documento ainda está a ser lido.');
    }
    if (decision.action === 'reject') {
      await this.deps.db.transaction(async (tx) => {
        await tx
          .delete(productDataOverrides)
          .where(eq(productDataOverrides.proposalId, proposal.id));
        await tx
          .update(productDataProposals)
          .set({ status: 'rejected', decidedBy: memberId, decidedAt: new Date() })
          .where(eq(productDataProposals.id, proposal.id));
      });
      return;
    }
    const match = resolveProduct(catalogue, decision.productKey ?? proposal.productKey ?? '');
    if (!match) {
      throw adminError(
        400,
        'unknown_product',
        'Escolha um produto do catálogo (SKU, referência ou handle).',
      );
    }
    const field = proposal.field as ProductField;
    let value = proposal.value as ProductFieldValue;
    if (decision.value !== undefined) {
      try {
        value = coerceProductField(field, decision.value);
      } catch (error) {
        throw adminError(400, 'invalid_value', (error as Error).message);
      }
    }
    const edited =
      JSON.stringify(value) !== JSON.stringify(proposal.value) || match.key !== proposal.productKey;
    await this.deps.db.transaction(async (tx) => {
      // A product changed since an earlier approval: drop the value stored under the old one.
      await tx.delete(productDataOverrides).where(eq(productDataOverrides.proposalId, proposal.id));
      await tx
        .insert(productDataOverrides)
        .values({
          clientId: client.id,
          productKey: match.key,
          field,
          value,
          documentId: doc.id,
          proposalId: proposal.id,
          approvedBy: memberId,
        })
        .onConflictDoUpdate({
          target: [
            productDataOverrides.clientId,
            productDataOverrides.productKey,
            productDataOverrides.field,
          ],
          set: {
            value,
            documentId: doc.id,
            proposalId: proposal.id,
            approvedBy: memberId,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(productDataProposals)
        .set({
          status: edited ? 'edited' : 'approved',
          editedValue: edited ? value : null,
          productKey: match.key,
          productLabel: match.label,
          decidedBy: memberId,
          decidedAt: new Date(),
        })
        .where(eq(productDataProposals.id, proposal.id));
    });
  }

  private async refreshStatus(documentId: string): Promise<void> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(productDataProposals)
      .where(
        and(
          eq(productDataProposals.documentId, documentId),
          eq(productDataProposals.status, 'pending'),
        ),
      );
    await this.deps.db
      .update(documents)
      .set({ status: row && row.n > 0 ? 'needs_review' : 'live', updatedAt: new Date() })
      .where(
        and(eq(documents.id, documentId), inArray(documents.status, ['needs_review', 'live'])),
      );
  }

  private async row(clientId: string, documentId: string): Promise<DocumentRow> {
    if (!UUID.test(documentId)) throw notFound();
    const [doc] = await this.deps.db
      .select()
      .from(documents)
      .where(and(eq(documents.clientId, clientId), eq(documents.id, documentId)));
    if (!doc) throw notFound();
    return doc;
  }

  private async stats(ids: string[]) {
    const out = new Map<
      string,
      { passages: number; pending: number; approved: number; rejected: number }
    >();
    if (ids.length === 0) return out;
    for (const id of ids) out.set(id, { passages: 0, pending: 0, approved: 0, rejected: 0 });
    const passages = await this.deps.db
      .select({ id: documentPassages.documentId, n: count() })
      .from(documentPassages)
      .where(inArray(documentPassages.documentId, ids))
      .groupBy(documentPassages.documentId);
    for (const p of passages) out.get(p.id)!.passages = p.n;
    const proposals = await this.deps.db
      .select({
        id: productDataProposals.documentId,
        status: productDataProposals.status,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(productDataProposals)
      .where(inArray(productDataProposals.documentId, ids))
      .groupBy(productDataProposals.documentId, productDataProposals.status);
    for (const p of proposals) {
      const s = out.get(p.id)!;
      if (p.status === 'pending') s.pending += p.n;
      else if (p.status === 'rejected') s.rejected += p.n;
      else s.approved += p.n;
    }
    return out;
  }

  private enqueue(payload: ProcessDocumentPayload): Promise<void> {
    return this.deps.queue.enqueue({
      name: PROCESS_DOCUMENT,
      key: `document:${payload.documentId}`,
      payload,
    });
  }

  private async deleteFile(path: string): Promise<void> {
    try {
      await this.deps.files.delete(path);
    } catch (error) {
      console.error(
        `[knowledge] could not delete ${path} from the ${this.deps.files.kind} store`,
        error,
      );
    }
  }
}

/** The file's type, or a 400/413 the dashboard shows. */
export function validateFile(file: UploadedFile): KnowledgeFileType {
  const type = knowledgeFileType(file.name);
  if (!type) {
    throw adminError(
      415,
      'unsupported_type',
      'Tipo de ficheiro não suportado. Envie PDF, Excel (XLSX), CSV, Word (DOCX) ou imagem (PNG, JPG).',
    );
  }
  if (file.body.byteLength === 0) throw adminError(400, 'empty_file', 'O ficheiro está vazio.');
  if (file.body.byteLength > KNOWLEDGE_MAX_BYTES) {
    throw adminError(
      413,
      'too_large',
      `O ficheiro é maior do que ${KNOWLEDGE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (!looksLike(type, file.body)) {
    throw adminError(
      415,
      'invalid_file',
      `O conteúdo não é um ficheiro ${KNOWLEDGE_FILE_TYPES[type].label} válido.`,
    );
  }
  return type;
}

/** Magic bytes, so a renamed file is refused before it reaches Claude. */
function looksLike(type: KnowledgeFileType, b: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  switch (type) {
    case 'pdf':
      return starts(0x25, 0x50, 0x44, 0x46); // %PDF
    case 'xlsx':
    case 'docx':
      return starts(0x50, 0x4b, 0x03, 0x04); // zip
    case 'png':
      return starts(0x89, 0x50, 0x4e, 0x47);
    case 'jpg':
      return starts(0xff, 0xd8, 0xff);
    case 'csv':
      // Text: no NUL bytes in the first KB.
      return !b.subarray(0, 1024).includes(0);
  }
}

function cleanName(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200) || 'documento';
}

function notFound() {
  return adminError(404, 'not_found', 'Documento não encontrado.');
}

function toView(
  doc: DocumentRow,
  by: string | null,
  stats: { passages: number; pending: number; approved: number; rejected: number } | undefined,
): KnowledgeDocumentView {
  return {
    id: doc.id,
    name: doc.name,
    type: doc.type as KnowledgeFileType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    error: doc.error,
    uploadedBy: by,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    passages: stats?.passages ?? 0,
    proposals: {
      pending: stats?.pending ?? 0,
      approved: stats?.approved ?? 0,
      rejected: stats?.rejected ?? 0,
    },
    costUsd: doc.costUsd === null ? null : Number(doc.costUsd),
    model: doc.model,
  };
}

function toProposalView(
  p: ProposalRow,
  by: string | null,
  current: ProductFieldValue | null,
): KnowledgeProposalView {
  return {
    id: p.id,
    page: p.page,
    productKey: p.productKey,
    productLabel: p.productLabel,
    field: p.field as ProductField,
    value: p.value as ProductFieldValue,
    finalValue:
      p.status === 'edited'
        ? (p.editedValue as ProductFieldValue)
        : p.status === 'approved'
          ? (p.value as ProductFieldValue)
          : null,
    confidence: Number(p.confidence),
    quote: p.quote,
    status: p.status,
    decidedBy: by,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    current,
  };
}
