import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CalculatorInputError,
  calculateQuantity,
  parseArea,
  toScaled,
  type ParsedArea,
  type PriceUnit,
} from '../../calculator/quantity.js';
import { products } from '../../db/schema.js';
import { defineTool, ToolError } from '../tool.js';

const inputSchema = z.object({
  variant_id: z
    .string()
    .min(1)
    .describe('The variant_id of the product, as returned by the product search or details tool.'),
  area_m2: z
    .number()
    .positive()
    .optional()
    .describe('Floor area in m², when the customer gave one. Give this or rooms, not both.'),
  rooms: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Room dimensions in metres exactly as the customer gave them, e.g. "4 x 5" or ' +
        '"4,5 x 3,2 + 3 x 3" for several rooms (they are summed). Give this or area_m2.',
    ),
  layout: z
    .enum(['straight', 'diagonal'])
    .optional()
    .describe('How the floor is laid. Diagonal laying uses a 10% waste margin instead of 7%.'),
  waste_percent: z
    .number()
    .min(0)
    .max(30)
    .optional()
    .describe('Override the waste margin, in percent. Only when the customer asks for one.'),
  perimeter_m: z
    .number()
    .positive()
    .optional()
    .describe('Room perimeter in metres, for skirting. Worked out from rooms when omitted.'),
});

export const calculateQuantityTool = defineTool({
  name: 'calculate_quantity',
  description:
    'Works out how many boxes of a flooring or decking product the customer needs for an area, ' +
    'what area they cover and the total price, plus accessory suggestions (underlay, skirting ' +
    'metres, profiles, clips, joists) with quantities. Use it whenever the customer asks how ' +
    'much to buy or how much a floor or deck will cost. This tool does the maths: never ' +
    'calculate boxes, areas or prices yourself, and quote its numbers as they are. Boxes are ' +
    'rounded up to whole boxes and include a waste margin (7% by default, 10% for diagonal ' +
    'laying). Prices are in euros and include VAT. Accessory quantities are estimates to ' +
    'mention, not products in the cart. If it fails with missing_data, do not guess a number: ' +
    'say you cannot calculate it here and offer to pass the customer to a colleague.',
  inputSchema,
  async run(input, ctx) {
    if ((input.area_m2 === undefined) === (input.rooms === undefined)) {
      throw new ToolError('invalid_input', 'Give exactly one of area_m2 or rooms.');
    }

    const [row] = await ctx.db
      .select()
      .from(products)
      .where(and(eq(products.clientId, ctx.client.id), eq(products.variantId, input.variant_id)))
      .limit(1);
    if (!row) {
      throw new ToolError(
        'not_found',
        `No product with variant_id "${input.variant_id}". Search the catalogue for the product first.`,
      );
    }

    // Catalogue sync merges client product_data into `extra`; fall back to the config by SKU in
    // case this row was synced before the data was added.
    const extra = {
      ...(row.sku ? ctx.client.product_data[row.sku] : undefined),
      ...(row.extra as Record<string, unknown>),
    };
    const m2PerBox = positiveNumber(extra.m2_per_box);
    if (m2PerBox === undefined) {
      throw new ToolError(
        'missing_data',
        `There is no m² per box figure for "${row.title}", so the quantity cannot be calculated. ` +
          'Do not estimate or guess a number of boxes or a price. Tell the customer you cannot ' +
          'work it out here and offer to pass them to a colleague who can.',
      );
    }
    const priceUnit: PriceUnit = extra.price_unit === 'm2' ? 'm2' : 'box';

    try {
      const area: ParsedArea = parseArea(input.area_m2 ?? input.rooms!);
      const result = calculateQuantity({
        areaM2: area.areaM2,
        m2PerBox,
        unitPrice: row.price,
        priceUnit,
        layout: input.layout,
        waste: input.waste_percent === undefined ? undefined : input.waste_percent / 100,
        perimeterM: input.perimeter_m ?? area.perimeterM,
        productType: [row.productType, row.title].filter(Boolean).join(' '),
      });
      return {
        product: {
          variant_id: row.variantId,
          title: row.variantTitle ? `${row.title} – ${row.variantTitle}` : row.title,
          url: row.url,
          available: row.available,
        },
        area_m2: result.areaM2,
        rooms: area.rooms.map((r) => ({
          width_m: r.widthM,
          length_m: r.lengthM,
          area_m2: r.areaM2,
        })),
        waste_percent: Number(toScaled(result.waste * 100, 2)) / 100,
        required_m2: result.requiredM2,
        boxes: result.boxes,
        m2_per_box: result.m2PerBox,
        covered_m2: result.coveredM2,
        price_unit: result.priceUnit,
        price_per_box: result.boxPrice,
        price_per_m2: result.m2Price,
        total_price: result.totalPrice,
        currency: 'EUR',
        vat_included: true,
        perimeter_m: input.perimeter_m ?? area.perimeterM ?? null,
        accessories: result.accessories,
      };
    } catch (err) {
      if (err instanceof CalculatorInputError) throw new ToolError('invalid_input', err.message);
      throw err;
    }
  },
});

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}
