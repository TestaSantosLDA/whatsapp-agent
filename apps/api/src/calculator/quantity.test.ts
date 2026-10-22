import { describe, expect, it } from 'vitest';
import {
  CalculatorInputError,
  calculateQuantity,
  parseArea,
  productKind,
  toScaled,
} from './quantity.js';

describe('parseArea', () => {
  it('takes a number of m² as is', () => {
    expect(parseArea(35).areaM2).toBe(35);
  });

  it('converts "4 x 5 m" to 20 m²', () => {
    const area = parseArea('4 x 5 m');
    expect(area.areaM2).toBe(20);
    expect(area.rooms).toEqual([{ widthM: 4, lengthM: 5, areaM2: 20 }]);
    expect(area.perimeterM).toBe(18);
  });

  it.each([
    ['4x5', 20],
    ['4 x 5', 20],
    ['4m x 5m', 20],
    ['4 × 5', 20],
    ['4 por 5 metros', 20],
    ['4,5 x 3,2', 14.4],
    ['4.5 x 3.2', 14.4],
    ['400 x 500 cm', 20],
    ['35 m2', 35],
    ['35m²', 35],
    ['35', 35],
    ['22,5 m²', 22.5],
  ])('reads %s as %d m²', (text, expected) => {
    expect(parseArea(text).areaM2).toBe(expected);
  });

  it('sums several rooms', () => {
    const area = parseArea('4,5 x 3,2 + 3 x 3 e 2x2');
    expect(area.areaM2).toBe(27.4);
    expect(area.rooms).toHaveLength(3);
    expect(area.perimeterM).toBeCloseTo(2 * (7.7 + 6 + 4), 10);
  });

  it('mixes rooms and m², without a perimeter', () => {
    const area = parseArea('4 x 5 + 10 m2');
    expect(area.areaM2).toBe(30);
    expect(area.perimeterM).toBeUndefined();
  });

  it('rejects text it cannot read', () => {
    expect(() => parseArea('a sala grande')).toThrow(CalculatorInputError);
    expect(() => parseArea('4 x 5 e mais 7')).toThrow(CalculatorInputError);
    expect(() => parseArea(0)).toThrow(CalculatorInputError);
  });
});

describe('calculateQuantity', () => {
  const base = { m2PerBox: 2.22, unitPrice: '39.90', priceUnit: 'box' as const };

  it('35 m² at 2.22 m²/box with 7% waste is 17 boxes', () => {
    const r = calculateQuantity({ ...base, areaM2: 35 });
    expect(r.waste).toBe(0.07);
    expect(r.requiredM2).toBe(37.45);
    expect(r.boxes).toBe(17);
    expect(r.coveredM2).toBe(37.74);
    expect(r.totalPrice).toBe(678.3);
    expect(r.totalCents).toBe(67830);
  });

  it('uses 10% waste for diagonal laying', () => {
    const r = calculateQuantity({ ...base, areaM2: 35, layout: 'diagonal' });
    expect(r.waste).toBe(0.1);
    expect(r.requiredM2).toBe(38.5);
    expect(r.boxes).toBe(18);
  });

  it('lets the waste be overridden', () => {
    expect(calculateQuantity({ ...base, areaM2: 35, waste: 0, layout: 'diagonal' }).boxes).toBe(16);
  });

  it('does not round up an exact number of boxes because of float drift', () => {
    // 20.79 / 2.31 is exactly 9 boxes; in floats it is 9.000000000000002.
    expect(calculateQuantity({ ...base, m2PerBox: 2.31, areaM2: 20.79, waste: 0 }).boxes).toBe(9);
  });

  it('prices per m² on the area the whole boxes cover', () => {
    const r = calculateQuantity({
      areaM2: 35,
      m2PerBox: 2.22,
      unitPrice: '17.95',
      priceUnit: 'm2',
    });
    expect(r.boxes).toBe(17);
    // 37.74 m² × 17.95 = 677.433 → 677.43
    expect(r.totalPrice).toBe(677.43);
    expect(r.m2Price).toBe(17.95);
    expect(r.boxPrice).toBe(39.85); // 2.22 × 17.95 = 39.849
  });

  it('prices per box as boxes × box price, to the cent', () => {
    const r = calculateQuantity({ areaM2: 10, m2PerBox: 1.5, unitPrice: 0.1, priceUnit: 'box' });
    expect(r.boxes).toBe(8); // 10.7 / 1.5 = 7.13
    expect(r.totalPrice).toBe(0.8);
    expect(r.m2Price).toBe(0.07); // 0.1 / 1.5 = 0.0667
  });

  it('rounds half a cent up', () => {
    // 1 box of 1.5 m² at 0.33/m² = 0.495 → 0.50
    const r = calculateQuantity({
      areaM2: 1,
      m2PerBox: 1.5,
      unitPrice: '0.33',
      priceUnit: 'm2',
      waste: 0,
    });
    expect(r.totalCents).toBe(50);
  });

  it('suggests underlay, skirting and profiles for laminate', () => {
    const r = calculateQuantity({
      ...base,
      areaM2: 20,
      perimeterM: 18,
      productType: 'Pavimento Laminado',
    });
    expect(r.kind).toBe('laminate');
    expect(r.accessories).toEqual([
      expect.objectContaining({ kind: 'underlay', quantity: 20, unit: 'm2' }),
      expect.objectContaining({ kind: 'skirting', quantity: 19, unit: 'm' }), // 18.9 → 19
      expect.objectContaining({ kind: 'transition_profiles', quantity: null }),
    ]);
  });

  it('asks for the perimeter when skirting cannot be worked out', () => {
    const r = calculateQuantity({ ...base, areaM2: 20, productType: 'Vinílico SPC' });
    expect(r.kind).toBe('vinyl');
    expect(r.accessories.find((a) => a.kind === 'skirting')?.quantity).toBeNull();
  });

  it('suggests clips and joists for decking', () => {
    const r = calculateQuantity({ ...base, areaM2: 12.5, productType: 'Deck Compósito' });
    expect(r.kind).toBe('decking');
    expect(r.accessories).toEqual([
      expect.objectContaining({ kind: 'clips_and_screws', quantity: 313 }),
      expect.objectContaining({ kind: 'joists', quantity: 38, unit: 'm' }),
    ]);
  });

  it('has no accessories for other products', () => {
    expect(calculateQuantity({ ...base, areaM2: 5, productType: 'Cola' }).accessories).toEqual([]);
  });

  it('rejects impossible input', () => {
    expect(() => calculateQuantity({ ...base, areaM2: 10, m2PerBox: 0 })).toThrow(
      CalculatorInputError,
    );
    expect(() => calculateQuantity({ ...base, areaM2: 10, waste: 1 })).toThrow(
      CalculatorInputError,
    );
  });
});

describe('helpers', () => {
  it('scales decimals exactly', () => {
    expect(toScaled(2.22, 4)).toBe(22200n);
    expect(toScaled('29,95', 2)).toBe(2995n);
    expect(toScaled('0.125', 2)).toBe(13n);
    expect(toScaled(0.1 + 0.2, 2)).toBe(30n);
  });

  it('classifies product types', () => {
    expect(productKind('Soalho Multicamada Carvalho')).toBe('wood');
    expect(productKind('Deck de Madeira')).toBe('decking');
    expect(productKind(null, 'Pavimento Flutuante')).toBe('wood');
  });
});
