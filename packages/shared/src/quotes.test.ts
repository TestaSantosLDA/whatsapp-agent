import { describe, expect, it } from 'vitest';
import {
  computeQuoteTotals,
  formatCents,
  formatDecimal,
  netFromGross,
  quoteDraftSchema,
  quoteLineSchema,
} from './quotes.js';

const line = (quantity: number, unitPrice: number, discountPercent = 0, vatPercent = 23) => ({
  quantity,
  unitPrice,
  discountPercent,
  vatPercent,
});

describe('computeQuoteTotals', () => {
  it('multiplies, rounds each line to the cent and adds IVA on the subtotal', () => {
    const t = computeQuoteTotals([line(14, 20.3252), line(3, 1.3333)]);
    // 14 × 20,3252 = 284,5528 → 284,55; 3 × 1,3333 = 3,9999 → 4,00
    expect(t.lines.map((l) => l.netCents)).toEqual([28455, 400]);
    expect(t.subtotalCents).toBe(28855);
    expect(t.vat).toEqual([{ percent: 23, baseCents: 28855, vatCents: 6637 }]); // 66,3665
    expect(t.totalCents).toBe(28855 + 6637);
  });

  it('gets back the catalogue price with IVA from its net price', () => {
    expect(netFromGross(25, 23)).toBe(20.3252);
    expect(netFromGross(29.95, 23)).toBe(24.3496);
    expect(netFromGross(0, 23)).toBe(0);
    expect(netFromGross(10, 0)).toBe(10);
    // 10 boxes of a 25 € (IVA incl.) deck: 250 € again.
    expect(computeQuoteTotals([line(10, netFromGross(25, 23))]).totalCents).toBe(25000);
    expect(computeQuoteTotals([line(14, netFromGross(59.9, 23))]).totalCents).toBe(83860);
  });

  it('applies line discounts before the global discount, both rounded half up', () => {
    const t = computeQuoteTotals([line(2, 10.005, 10), line(1, 100, 0)], {
      kind: 'percent',
      value: 5,
    });
    // 2 × 10,005 = 20,01; −10 % = 2,001 → 2,00; net 18,01
    expect(t.lines[0]).toEqual({ grossCents: 2001, discountCents: 200, netCents: 1801 });
    expect(t.subtotalCents).toBe(11801);
    expect(t.discountCents).toBe(590); // 5 % of 118,01 = 5,9005
    expect(t.netCents).toBe(11211);
    expect(t.vatCents).toBe(2579); // 23 % of 112,11 = 25,7853
    expect(t.totalCents).toBe(13790);
  });

  it('takes an amount off the net subtotal, never more than the subtotal', () => {
    expect(computeQuoteTotals([line(1, 100)], { kind: 'amount', value: 15.5 })).toMatchObject({
      discountCents: 1550,
      netCents: 8450,
      vatCents: 1944, // 19,435
      totalCents: 10394,
    });
    expect(computeQuoteTotals([line(1, 10)], { kind: 'amount', value: 50 })).toMatchObject({
      discountCents: 1000,
      netCents: 0,
      totalCents: 0,
    });
    expect(computeQuoteTotals([line(1, 10, 100)]).totalCents).toBe(0);
  });

  it('groups IVA per rate and spreads a global discount over the rates', () => {
    const t = computeQuoteTotals([line(1, 100, 0, 23), line(1, 50, 0, 6), line(1, 0.01, 0, 13)], {
      kind: 'amount',
      value: 10,
    });
    // 1000 cents over 150,01 €: 23 % gets 666 (+1 by largest remainder), 6 % 333, 13 % 0.
    expect(t.vat).toEqual([
      { percent: 23, baseCents: 10000 - 667, vatCents: 2147 }, // 93,33 × 23 % = 21,4659
      { percent: 13, baseCents: 1, vatCents: 0 },
      { percent: 6, baseCents: 5000 - 333, vatCents: 280 }, // 46,67 × 6 % = 2,8002
    ]);
    expect(t.vat.reduce((s, g) => s + g.baseCents, 0)).toBe(t.netCents);
    expect(t.netCents).toBe(15001 - 1000);
    expect(t.totalCents).toBe(t.netCents + 2147 + 280);
  });

  it('is zero for an empty quote', () => {
    expect(computeQuoteTotals([], { kind: 'percent', value: 10 })).toEqual({
      lines: [],
      subtotalCents: 0,
      discountCents: 0,
      netCents: 0,
      vat: [],
      vatCents: 0,
      totalCents: 0,
    });
  });

  it('keeps fractional quantities exact (m², metres)', () => {
    // 31,08 m² × 18,4959 = 574,852572 → 574,85
    expect(computeQuoteTotals([line(31.08, 18.4959)]).lines[0]!.netCents).toBe(57485);
    // 0,1 + 0,2 style float noise never shows up: 3 × 0,1 m at 0,1 €.
    expect(computeQuoteTotals([line(0.3, 0.1)]).lines[0]!.netCents).toBe(3);
  });
});

describe('quote schemas', () => {
  it('limits decimals and ranges with messages in pt-PT', () => {
    const ok = quoteLineSchema.parse({
      description: 'Deck',
      quantity: 1.5,
      unitPrice: 2,
      vatPercent: 23,
    });
    expect(ok).toMatchObject({ unit: 'un', discountPercent: 0, variantId: null, sku: null });
    const bad = (patch: Record<string, unknown>) =>
      quoteLineSchema.safeParse({
        description: 'x',
        quantity: 1,
        unitPrice: 1,
        vatPercent: 23,
        ...patch,
      }).error?.issues[0]?.message;
    expect(bad({ quantity: 0 })).toMatch(/maior que zero/);
    expect(bad({ quantity: 1.0001 })).toMatch(/3 casas decimais/);
    expect(bad({ unitPrice: 1.00001 })).toMatch(/4 casas decimais/);
    expect(bad({ discountPercent: 120 })).toMatch(/entre 0 e 100/);
    expect(bad({ description: ' ' })).toMatch(/Descreva/);
  });

  it('accepts an empty email as none', () => {
    const d = quoteDraftSchema.parse({
      customer: { name: 'Ana', email: '' },
      lines: [],
      validUntil: '2026-11-22',
    });
    expect(d.customer.email).toBeNull();
    expect(d.discount).toBeNull();
  });
});

describe('formatting', () => {
  it('writes euros the Portuguese way', () => {
    expect(formatCents(123456)).toBe('1 234,56 €');
    expect(formatCents(5)).toBe('0,05 €');
    expect(formatDecimal(20.3252, 2, 4)).toBe('20,3252');
    expect(formatDecimal(14, 0, 3)).toBe('14');
    expect(formatDecimal(31.08, 0, 3)).toBe('31,08');
  });
});
