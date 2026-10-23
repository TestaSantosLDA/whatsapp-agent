/**
 * Local text extraction for uploaded documents (WA-026). Spreadsheets and Word files are read
 * here; PDFs and images are not parsed locally: Claude reads them (see extractor.ts).
 */
import type { KnowledgeFileType } from '@wa/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';

export interface Passage {
  /** 1-based page, sheet chunk or section number. */
  page: number;
  label: string | null;
  text: string;
}

/** Spreadsheet rows per passage. */
const ROWS_PER_PASSAGE = 25;
/** Target length of a Word passage, in characters. */
const SECTION_CHARS = 1500;

/** True for the types Claude must read from the file itself. */
export function needsClaudeToRead(type: KnowledgeFileType): boolean {
  return type === 'pdf' || type === 'png' || type === 'jpg';
}

/** Passages read from a spreadsheet or Word file. Throws on a file that cannot be read. */
export async function extractPassages(
  type: KnowledgeFileType,
  body: Uint8Array,
): Promise<Passage[]> {
  switch (type) {
    case 'csv':
      return tableToPassages([{ name: null, rows: parseCsvRows(body) }]);
    case 'xlsx': {
      const sheets = await readXlsxFile(Buffer.from(body));
      return tableToPassages(
        sheets.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map(cellText)) })),
      );
    }
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(body) });
      return textToSections(value);
    }
    default:
      return [];
  }
}

function parseCsvRows(body: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8').decode(body).replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => firstLine.split(c).length - 1;
  // Portuguese Excel exports use ";" (the comma is the decimal separator).
  const delimiter = [';', '\t', ','].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
  return parseCsv(text, {
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  }) as string[][];
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value).replace('.', ',');
  return String(value).trim();
}

/**
 * Each sheet becomes passages of ROWS_PER_PASSAGE rows, every row written as
 * "Header: value · Header: value" so a passage makes sense on its own in search results.
 */
function tableToPassages(sheets: { name: string | null; rows: string[][] }[]): Passage[] {
  const passages: Passage[] = [];
  for (const sheet of sheets) {
    const rows = sheet.rows.filter((r) => r.some((c) => c.trim()));
    if (rows.length === 0) continue;
    const header = rows[0]!.map((h, i) => h.trim() || `Coluna ${i + 1}`);
    const data = rows.slice(1);
    if (data.length === 0) data.push(rows[0]!);
    for (let i = 0; i < data.length; i += ROWS_PER_PASSAGE) {
      const chunk = data.slice(i, i + ROWS_PER_PASSAGE);
      const lines = chunk.map((row) =>
        row
          .map((cell, c) =>
            cell.trim() ? `${header[c] ?? `Coluna ${c + 1}`}: ${cell.trim()}` : '',
          )
          .filter(Boolean)
          .join(' · '),
      );
      // Spreadsheet line numbers: the header is line 1.
      const from = i + 2;
      const to = i + 1 + chunk.length;
      const where = `linhas ${from}–${to}`;
      passages.push({
        page: passages.length + 1,
        label: sheet.name ? `Folha ${sheet.name}, ${where}` : `Linhas ${from}–${to}`,
        text: lines.join('\n'),
      });
    }
  }
  return passages;
}

/** Plain text split at paragraph breaks into sections of about SECTION_CHARS. */
export function textToSections(text: string, labelPrefix = 'Secção'): Passage[] {
  const paragraphs = text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const passages: Passage[] = [];
  let current = '';
  const flush = () => {
    if (!current) return;
    passages.push({
      page: passages.length + 1,
      label: `${labelPrefix} ${passages.length + 1}`,
      text: current,
    });
    current = '';
  };
  for (const p of paragraphs) {
    if (current && current.length + p.length > SECTION_CHARS) flush();
    current = current ? `${current}\n${p}` : p;
  }
  flush();
  return passages;
}
