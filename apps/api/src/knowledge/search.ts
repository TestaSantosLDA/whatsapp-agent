/**
 * Full-text search over the passages of a client's live documents (WA-026), with Postgres FTS
 * (works on PGlite too): 'portuguese' (stemming) and 'simple' (codes, sizes as written) ORed.
 * Passages matching every term come first; if none do, passages matching any term.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { documentPassages, documents } from '../db/schema.js';

export interface PassageHit {
  documentId: string;
  documentName: string;
  page: number;
  label: string | null;
  text: string;
  rank: number;
}

export async function searchPassages(
  db: Db,
  clientId: string,
  query: string,
  limit = 5,
): Promise<PassageHit[]> {
  const q = query.trim();
  if (!q) return [];
  const allTerms = sql`(websearch_to_tsquery('portuguese', ${q}) || websearch_to_tsquery('simple', ${q}))`;
  const anyTerm = sql`(${orQuery('portuguese', q)} || ${orQuery('simple', q)})`;
  const run = (match: SQL) => {
    const rank = sql<number>`ts_rank(${documentPassages.searchVector}, ${anyTerm})`.mapWith(Number);
    return db
      .select({
        documentId: documents.id,
        documentName: documents.name,
        page: documentPassages.page,
        label: documentPassages.label,
        text: documentPassages.text,
        rank,
      })
      .from(documentPassages)
      .innerJoin(documents, eq(documents.id, documentPassages.documentId))
      .where(
        and(
          eq(documentPassages.clientId, clientId),
          eq(documents.clientId, clientId),
          eq(documents.status, 'live'),
          match,
        ),
      )
      .orderBy(desc(rank), documentPassages.page)
      .limit(limit);
  };
  const strict = await run(sql`${documentPassages.searchVector} @@ ${allTerms}`);
  if (strict.length > 0) return strict;
  return run(sql`${documentPassages.searchVector} @@ ${anyTerm}`);
}

/** The query with every AND turned into OR, negations dropped (see catalogue/repository.ts). */
function orQuery(config: 'portuguese' | 'simple', query: string): SQL {
  return sql`replace(replace(websearch_to_tsquery(${config}, ${query})::text, '!', ''), ' & ', ' | ')::tsquery`;
}
