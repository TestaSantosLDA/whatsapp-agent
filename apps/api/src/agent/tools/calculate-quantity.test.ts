import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from '../../db/index.js';
import { contacts, conversations, products } from '../../db/schema.js';
import { testClient } from '../../test/helpers.js';
import { ToolError, type ToolContext } from '../tool.js';
import { calculateQuantityTool } from './calculate-quantity.js';

let handle: DbHandle;
let ctx: ToolContext;

const product = (overrides: Partial<typeof products.$inferInsert> = {}) => ({
  clientId: 'acme',
  productId: 'p1',
  variantId: 'v1',
  sku: 'LAM-01',
  title: 'Laminado Carvalho Natural',
  productType: 'Pavimento Laminado',
  price: '39.90',
  available: true,
  url: 'https://shop.test/products/laminado',
  extra: { m2_per_box: 2.22 },
  ...overrides,
});

beforeEach(async () => {
  handle = openDb({ pgliteDir: 'memory' });
  await handle.migrate();
  const [contact] = await handle.db
    .insert(contacts)
    .values({ clientId: 'acme', waId: '351910000000' })
    .returning();
  const [conversation] = await handle.db
    .insert(conversations)
    .values({ clientId: 'acme', contactId: contact!.id })
    .returning();
  await handle.db.insert(products).values([
    product(),
    product({
      variantId: 'v2',
      sku: 'VIN-01',
      price: '17.95',
      extra: { m2_per_box: '2,22', price_unit: 'm2' },
    }),
    product({ variantId: 'v3', sku: 'DECK-01', productType: 'Deck', extra: {} }),
    product({ variantId: 'v4', sku: 'CFG-01', extra: {} }),
    product({ clientId: 'other', variantId: 'v5' }),
  ]);
  ctx = {
    db: handle.db,
    client: testClient({ product_data: { 'CFG-01': { m2_per_box: 1.5 } } }),
    conversation: conversation!,
    contact: contact!,
    outbox: [],
  };
});

afterEach(() => handle.close());

const run = (input: Record<string, unknown>) =>
  calculateQuantityTool.run(calculateQuantityTool.inputSchema.parse(input), ctx);

async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ToolError);
  return err as ToolError;
}

describe('calculate_quantity', () => {
  it('works out boxes, price and accessories for an area', async () => {
    const result = await run({ variant_id: 'v1', area_m2: 35 });
    expect(result).toMatchObject({
      product: { variant_id: 'v1', title: 'Laminado Carvalho Natural', available: true },
      area_m2: 35,
      waste_percent: 7,
      boxes: 17,
      covered_m2: 37.74,
      price_unit: 'box',
      price_per_box: 39.9,
      total_price: 678.3,
      currency: 'EUR',
      vat_included: true,
    });
  });

  it('reads room dimensions and derives the perimeter for skirting', async () => {
    const result = (await run({ variant_id: 'v1', rooms: '4 x 5 m', layout: 'diagonal' })) as {
      area_m2: number;
      waste_percent: number;
      boxes: number;
      perimeter_m: number;
      accessories: { kind: string; quantity: number | null }[];
    };
    expect(result.area_m2).toBe(20);
    expect(result.waste_percent).toBe(10);
    expect(result.boxes).toBe(10); // 22 / 2.22 = 9.9
    expect(result.perimeter_m).toBe(18);
    expect(result.accessories.find((a) => a.kind === 'skirting')?.quantity).toBe(19);
  });

  it('prices per m² when the product says so', async () => {
    const result = await run({ variant_id: 'v2', area_m2: 35 });
    expect(result).toMatchObject({ boxes: 17, price_unit: 'm2', total_price: 677.43 });
  });

  it('falls back to product_data in the client config by SKU', async () => {
    const result = await run({ variant_id: 'v4', area_m2: 10, waste_percent: 0 });
    expect(result).toMatchObject({ m2_per_box: 1.5, boxes: 7, waste_percent: 0 });
  });

  it('returns missing_data instead of guessing when there is no m² per box', async () => {
    const err = await toolError(run({ variant_id: 'v3', area_m2: 35 }));
    expect(err.code).toBe('missing_data');
    expect(err.message).toMatch(/do not estimate or guess/i);
    expect(err.message).toMatch(/colleague/);
  });

  it('returns not_found for an unknown variant or one of another client', async () => {
    expect((await toolError(run({ variant_id: 'nope', area_m2: 35 }))).code).toBe('not_found');
    expect((await toolError(run({ variant_id: 'v5', area_m2: 35 }))).code).toBe('not_found');
  });

  it('needs exactly one of area_m2 and rooms, and readable rooms', async () => {
    expect((await toolError(run({ variant_id: 'v1' }))).code).toBe('invalid_input');
    expect((await toolError(run({ variant_id: 'v1', area_m2: 3, rooms: '2x2' }))).code).toBe(
      'invalid_input',
    );
    expect((await toolError(run({ variant_id: 'v1', rooms: 'grande' }))).code).toBe(
      'invalid_input',
    );
  });
});
