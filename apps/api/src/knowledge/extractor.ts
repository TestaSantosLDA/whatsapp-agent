/**
 * Claude reads an uploaded document (WA-026): PDFs and images as `document` / `image` content
 * blocks, spreadsheets and Word files as the passages extracted locally. It returns the page
 * texts (for PDFs and images, which are not parsed here) and per-product data proposals matched
 * to the client's catalogue.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { productFields, type ClientConfig, type KnowledgeFileType } from '@wa/shared';
import { z } from 'zod';
import { estimateCost } from '../agent/pricing.js';
import type { Passage } from './extract.js';

/** One catalogue variant as Claude sees it, to match products in the document. */
export interface CatalogueEntry {
  variantId: string;
  sku: string | null;
  handle: string | null;
  title: string;
}

/** Longest text sent to Claude from a spreadsheet or Word file (characters). */
export const MAX_TEXT_CHARS = 200_000;
/** Most catalogue lines in the prompt. */
const MAX_CATALOGUE_LINES = 2000;

const extractionSchema = z.object({
  pages: z
    .array(
      z.object({
        page: z.number().int().describe('1-based page number in the file.'),
        text: z
          .string()
          .describe(
            'The text of the page as plain text, faithfully transcribed: headings, specification tables (one row per line, "label: value"), notes. Leave out decorative text and repeated footers.',
          ),
      }),
    )
    .describe(
      'Only when the document was attached as a PDF or image: every page with its text. Empty when the document was given as text passages.',
    ),
  proposals: z
    .array(
      z.object({
        page: z
          .number()
          .int()
          .describe('The page (PDF/image) or passage number (text) the value was read from.'),
        product: z
          .string()
          .describe(
            'The matched catalogue product: a variant_id, SKU or handle exactly as in the catalogue list. Use the variant_id or SKU when the value is for one variant (one size or thickness), the handle when it applies to every variant. Empty string when no catalogue product clearly matches.',
          ),
        product_name: z.string().describe('The product name as written in the document.'),
        field: z.enum(productFields),
        value: z
          .string()
          .describe(
            'The value as text: m2_per_box and weight_kg a number (comma or dot decimals), special_transport "sim" or "não", finishes a list separated by ";", dimensions as written (e.g. "1220 x 180 x 14 mm").',
          ),
        confidence: z
          .number()
          .describe('0 to 1: how sure you are of both the value and the product match.'),
        quote: z.string().describe('The exact words in the document the value comes from.'),
      }),
    )
    .describe('Product data found in the document. Leave out anything not stated in it.'),
});
export type ExtractionOutput = z.infer<typeof extractionSchema>;

export interface ExtractionRequest {
  client: ClientConfig;
  documentName: string;
  type: KnowledgeFileType;
  contentType: string;
  body: Uint8Array;
  /** Locally extracted passages (spreadsheets, Word); empty for PDFs and images. */
  passages: Passage[];
  catalogue: CatalogueEntry[];
}

export interface ExtractionResult extends ExtractionOutput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Set when the text sent to Claude was cut to MAX_TEXT_CHARS. */
  truncated: boolean;
}

/** Anything with Anthropic's `messages.parse`: the real client, or a fake in tests. */
export type ParseClient = Pick<Anthropic, 'messages'>;

export class DocumentExtractor {
  constructor(
    private readonly deps: {
      anthropic: ParseClient;
      /** Overrides the client's model for extraction (e.g. a Haiku for cost). */
      model?: string;
    },
  ) {}

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const model = this.deps.model ?? req.client.model.id;
    const { content, truncated } = documentContent(req);
    const message = await this.deps.anthropic.messages.parse({
      model,
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: systemPrompt(req.client, req.catalogue),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(extractionSchema) },
    });
    const cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
    const costUsd =
      estimateCost(model, {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens,
        cacheWriteTokens,
      }) ?? null;
    // Stored like agent_runs: every input token, cached or not.
    const usage = {
      inputTokens: message.usage.input_tokens + cacheWriteTokens + cacheReadTokens,
      outputTokens: message.usage.output_tokens,
    };
    const parsed = message.parsed_output;
    if (!parsed) {
      const why =
        message.stop_reason === 'max_tokens'
          ? 'o documento é demasiado longo para ser lido de uma vez'
          : message.stop_reason === 'refusal'
            ? 'o modelo recusou ler o documento'
            : `sem resposta válida (${message.stop_reason})`;
      throw new ExtractionError(`Não foi possível extrair os dados: ${why}.`, {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      });
    }
    return { ...parsed, model, ...usage, costUsd, truncated };
  }
}

/** A failure that a retry will not fix, with what the attempt cost. */
export class ExtractionError extends Error {
  override name = 'ExtractionError';
  constructor(
    message: string,
    readonly usage: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
    },
  ) {
    super(message);
  }
}

function systemPrompt(client: ClientConfig, catalogue: CatalogueEntry[]): string {
  const lines = catalogue
    .slice(0, MAX_CATALOGUE_LINES)
    .map((c) => `${c.variantId} | ${c.sku ?? '-'} | ${c.handle ?? '-'} | ${c.title}`);
  const more =
    catalogue.length > MAX_CATALOGUE_LINES
      ? `\n(${catalogue.length - MAX_CATALOGUE_LINES} more variants not listed)`
      : '';
  return `You read documents that ${client.name}'s team uploads (technical sheets, price lists, catalogues) and extract product data for their sales assistant. An admin reviews every value before it is used, so be accurate rather than complete.

Fields to extract, only when the document states them:
- m2_per_box: square metres covered by one box or pack (flooring, decking, cladding). Not the price per m².
- dimensions: board or panel dimensions (length x width x thickness, with units).
- weight_kg: weight of one box, pack or unit in kg.
- special_transport: "sim" when the document says the product needs special transport (oversized, pallets, crane), "não" only when it says it does not.
- finishes: available finishes or colours.

Rules:
- Match each value to a product in the catalogue below by SKU, name, size or thickness. If several variants differ (e.g. 14 mm and 20 mm), give each its own proposal with its variant_id or SKU. If nothing clearly matches, leave product empty and give the name as written.
- Never compute or convert a value the document does not state (e.g. do not derive m² per box from board sizes). Quote the words you read.
- One proposal per product and field.

# Catalogue (variant_id | SKU | handle | title)
${lines.join('\n') || '(empty)'}${more}`;
}

type UserContent = Anthropic.MessageParam['content'];

function documentContent(req: ExtractionRequest): { content: UserContent; truncated: boolean } {
  const intro = `Document: "${req.documentName}" (${req.type.toUpperCase()}).`;
  if (req.type === 'pdf') {
    return {
      truncated: false,
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64(req.body) },
          title: req.documentName,
        },
        { type: 'text', text: `${intro} Transcribe every page and extract the product data.` },
      ],
    };
  }
  if (req.type === 'png' || req.type === 'jpg') {
    return {
      truncated: false,
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: req.type === 'png' ? 'image/png' : 'image/jpeg',
            data: base64(req.body),
          },
        },
        {
          type: 'text',
          text: `${intro} It is one page: transcribe it as page 1 and extract the product data.`,
        },
      ],
    };
  }
  let text = '';
  let truncated = false;
  for (const p of req.passages) {
    const block = `[Passage ${p.page}${p.label ? ` — ${p.label}` : ''}]\n${p.text}\n\n`;
    if (text.length + block.length > MAX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    text += block;
  }
  return {
    truncated,
    content: `${intro} It is given as text passages; leave "pages" empty and use the passage numbers as pages.\n\n${text}`,
  };
}

function base64(body: Uint8Array): string {
  return Buffer.from(body).toString('base64');
}
