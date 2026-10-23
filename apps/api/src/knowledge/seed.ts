/**
 * Seeds knowledge without uploading or calling Claude (WA-026): a live document with its
 * passages, and approved product data. Used by the eval runner (evals/<client>/setup.json) and
 * tests.
 */
import type { ClientConfig } from '@wa/shared';
import { knowledgeFileType } from '@wa/shared';
import { applyProductOverrides } from '../catalogue/overrides.js';
import type { Db } from '../db/index.js';
import { documentPassages, documents, productDataOverrides } from '../db/schema.js';
import type { Passage } from './extract.js';

export interface SeedDocument {
  name: string;
  passages: { page?: number; label?: string | null; text: string }[];
}

/** Inserts a live document and its passages; returns its id. No file is stored. */
export async function seedDocument(db: Db, clientId: string, doc: SeedDocument): Promise<string> {
  const id = crypto.randomUUID();
  const type = knowledgeFileType(doc.name) ?? 'pdf';
  await db.insert(documents).values({
    id,
    clientId,
    name: doc.name,
    type,
    contentType: 'application/octet-stream',
    sizeBytes: 0,
    storagePath: `${clientId}/${id}/seed`,
    status: 'live',
  });
  const passages: Passage[] = doc.passages.map((p, i) => ({
    page: p.page ?? i + 1,
    label: p.label ?? null,
    text: p.text,
  }));
  if (passages.length) {
    await db
      .insert(documentPassages)
      .values(passages.map((p) => ({ clientId, documentId: id, ...p })));
  }
  return id;
}

/**
 * Stores approved product data (shaped like `product_data`: key → field → value) and rewrites
 * the catalogue rows it touches.
 */
export async function seedProductOverrides(
  db: Db,
  client: ClientConfig,
  data: Record<string, Record<string, unknown>>,
): Promise<void> {
  const rows = Object.entries(data).flatMap(([productKey, fields]) =>
    Object.entries(fields).map(([field, value]) => ({
      clientId: client.id,
      productKey,
      field,
      value,
    })),
  );
  if (rows.length) await db.insert(productDataOverrides).values(rows);
  await applyProductOverrides(db, client);
}
