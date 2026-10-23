/**
 * The quote PDF (WA-025): the client's letterhead (logo, legal name, NIF, contacts), the
 * customer, the lines, totals with IVA per rate, notes, conditions and a legal footer on every
 * page, numbered "Página 1 de 2". Drawn with pdf-lib (MIT, pure JS) and its standard Helvetica,
 * so nothing is downloaded at render time except the client's logo, through the injected fetch.
 *
 * Amounts are never computed here: they come from computeQuoteTotals.
 */
import {
  formatCents,
  formatDecimal,
  type Branch,
  type ClientConfig,
  type QuoteCustomer,
  type QuoteDiscount,
  type QuoteLine,
  type QuoteTotals,
} from '@wa/shared';
import {
  degrees,
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';

export interface QuotePdfInput {
  client: ClientConfig;
  number: string;
  /** The date printed as the quote's date. */
  issuedAt: Date;
  validUntil: string;
  branch?: Branch;
  customer: QuoteCustomer;
  lines: QuoteLine[];
  discount: QuoteDiscount;
  totals: QuoteTotals;
  fulfilment: string | null;
  notes: string | null;
  /** A preview of a draft: marked "Rascunho" on every page. */
  draft?: boolean;
}

/** Turns a quote into PDF bytes. Injected into QuotesService, so tests can swap it. */
export interface QuotePdfRenderer {
  render(input: QuotePdfInput): Promise<Uint8Array>;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 42;
const INK = rgb(0.13, 0.15, 0.17);
const MUTED = rgb(0.42, 0.46, 0.5);
const RULE = rgb(0.85, 0.87, 0.89);
const BAND = rgb(0.95, 0.96, 0.96);

/** Table columns: x offset from the margin, width, alignment. */
const COLUMNS = [
  { key: 'ref', label: 'Ref.', width: 72, align: 'left' },
  { key: 'description', label: 'Descrição', width: 172, align: 'left' },
  { key: 'quantity', label: 'Qtd.', width: 42, align: 'right' },
  { key: 'unit', label: 'Un.', width: 26, align: 'left' },
  { key: 'price', label: 'Preço unit.', width: 62, align: 'right' },
  { key: 'discount', label: 'Desc.', width: 34, align: 'right' },
  { key: 'vat', label: 'IVA', width: 30, align: 'right' },
  { key: 'total', label: 'Total s/ IVA', width: 73.28, align: 'right' },
] as const;
type ColumnKey = (typeof COLUMNS)[number]['key'];

export class PdfLibQuoteRenderer implements QuotePdfRenderer {
  private readonly logos = new Map<string, Promise<Uint8Array | null>>();

  constructor(private readonly deps: { fetch?: typeof fetch } = {}) {}

  async render(input: QuotePdfInput): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(`Orçamento ${input.number}`);
    doc.setAuthor(companyName(input.client));
    doc.setCreator('Assistente WhatsApp');
    doc.setProducer('pdf-lib');
    doc.setCreationDate(input.issuedAt);
    doc.setModificationDate(input.issuedAt);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const logoBytes = input.client.quotes.logo_url
      ? await this.logo(input.client.quotes.logo_url)
      : null;
    const logo = logoBytes ? await embedImage(doc, logoBytes) : null;
    new QuoteLayout(doc, input, { regular, bold }, logo).draw();
    return doc.save();
  }

  /** The logo's bytes, fetched once per URL; a logo that fails to load is left out. */
  private logo(url: string): Promise<Uint8Array | null> {
    let pending = this.logos.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const res = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        } catch (error) {
          console.warn(`[quotes] logo ${url} could not be loaded; quotes go without it`, error);
          this.logos.delete(url);
          return null;
        }
      })();
      this.logos.set(url, pending);
    }
    return pending;
  }
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage | null> {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
  } catch (error) {
    console.warn('[quotes] the logo is not a valid PNG or JPEG', error);
  }
  return null;
}

const companyName = (client: ClientConfig) => client.quotes.company.legal_name ?? client.name;

/** "Norte (Maia)" for "Norte (Maia)", "Azambuja" for "Azambuja (Sede, Fábrica e ...) — ...". */
export function shortBranchName(name: string): string {
  return name
    .split(' — ')[0]!
    .trim()
    .replace(/\s*\(([^)]{20,})\)$/, '');
}

/** dd/mm/aaaa of a YYYY-MM-DD date. */
export const ptDate = (iso: string) => iso.split('-').reverse().join('/');

/** The date in the client's time zone, YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The cells of one line, formatted (pt-PT). */
export function lineCells(line: QuoteLine, netCents: number): Record<ColumnKey, string> {
  return {
    ref: line.sku ?? '',
    description: line.description,
    quantity: formatDecimal(line.quantity, 0, 3),
    unit: line.unit,
    price: formatDecimal(line.unitPrice, 2, 4),
    discount: line.discountPercent ? `${formatDecimal(line.discountPercent, 0, 2)} %` : '',
    vat: `${formatDecimal(line.vatPercent, 0, 2)} %`,
    total: formatCents(netCents),
  };
}

/** The totals block, label and amount per row, as printed. */
export function totalRows(
  totals: QuoteTotals,
  discount: QuoteDiscount,
): { label: string; value: string; strong?: boolean }[] {
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Subtotal', value: formatCents(totals.subtotalCents) },
  ];
  if (totals.discountCents) {
    const pct = discount?.kind === 'percent' ? ` (${formatDecimal(discount.value, 0, 2)} %)` : '';
    rows.push({ label: `Desconto${pct}`, value: `-${formatCents(totals.discountCents)}` });
    rows.push({ label: 'Total sem IVA', value: formatCents(totals.netCents) });
  }
  for (const g of totals.vat) {
    rows.push({
      label: `IVA ${formatDecimal(g.percent, 0, 2)} % sobre ${formatCents(g.baseCents)}`,
      value: formatCents(g.vatCents),
    });
  }
  rows.push({ label: 'Total', value: formatCents(totals.totalCents), strong: true });
  return rows;
}

class QuoteLayout {
  private page!: PDFPage;
  private y = 0;
  private readonly pages: PDFPage[] = [];
  private readonly width = A4[0] - 2 * MARGIN;
  /** Codepoints Helvetica (WinAnsi) can draw. */
  private readonly charset: Set<number>;

  constructor(
    private readonly doc: PDFDocument,
    private readonly q: QuotePdfInput,
    private readonly fonts: { regular: PDFFont; bold: PDFFont },
    private readonly logo: PDFImage | null,
  ) {
    this.charset = new Set(fonts.regular.getCharacterSet());
  }

  draw() {
    this.newPage();
    this.letterhead();
    this.titleBlock();
    this.tableHeader();
    this.q.lines.forEach((line, i) => this.row(line, this.q.totals.lines[i]!.netCents, i));
    if (!this.q.lines.length) this.text('Sem linhas.', MARGIN, this.y - 14, 9, { color: MUTED });
    this.y -= this.q.lines.length ? 6 : 24;
    this.totals();
    if (this.q.notes) this.section('Observações', this.q.notes.split('\n'));
    const conditions = [
      `Orçamento válido até ${ptDate(this.q.validUntil)}.`,
      ...this.q.client.quotes.conditions,
    ];
    this.section('Condições', conditions, true);
    this.footers();
  }

  /** Text Helvetica can draw: unknown characters lose their accents, else become "?". */
  private safe(text: string): string {
    let out = '';
    for (const ch of text.replace(/[\r\t]/g, ' ')) {
      if (this.charset.has(ch.codePointAt(0)!)) out += ch;
      else {
        const plain = ch.normalize('NFD').replace(/\p{Diacritic}/gu, '');
        out += [...plain].every((c) => this.charset.has(c.codePointAt(0)!)) ? plain : '?';
      }
    }
    return out;
  }

  private text(
    value: string,
    x: number,
    y: number,
    size: number,
    o: {
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      align?: 'left' | 'right';
      width?: number;
    } = {},
  ) {
    const font = o.bold ? this.fonts.bold : this.fonts.regular;
    const s = this.safe(value);
    const dx = o.align === 'right' && o.width ? o.width - font.widthOfTextAtSize(s, size) : 0;
    this.page.drawText(s, { x: x + dx, y, size, font, color: o.color ?? INK });
  }

  /** Splits text into lines that fit `width` (words longer than a line are cut). */
  private wrap(value: string, width: number, size: number, bold = false): string[] {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
    const lines: string[] = [];
    for (const paragraph of this.safe(value).split('\n')) {
      let line = '';
      for (let word of paragraph.split(/\s+/).filter(Boolean)) {
        while (!fits(word)) {
          let cut = word.length - 1;
          while (cut > 1 && !fits(word.slice(0, cut))) cut--;
          if (line) lines.push(line);
          lines.push(word.slice(0, cut));
          line = '';
          word = word.slice(cut);
        }
        const next = line ? `${line} ${word}` : word;
        if (fits(next)) line = next;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  private newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - MARGIN;
    if (this.q.draft) {
      this.page.drawText('RASCUNHO', {
        x: 150,
        y: 330,
        size: 90,
        font: this.fonts.bold,
        color: rgb(0.93, 0.94, 0.95),
        rotate: degrees(35),
      });
    }
  }

  /** Room for `height` more points above the footer, else a new page (with the table header). */
  private ensure(height: number, tableHeader = false) {
    if (this.y - height >= MARGIN + 40) return;
    this.newPage();
    this.text(`Orçamento ${this.q.number} (continuação)`, MARGIN, this.y - 10, 9, {
      color: MUTED,
    });
    this.y -= 24;
    if (tableHeader) this.tableHeader();
  }

  private letterhead() {
    const c = this.q.client.quotes.company;
    const top = this.y;
    let left: number;
    if (this.logo) {
      const scale = Math.min(150 / this.logo.width, 54 / this.logo.height, 1);
      const w = this.logo.width * scale;
      const h = this.logo.height * scale;
      this.page.drawImage(this.logo, { x: MARGIN, y: top - h, width: w, height: h });
      left = top - h - 8;
    } else {
      this.text(companyName(this.q.client), MARGIN, top - 16, 16, { bold: true });
      left = top - 24;
    }
    const details = [
      this.logo ? companyName(this.q.client) : null,
      c.address,
      c.nif ? `NIF ${c.nif}` : null,
      [c.phone, c.email].filter(Boolean).join(' · ') || null,
      c.website ?? null,
    ].filter((v): v is string => !!v);
    let y = top - 8;
    for (const d of details) {
      for (const l of this.wrap(d, 230, 8)) {
        this.text(l, MARGIN + this.width - 230, y, 8, {
          color: MUTED,
          align: 'right',
          width: 230,
        });
        y -= 11;
      }
    }
    this.y = Math.min(left, y) - 14;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.width, y: this.y },
      thickness: 0.8,
      color: RULE,
    });
    this.y -= 22;
  }

  private titleBlock() {
    const q = this.q;
    this.text('Orçamento', MARGIN, this.y, 18, { bold: true });
    this.text(q.number, MARGIN, this.y - 16, 11, { color: MUTED });
    const meta = [
      ['Data', ptDate(localDate(q.issuedAt, q.client.timezone))],
      ['Válido até', ptDate(q.validUntil)],
      ...(q.branch ? [['Atendimento', shortBranchName(q.branch.name)]] : []),
    ];
    let my = this.y;
    for (const [label, value] of meta) {
      this.text(label!, MARGIN + this.width - 200, my, 9, { color: MUTED });
      this.text(value!, MARGIN + this.width - 120, my, 9, { align: 'right', width: 120 });
      my -= 13;
    }
    this.y = Math.min(this.y - 36, my - 8);

    // Customer box.
    const c = q.customer;
    const rows = [
      c.company,
      c.name,
      c.nif ? `NIF ${c.nif}` : null,
      c.address,
      [c.phone, c.email].filter(Boolean).join(' · ') || null,
    ].filter((v): v is string => !!v);
    const lines = rows.flatMap((r) => this.wrap(r, this.width / 2 - 20, 9));
    const fulfilment = q.fulfilment ? this.wrap(q.fulfilment, this.width / 2 - 20, 9) : [];
    const height = 26 + Math.max(lines.length, fulfilment.length, 1) * 12;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - height,
      width: this.width,
      height,
      color: BAND,
    });
    this.text('Cliente', MARGIN + 10, this.y - 15, 8, { bold: true, color: MUTED });
    lines.forEach((l, i) => this.text(l, MARGIN + 10, this.y - 28 - i * 12, 9, { bold: i === 0 }));
    if (fulfilment.length) {
      const x = MARGIN + this.width / 2 + 10;
      this.text('Entrega', x, this.y - 15, 8, { bold: true, color: MUTED });
      fulfilment.forEach((l, i) => this.text(l, x, this.y - 28 - i * 12, 9));
    }
    this.y -= height + 20;
  }

  private tableHeader() {
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 18,
      width: this.width,
      height: 18,
      color: INK,
    });
    let x = MARGIN;
    for (const col of COLUMNS) {
      this.text(col.label, x + 4, this.y - 12.5, 8, {
        bold: true,
        color: rgb(1, 1, 1),
        align: col.align,
        width: col.width - 8,
      });
      x += col.width;
    }
    this.y -= 18;
  }

  private row(line: QuoteLine, netCents: number, index: number) {
    const cells = lineCells(line, netCents);
    const size = 8.5;
    const wrapped = Object.fromEntries(
      COLUMNS.map((col) => [col.key, this.wrap(cells[col.key], col.width - 8, size)]),
    ) as Record<ColumnKey, string[]>;
    const height = 8 + Math.max(...Object.values(wrapped).map((l) => l.length)) * 11;
    this.ensure(height, true);
    if (index % 2 === 1) {
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - height,
        width: this.width,
        height,
        color: BAND,
      });
    }
    let x = MARGIN;
    for (const col of COLUMNS) {
      wrapped[col.key].forEach((l, i) =>
        this.text(l, x + 4, this.y - 12 - i * 11, size, {
          align: col.align,
          width: col.width - 8,
          bold: col.key === 'total',
        }),
      );
      x += col.width;
    }
    this.y -= height;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.width, y: this.y },
      thickness: 0.4,
      color: RULE,
    });
  }

  private totals() {
    const rows = totalRows(this.q.totals, this.q.discount);
    this.ensure(rows.length * 15 + 16);
    const x = MARGIN + this.width - 260;
    for (const r of rows) {
      if (r.strong) {
        this.y -= 7;
        this.page.drawLine({
          start: { x, y: this.y + 1 },
          end: { x: MARGIN + this.width, y: this.y + 1 },
          thickness: 0.8,
          color: INK,
        });
        this.y -= 4;
      }
      const size = r.strong ? 12 : 9;
      this.y -= size + 5;
      this.text(r.label, x, this.y, size, { bold: r.strong, color: r.strong ? INK : MUTED });
      this.text(r.value, x + 150, this.y, size, { bold: r.strong, align: 'right', width: 110 });
    }
    this.y -= 20;
  }

  private section(title: string, items: string[], bullets = false) {
    const lines = items.flatMap((item) =>
      this.wrap(item, this.width - (bullets ? 12 : 0), 8.5).map((l, i) => ({
        l,
        bullet: bullets && i === 0,
      })),
    );
    this.ensure(30);
    this.text(title, MARGIN, this.y, 10, { bold: true });
    this.y -= 15;
    for (const { l, bullet } of lines) {
      this.ensure(12);
      if (bullet) this.text('•', MARGIN, this.y, 8.5, { color: MUTED });
      this.text(l, MARGIN + (bullets ? 12 : 0), this.y, 8.5);
      this.y -= 11.5;
    }
    this.y -= 12;
  }

  private footers() {
    const footer = this.q.client.quotes.footer;
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      this.page = page;
      const lines = footer ? this.wrap(footer, this.width - 160, 7) : [];
      lines.forEach((l, j) =>
        this.text(l, MARGIN, MARGIN - 4 + (lines.length - 1 - j) * 9, 7, {
          color: MUTED,
        }),
      );
      this.text(
        `${this.q.number} · Página ${i + 1} de ${total}`,
        MARGIN + this.width - 140,
        MARGIN - 4,
        7,
        {
          color: MUTED,
          align: 'right',
          width: 140,
        },
      );
    });
  }
}
