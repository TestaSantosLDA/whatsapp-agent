import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  computeQuoteTotals,
  formatCents,
  formatDecimal,
  quoteChannelLabels,
  quoteStatusLabels,
  type QuoteChannel,
  type QuoteCustomer,
  type QuoteDetail,
  type QuoteDraft,
  type QuoteLine,
} from '@wa/shared';
import { errorMessage, personName, shortBranch, shortDate } from '../leads/leads.data';
import { decimalText, longDate, parseDecimal, QuotesData } from './quotes.data';

type NumberField = 'quantity' | 'unitPrice' | 'discountPercent' | 'vatPercent';
type TextField = 'description' | 'unit' | 'sku';

const CUSTOMER_FIELDS: { key: keyof QuoteCustomer; label: string; type?: string }[] = [
  { key: 'name', label: 'Nome' },
  { key: 'company', label: 'Empresa' },
  { key: 'nif', label: 'NIF' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Telefone', type: 'tel' },
  { key: 'address', label: 'Morada' },
];

const draftOf = (q: QuoteDetail): QuoteDraft => ({
  customer: { ...q.customer },
  lines: q.lines.map((l) => ({ ...l })),
  discount: q.discount ? { ...q.discount } : null,
  validUntil: q.validUntil,
  fulfilment: q.fulfilment,
  notes: q.notes,
});

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** One quote (WA-025): edit lines, prices, discounts and conditions; preview; send. */
@Component({
  selector: 'app-quote-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quote.page.html',
  styleUrl: './quote.page.css',
})
export class QuotePage {
  private readonly data = inject(QuotesData);
  private readonly router = inject(Router);

  /** The route's `:id`. */
  readonly id = input.required<string>();

  protected readonly quote = signal<QuoteDetail | null>(null);
  protected readonly draft = signal<QuoteDraft | null>(null);
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly emailTo = signal('');

  protected readonly customerFields = CUSTOMER_FIELDS;
  protected readonly locked = computed(() => this.quote()?.status === 'sent');
  /** Totals as the API computes them, live while editing (the API recomputes on save). */
  protected readonly totals = computed(() => {
    const d = this.draft();
    if (!d) return null;
    return computeQuoteTotals(
      d.lines.map((l) => ({
        quantity: finite(l.quantity),
        unitPrice: finite(l.unitPrice),
        discountPercent: finite(l.discountPercent),
        vatPercent: finite(l.vatPercent),
      })),
      d.discount && Number.isFinite(d.discount.value) ? d.discount : null,
    );
  });

  constructor() {
    effect(() => {
      const id = this.id();
      void this.run(async () => this.load(await this.data.get(id)));
    });
  }

  protected money = formatCents;
  protected date = longDate;
  protected when = shortDate;
  protected person = personName;
  protected branch = shortBranch;
  protected num = decimalText;
  protected pct = (n: number) => formatDecimal(n, 0, 2);
  protected statusLabel = (q: QuoteDetail) => quoteStatusLabels[q.status];
  protected channelLabel = (c: QuoteChannel) => quoteChannelLabels[c];

  private load(q: QuoteDetail) {
    this.quote.set(q);
    this.draft.set(draftOf(q));
    this.dirty.set(false);
    if (!this.emailTo()) this.emailTo.set(q.customer.email ?? '');
  }

  private edit(change: (d: QuoteDraft) => QuoteDraft) {
    const d = this.draft();
    if (!d || this.locked()) return;
    this.draft.set(change(d));
    this.dirty.set(true);
    this.notice.set(null);
  }

  protected setCustomer(key: keyof QuoteCustomer, value: string) {
    this.edit((d) => ({ ...d, customer: { ...d.customer, [key]: value.trim() ? value : null } }));
    if (key === 'email') this.emailTo.set(value.trim());
  }

  protected setField(key: 'validUntil' | 'fulfilment' | 'notes', value: string) {
    this.edit((d) => ({
      ...d,
      [key]: key === 'validUntil' ? value : value.trim() ? value : null,
    }));
  }

  protected setLineText(i: number, key: TextField, value: string) {
    this.editLine(i, { [key]: key === 'sku' && !value.trim() ? null : value });
  }

  protected setLineNumber(i: number, key: NumberField, value: string) {
    this.editLine(i, { [key]: parseDecimal(value) });
  }

  private editLine(i: number, patch: Partial<QuoteLine>) {
    this.edit((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  }

  protected addLine() {
    const vat = this.quote()?.defaultVatPercent ?? 23;
    this.edit((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          variantId: null,
          sku: null,
          description: '',
          quantity: 1,
          unit: 'un',
          unitPrice: 0,
          discountPercent: 0,
          vatPercent: vat,
        },
      ],
    }));
  }

  protected removeLine(i: number) {
    this.edit((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));
  }

  protected setDiscountKind(kind: string) {
    this.edit((d) => ({
      ...d,
      discount:
        kind === 'percent' || kind === 'amount' ? { kind, value: d.discount?.value ?? 0 } : null,
    }));
  }

  protected setDiscountValue(value: string) {
    this.edit((d) =>
      d.discount ? { ...d, discount: { ...d.discount, value: parseDecimal(value) } } : d,
    );
  }

  protected save(): Promise<void> {
    return this.run(async () => {
      await this.persist();
      this.notice.set('Orçamento guardado.');
    });
  }

  private async persist() {
    const d = this.draft();
    if (!d || this.locked() || !this.dirty()) return;
    this.load(await this.data.save(this.id(), d));
  }

  protected async openPdf(): Promise<void> {
    // Opened now, while the tap counts as the user's: browsers block windows opened later.
    const win = window.open('', '_blank');
    await this.run(async () => {
      await this.persist();
      const url = await this.data.pdfUrl(this.id());
      if (win) win.location.href = url;
      else window.location.href = url;
    });
    if (this.error()) win?.close();
  }

  protected send(channel: QuoteChannel): Promise<void> {
    return this.run(async () => {
      await this.persist();
      const email = this.emailTo().trim();
      const q = await this.data.send(this.id(), {
        channel,
        ...(channel === 'email' && email && { email }),
      });
      this.load(q);
      this.notice.set(
        channel === 'whatsapp'
          ? 'Enviado para o WhatsApp do cliente. O pedido passou a Orçamentado.'
          : `Enviado por email para ${q.sends.at(-1)?.to ?? email}. O pedido passou a Orçamentado.`,
      );
    });
  }

  protected remove(): Promise<void> {
    return this.run(async () => {
      const leadId = this.quote()?.leadId;
      await this.data.remove(this.id());
      await this.router.navigate(leadId ? ['/leads', leadId] : ['/leads']);
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
