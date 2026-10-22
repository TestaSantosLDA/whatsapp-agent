/**
 * Quantity and price maths for flooring and decking (WA-012).
 *
 * Pure and deterministic: no database, no model. All arithmetic is done on scaled integers
 * (BigInt) so results never drift: areas in 1/10 000 m², waste in basis points, money in cents.
 */

/** A value that could not be used for a calculation (bad area text, zero box size...). */
export class CalculatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorInputError';
  }
}

export type PriceUnit = 'box' | 'm2';
export type Layout = 'straight' | 'diagonal';
export type ProductKind = 'laminate' | 'vinyl' | 'wood' | 'decking' | 'other';

export const DEFAULT_WASTE = 0.07;
export const DIAGONAL_WASTE = 0.1;

const AREA_SCALE = 10_000n; // 1/10 000 m²
const WASTE_SCALE = 10_000n; // basis points

// ---------------------------------------------------------------------------------------------
// Decimal helpers

/**
 * Converts a decimal number or string ("2.22", "2,22", 29.95) to an integer scaled by
 * 10^decimals, rounding half up past that many decimals. Strings are parsed digit by digit, and
 * numbers through their shortest decimal representation, so 2.22 becomes exactly 22200 at 4 dp.
 */
export function toScaled(value: number | string, decimals: number): bigint {
  const text = (typeof value === 'number' ? numberToPlain(value) : value.trim()).replace(',', '.');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new CalculatorInputError(`"${value}" is not a number`);
  }
  const [, sign, int = '', frac = ''] = match;
  const kept = frac.slice(0, decimals).padEnd(decimals, '0');
  let scaled = BigInt((int || '0') + kept);
  if ((frac[decimals] ?? '0') >= '5') scaled += 1n;
  return sign === '-' ? -scaled : scaled;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new CalculatorInputError(`${n} is not a finite number`);
  const s = String(n);
  // Exponent notation only shows up for very large or tiny values; 20 dp covers our scales.
  return /e/i.test(s) ? n.toFixed(20) : s;
}

function fromScaled(value: bigint, scale: bigint): number {
  return Number(value) / Number(scale);
}

/** a / b rounded half up, for non-negative a and positive b. */
function divRound(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (b * 2n);
}

/** a / b rounded up, for non-negative a and positive b. */
function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

// ---------------------------------------------------------------------------------------------
// Area parsing

export interface Room {
  /** First dimension in metres. */
  widthM: number;
  /** Second dimension in metres. */
  lengthM: number;
  areaM2: number;
}

export interface ParsedArea {
  areaM2: number;
  /** Rooms given as dimensions, in the order they appeared. Empty when only m² was given. */
  rooms: Room[];
  /** Areas given directly in m² inside the text ("10 m2"), or the number passed in. */
  directM2: number[];
  /** Sum of room perimeters in metres, when every part of the input was a room. */
  perimeterM?: number;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(cm|m(?![²2]))?`;
/** "4 x 5", "4x5 m", "4,5 × 3,2", "400 cm x 500 cm", "4 por 5". */
const DIMENSIONS = new RegExp(
  String.raw`${NUM}\s*${UNIT}\s*(?:x|×|\*|por|by)\s*${NUM}\s*${UNIT}`,
  'gi',
);
/** "10 m2", "10m²", "10 metros quadrados", "10 sqm". */
const SQUARE_METRES = new RegExp(
  String.raw`${NUM}\s*(?:m\s*[²2]|metros?\s+quadrados?|sq\.?\s*m|sqm)`,
  'gi',
);

/**
 * Reads an area from a number of m² or from text with room dimensions. Several rooms (or m²
 * amounts) in one text are summed: "4 x 5 + 3,5 x 2 e 6 m²". Decimal commas are accepted, and a
 * dimension in cm is converted to metres. A bare number in text is read as m².
 */
export function parseArea(input: number | string): ParsedArea {
  if (typeof input === 'number') {
    const units = toScaled(input, 4);
    if (units <= 0n) throw new CalculatorInputError('The area must be greater than zero');
    return { areaM2: fromScaled(units, AREA_SCALE), rooms: [], directM2: [input] };
  }

  const text = input.toLowerCase();
  const rooms: Room[] = [];
  let total = 0n;
  let perimeter = 0n;

  const rest = text.replace(DIMENSIONS, (_m, a: string, ua?: string, b?: string, ub?: string) => {
    // A unit written once applies to both sides: "400 x 500 cm".
    const unitA = ua ?? ub;
    const unitB = ub ?? ua;
    const w = toMetresScaled(a, unitA);
    const l = toMetresScaled(b!, unitB);
    const area = divRound(w * l, AREA_SCALE);
    rooms.push({
      widthM: fromScaled(w, AREA_SCALE),
      lengthM: fromScaled(l, AREA_SCALE),
      areaM2: fromScaled(area, AREA_SCALE),
    });
    total += area;
    perimeter += 2n * (w + l);
    return ' ';
  });

  const directM2: number[] = [];
  let leftover = rest.replace(SQUARE_METRES, (_m, a: string) => {
    const area = toScaled(a, 4);
    directM2.push(fromScaled(area, AREA_SCALE));
    total += area;
    return ' ';
  });

  // A lone number with nothing else ("35") is m².
  if (rooms.length === 0 && directM2.length === 0) {
    const bare = new RegExp(String.raw`^\s*${NUM}\s*$`).exec(leftover);
    if (bare) {
      const area = toScaled(bare[1]!, 4);
      directM2.push(fromScaled(area, AREA_SCALE));
      total += area;
      leftover = '';
    }
  }

  if (/\d/.test(leftover)) {
    throw new CalculatorInputError(
      `Could not read the area from "${input}". Use m² or room dimensions such as "4 x 5".`,
    );
  }
  if (total <= 0n) {
    throw new CalculatorInputError(`No area found in "${input}"`);
  }

  return {
    areaM2: fromScaled(total, AREA_SCALE),
    rooms,
    directM2,
    perimeterM:
      rooms.length > 0 && directM2.length === 0 ? fromScaled(perimeter, AREA_SCALE) : undefined,
  };
}

function toMetresScaled(value: string, unit: string | undefined): bigint {
  const scaled = toScaled(value, 4);
  return unit === 'cm' ? divRound(scaled, 100n) : scaled;
}

// ---------------------------------------------------------------------------------------------
// Product kind

/** Guesses the kind of product from its Shopify product type and title, for accessory hints. */
export function productKind(...texts: (string | null | undefined)[]): ProductKind {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/\bdeck|\bwpc\b/.test(t)) return 'decking';
  if (/vin[ií]l|\bspc\b|\blvt\b|vinyl/.test(t)) return 'vinyl';
  if (/lamin/.test(t)) return 'laminate';
  if (/madeira|wood|parqu|soalho|multicamada|flutuante|carvalho|oak/.test(t)) return 'wood';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// Quantity

export interface AccessoryHint {
  kind: 'underlay' | 'skirting' | 'transition_profiles' | 'clips_and_screws' | 'joists';
  /** Quantity to suggest, or null when it depends on something we do not know. */
  quantity: number | null;
  unit: 'm2' | 'm' | 'units' | null;
  note: string;
}

export interface QuantityInput {
  areaM2: number;
  m2PerBox: number | string;
  /** VAT-included price, per box or per m² according to `priceUnit`. */
  unitPrice: number | string;
  priceUnit: PriceUnit;
  layout?: Layout;
  /** Waste margin as a fraction (0.07 = 7%). Defaults to 7%, or 10% for diagonal laying. */
  waste?: number;
  /** Room perimeter in metres, for skirting. */
  perimeterM?: number;
  /** Shopify product type (or type + title); picks the accessory hints. */
  productType?: string | null;
}

export interface QuantityResult {
  areaM2: number;
  /** Waste margin used, as a fraction. */
  waste: number;
  /** Area including waste, before rounding up to whole boxes. */
  requiredM2: number;
  boxes: number;
  m2PerBox: number;
  /** Area the boxes cover: boxes × m² per box. */
  coveredM2: number;
  priceUnit: PriceUnit;
  /** Price per box and per m², VAT included, in euros. */
  boxPrice: number;
  m2Price: number;
  /** VAT-included total in euros, and in cents for exact comparisons. */
  totalPrice: number;
  totalCents: number;
  kind: ProductKind;
  accessories: AccessoryHint[];
}

export function calculateQuantity(input: QuantityInput): QuantityResult {
  const areaU = toScaled(input.areaM2, 4);
  const boxU = toScaled(input.m2PerBox, 4);
  const unitCents = toScaled(input.unitPrice, 2);
  const wasteFraction =
    input.waste ?? (input.layout === 'diagonal' ? DIAGONAL_WASTE : DEFAULT_WASTE);
  const wasteBp = toScaled(wasteFraction, 4);

  if (areaU <= 0n) throw new CalculatorInputError('The area must be greater than zero');
  if (boxU <= 0n) throw new CalculatorInputError('m² per box must be greater than zero');
  if (unitCents < 0n) throw new CalculatorInputError('The price cannot be negative');
  if (wasteBp < 0n || wasteBp >= WASTE_SCALE) {
    throw new CalculatorInputError('The waste margin must be between 0% and 100%');
  }

  // area × (1 + waste), kept at full precision (1e-8 m²) until the box count is rounded up.
  const requiredFine = areaU * (WASTE_SCALE + wasteBp);
  const boxes = divCeil(requiredFine, boxU * WASTE_SCALE);
  const coveredU = boxes * boxU;

  let boxCents: bigint;
  let m2Cents: bigint;
  let totalCents: bigint;
  if (input.priceUnit === 'box') {
    boxCents = unitCents;
    m2Cents = divRound(unitCents * AREA_SCALE, boxU);
    totalCents = boxes * unitCents;
  } else {
    m2Cents = unitCents;
    boxCents = divRound(boxU * unitCents, AREA_SCALE);
    // Sold by m² but delivered in whole boxes: the customer pays for the area the boxes cover.
    totalCents = divRound(coveredU * unitCents, AREA_SCALE);
  }

  const kind = productKind(input.productType);
  return {
    areaM2: fromScaled(areaU, AREA_SCALE),
    waste: fromScaled(wasteBp, WASTE_SCALE),
    requiredM2: fromScaled(divRound(requiredFine, WASTE_SCALE * 100n), 100n),
    boxes: Number(boxes),
    m2PerBox: fromScaled(boxU, AREA_SCALE),
    coveredM2: fromScaled(coveredU, AREA_SCALE),
    priceUnit: input.priceUnit,
    boxPrice: fromScaled(boxCents, 100n),
    m2Price: fromScaled(m2Cents, 100n),
    totalPrice: fromScaled(totalCents, 100n),
    totalCents: Number(totalCents),
    kind,
    accessories: accessoryHints(kind, areaU, input.perimeterM),
  };
}

/** Accessory suggestions with quantities. They are hints for the agent, not catalogue products. */
export function accessoryHints(
  kind: ProductKind,
  areaU: bigint,
  perimeterM?: number,
): AccessoryHint[] {
  const area = fromScaled(divCeil(areaU, AREA_SCALE / 100n), 100n);
  const hints: AccessoryHint[] = [];

  if (kind === 'laminate' || kind === 'vinyl' || kind === 'wood') {
    hints.push({
      kind: 'underlay',
      quantity: area,
      unit: 'm2',
      note:
        kind === 'vinyl'
          ? 'Underlay for the floor area, unless the vinyl has one built in.'
          : 'Underlay (sub-floor foam) for the floor area.',
    });
    if (perimeterM !== undefined && perimeterM > 0) {
      // Perimeter + 5% for cuts, rounded up to whole metres.
      const perimeterU = toScaled(perimeterM, 4);
      const metres = divCeil(perimeterU * 105n, AREA_SCALE * 100n);
      hints.push({
        kind: 'skirting',
        quantity: Number(metres),
        unit: 'm',
        note: 'Skirting for the room perimeter plus 5% for cuts; subtract door openings.',
      });
    } else {
      hints.push({
        kind: 'skirting',
        quantity: null,
        unit: 'm',
        note: 'Skirting: ask for the room perimeter to work out the metres.',
      });
    }
    hints.push({
      kind: 'transition_profiles',
      quantity: null,
      unit: 'units',
      note: 'One transition or threshold profile per doorway or change of floor.',
    });
  } else if (kind === 'decking') {
    // Typical figures for boards on joists about 40 cm apart; the product sheet has the exact ones.
    hints.push({
      kind: 'clips_and_screws',
      quantity: Number(divCeil(areaU * 25n, AREA_SCALE)),
      unit: 'units',
      note: 'About 25 clips (with screws) per m²; check the product sheet.',
    });
    hints.push({
      kind: 'joists',
      quantity: Number(divCeil(areaU * 3n, AREA_SCALE)),
      unit: 'm',
      note: 'About 3 m of joist per m² with joists 35–40 cm apart; check the product sheet.',
    });
  }
  return hints;
}
