/**
 * The `process_document` job (WA-026): reads an uploaded file in the background, stores its
 * passages for search_documents and Claude's product data proposals for review. Runs on the
 * app's queue, so in-process locally and through Cloud Tasks in production.
 */
import {
  coerceProductField,
  type ClientConfig,
  type KnowledgeFileType,
  type ProductField,
  type ProductFieldValue,
} from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import type { ClientRegistry } from '../clients/registry.js';
import { handleFromUrl } from '../catalogue/overrides.js';
import type { Db } from '../db/index.js';
import { documentPassages, documents, productDataProposals, products } from '../db/schema.js';
import { extractPassages, needsClaudeToRead, type Passage } from './extract.js';
import {
  ExtractionError,
  MAX_TEXT_CHARS,
  type CatalogueEntry,
  type DocumentExtractor,
} from './extractor.js';
import type { FileStore } from './file-store.js';

export const PROCESS_DOCUMENT = 'process_document';

export interface ProcessDocumentPayload {
  clientId: string;
  documentId: string;
  /** The document's version when the job was queued; a replaced file makes the job a no-op. */
  version: number;
}

export interface ProcessDocumentDeps {
  db: Db;
  clients: ClientRegistry;
  files: FileStore;
  /** Undefined without ANTHROPIC_API_KEY: spreadsheets and Word files become searchable only. */
  extractor?: DocumentExtractor;
}

/** A catalogue variant with what proposals are matched by. */
export interface CatalogueProduct extends CatalogueEntry {
  /** Title with the variant ("Soalho Carvalho – 14 mm"). */
  label: string;
  productTitle: string;
}

export async function loadCatalogue(db: Db, clientId: string): Promise<CatalogueProduct[]> {
  const rows = await db
    .select({
      variantId: products.variantId,
      sku: products.sku,
      url: products.url,
      title: products.title,
      variantTitle: products.variantTitle,
    })
    .from(products)
    .where(eq(products.clientId, clientId))
    .orderBy(products.title, products.variantId);
  return rows.map((r) => {
    const label = r.variantTitle ? `${r.title} – ${r.variantTitle}` : r.title;
    return {
      variantId: r.variantId,
      sku: r.sku,
      handle: handleFromUrl(r.url),
      title: label,
      label,
      productTitle: r.title,
    };
  });
}

/**
 * The stored key (variant id, SKU or handle, as written in the catalogue) and label for a
 * product reference, or undefined when nothing in the catalogue matches.
 */
export function resolveProduct(
  catalogue: CatalogueProduct[],
  ref: string,
): { key: string; label: string } | undefined {
  const want = ref.trim();
  if (!want) return undefined;
  const lower = want.toLowerCase();
  const byVariant = catalogue.find((c) => c.variantId === want);
  if (byVariant) return { key: byVariant.variantId, label: byVariant.label };
  const bySku = catalogue.find((c) => c.sku?.toLowerCase() === lower);
  if (bySku) return { key: bySku.sku!, label: bySku.label };
  const byHandle = catalogue.find((c) => c.handle?.toLowerCase() === lower);
  if (byHandle) return { key: byHandle.handle!, label: byHandle.productTitle };
  return undefined;
}

export function processDocument(deps: ProcessDocumentDeps) {
  return async (payload: ProcessDocumentPayload): Promise<void> => {
    const { db } = deps;
    const doc = await currentDocument(db, payload);
    if (!doc) return;
    const client = deps.clients.get(payload.clientId);
    if (!client) return;
    const type = doc.type as KnowledgeFileType;
    const body = await deps.files.get(doc.storagePath);

    let passages: Passage[] = [];
    if (!needsClaudeToRead(type)) {
      try {
        passages = await extractPassages(type, body);
      } catch (error) {
        console.warn(`[knowledge] ${doc.id}: could not read ${doc.name}`, error);
        await finish(db, payload, {
          status: 'failed',
          error: 'Não foi possível ler o ficheiro. Confirme que não está danificado nem protegido.',
        });
        return;
      }
    }

    if (!deps.extractor) {
      if (needsClaudeToRead(type)) {
        await finish(db, payload, {
          status: 'failed',
          error: 'A leitura de PDFs e imagens precisa do Claude, que não está configurado aqui.',
        });
      } else {
        await finish(db, payload, {
          status: 'live',
          passages,
          error:
            'Sem Claude configurado: o documento entra na pesquisa, mas não foram propostos dados de produtos.',
        });
      }
      return;
    }

    const catalogue = await loadCatalogue(db, client.id);
    let result;
    try {
      result = await deps.extractor.extract({
        client,
        documentName: doc.name,
        type,
        contentType: doc.contentType,
        body,
        passages,
        catalogue,
      });
    } catch (error) {
      if (!(error instanceof ExtractionError)) throw error; // retried by the queue
      await finish(db, payload, { status: 'failed', error: error.message, usage: error.usage });
      return;
    }

    if (needsClaudeToRead(type)) {
      passages = result.pages
        .map((p) => ({ page: p.page, label: `Página ${p.page}`, text: p.text.trim() }))
        .filter((p) => p.text);
    }
    const proposals = toProposals(client, catalogue, result.proposals);
    await finish(db, payload, {
      status: proposals.length ? 'needs_review' : 'live',
      passages,
      proposals,
      usage: result,
      error: result.truncated
        ? `Ficheiro grande: só os primeiros ${MAX_TEXT_CHARS.toLocaleString('pt-PT')} caracteres foram analisados para dados de produtos; a pesquisa usa o ficheiro todo.`
        : null,
    });
    console.log(
      `[knowledge] ${client.id}: ${doc.name} read: ${passages.length} passages, ${proposals.length} proposals`,
    );
  };
}

/** After the last retry: the document shows as failed with a message the team can act on. */
export function onProcessDocumentFailure(db: Db) {
  return async (payload: ProcessDocumentPayload, error: unknown): Promise<void> => {
    console.error(`[knowledge] ${payload.documentId}: processing failed`, error);
    await finish(db, payload, {
      status: 'failed',
      error: 'Não foi possível ler o documento agora. Tente substituir o ficheiro mais tarde.',
    });
  };
}

interface NewProposal {
  page: number | null;
  productKey: string | null;
  productLabel: string;
  field: ProductField;
  value: ProductFieldValue;
  confidence: number;
  quote: string | null;
}

function toProposals(
  client: ClientConfig,
  catalogue: CatalogueProduct[],
  raw: {
    page: number;
    product: string;
    product_name: string;
    field: ProductField;
    value: string;
    confidence: number;
    quote: string;
  }[],
): NewProposal[] {
  const seen = new Set<string>();
  const out: NewProposal[] = [];
  for (const p of raw) {
    let value: ProductFieldValue;
    try {
      value = coerceProductField(p.field, p.value);
    } catch {
      console.warn(`[knowledge] ${client.id}: dropping ${p.field}="${p.value}": not a valid value`);
      continue;
    }
    const match = resolveProduct(catalogue, p.product);
    const dedupe = `${match?.key ?? p.product_name.toLowerCase()}|${p.field}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      page: Number.isInteger(p.page) && p.page > 0 ? p.page : null,
      productKey: match?.key ?? null,
      productLabel: (match?.label ?? p.product_name.trim()) || 'Produto sem nome',
      field: p.field,
      value,
      confidence: Math.min(1, Math.max(0, Number.isFinite(p.confidence) ? p.confidence : 0)),
      quote: p.quote.trim().slice(0, 500) || null,
    });
  }
  return out;
}

async function currentDocument(db: Db, payload: ProcessDocumentPayload) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, payload.documentId),
        eq(documents.clientId, payload.clientId),
        eq(documents.version, payload.version),
      ),
    );
  return doc?.status === 'processing' ? doc : undefined;
}

/** Writes the outcome, unless the document was replaced or deleted meanwhile. */
async function finish(
  db: Db,
  payload: ProcessDocumentPayload,
  outcome: {
    status: 'needs_review' | 'live' | 'failed';
    error: string | null;
    passages?: Passage[];
    proposals?: NewProposal[];
    usage?: { model: string; inputTokens: number; outputTokens: number; costUsd: number | null };
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.id, payload.documentId),
          eq(documents.clientId, payload.clientId),
          eq(documents.version, payload.version),
        ),
      )
      .for('update');
    if (!doc) return;
    await tx.delete(documentPassages).where(eq(documentPassages.documentId, doc.id));
    await tx
      .delete(productDataProposals)
      .where(
        and(
          eq(productDataProposals.documentId, doc.id),
          eq(productDataProposals.status, 'pending'),
        ),
      );
    const passages = outcome.passages ?? [];
    for (let i = 0; i < passages.length; i += 200) {
      await tx.insert(documentPassages).values(
        passages.slice(i, i + 200).map((p) => ({
          clientId: payload.clientId,
          documentId: doc.id,
          page: p.page,
          label: p.label,
          text: p.text,
        })),
      );
    }
    if (outcome.proposals?.length) {
      await tx.insert(productDataProposals).values(
        outcome.proposals.map((p) => ({
          clientId: payload.clientId,
          documentId: doc.id,
          page: p.page,
          productKey: p.productKey,
          productLabel: p.productLabel,
          field: p.field,
          value: p.value,
          confidence: p.confidence.toFixed(3),
          quote: p.quote,
        })),
      );
    }
    await tx
      .update(documents)
      .set({
        status: outcome.status,
        error: outcome.error,
        updatedAt: new Date(),
        ...(outcome.usage && {
          model: outcome.usage.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          costUsd: outcome.usage.costUsd?.toFixed(6) ?? null,
        }),
      })
      .where(eq(documents.id, doc.id));
  });
}
