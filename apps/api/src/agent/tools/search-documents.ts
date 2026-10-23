import { z } from 'zod';
import { searchPassages } from '../../knowledge/search.js';
import { defineTool } from '../tool.js';

/** Longest passage text returned to Claude. */
const PASSAGE_MAX = 1500;

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(300)
    .describe(
      'What to look for, in Portuguese keywords: product name plus the property, e.g. "deck cumaru densidade" or "vinílico SPC classe de uso".',
    ),
  limit: z.number().int().min(1).max(8).optional().describe('How many passages, default 5.'),
});

/** WA-026: passages of the technical sheets, price lists and catalogues the team uploaded. */
export const searchDocumentsTool = defineTool({
  name: 'search_documents',
  description:
    'Searches the company\'s own documents (technical sheets, catalogues, price lists, installation guides) uploaded by the team, and returns the best matching passages with the document name and page. Use it for technical questions the product details do not answer: dimensions, density, wear class, installation, maintenance, fire rating, guarantees, joist spacing and similar. Answer only from the passages returned, and cite the document by its name when you use it (e.g. "segundo a ficha técnica Deck WPC Antracite…"), without the file extension. If nothing relevant comes back, say you will confirm with a colleague; never guess a specification.',
  inputSchema,
  async run(input, ctx) {
    const hits = await searchPassages(ctx.db, ctx.client.id, input.query, input.limit ?? 5);
    if (hits.length === 0) {
      return {
        results: [],
        note: 'No document mentions this. Do not guess: offer to confirm with a colleague.',
      };
    }
    return {
      results: hits.map((h) => ({
        document: documentTitle(h.documentName),
        page: h.page,
        where: h.label ?? `p. ${h.page}`,
        text: h.text.length > PASSAGE_MAX ? `${h.text.slice(0, PASSAGE_MAX - 1)}…` : h.text,
      })),
      note: 'Cite the document by name when you use a passage.',
    };
  },
});

/** "ficha-tecnica_deck.pdf" → "ficha-tecnica deck": the name to cite, without the extension. */
export function documentTitle(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
}
