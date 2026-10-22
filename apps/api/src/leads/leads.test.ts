import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadClients } from '../clients/registry.js';
import { BackgroundTasks } from '../services/background.js';
import { testDb } from '../test/catalogue.js';
import { testClient } from '../test/helpers.js';
import { routeBranch } from './routing.js';
import { GoogleSheetsLeadSink, leadRow, SHEET_COLUMNS } from './sheets.js';
import { LeadSinks, type LeadRecord, type LeadSink } from './sink.js';

const jular = loadClients(new URL('../../../../clients', import.meta.url).pathname).get('jular')!;

describe('routeBranch', () => {
  it('routes decking in Faro to Albufeira, ignoring case and accents', () => {
    expect(routeBranch(jular, { location: 'Faro' }).id).toBe('albufeira');
    expect(
      routeBranch(jular, { location: 'Loulé, FARO', business_line: 'madeiras-revestimentos' }).id,
    ).toBe('albufeira');
    expect(routeBranch(jular, { location: 'braganca' }).id).toBe('maia');
    expect(routeBranch(jular, { location: 'Viana do Castelo' }).id).toBe('maia');
  });

  it('puts business line rules first', () => {
    expect(routeBranch(jular, { location: 'Faro', business_line: 'casas-modulares' }).id).toBe(
      'azambuja',
    );
    expect(routeBranch(jular, { business_line: 'engenharia-estruturas' }).id).toBe('azambuja');
  });

  it('falls back to the default branch', () => {
    expect(routeBranch(jular, { location: 'Lisboa' }).id).toBe('camarate');
    expect(routeBranch(jular, { location: 'Paris' }).id).toBe('camarate');
    expect(routeBranch(jular, {}).id).toBe('camarate');
    // A region is matched as a whole word, not inside another name.
    expect(routeBranch(jular, { location: 'Farol' }).id).toBe('camarate');
  });
});

const sheetsClient = testClient({
  lead: {
    request_types: ['quote'],
    required_fields: [],
    response_time: 'um dia útil',
    sinks: ['db', 'sheets'],
    sheets: { spreadsheet_id: 'sheet-123', sheet_name: "Leads d'Acme" },
  },
});

function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date('2026-10-20T14:05:00Z'),
    client: sheetsClient,
    contact: { name: 'Ana', waId: '351911111111' },
    type: 'quote',
    branchId: 'lisboa',
    fields: {
      request_type: 'quote',
      name: 'Ana Silva',
      location: 'Faro',
      products: 'Deck de pinho',
      area_m2: 120,
      summary: 'Quer orçamento para 120 m² de deck.',
      timeline: 'março',
      attachments: [{ type: 'image', message_id: 'wamid.1' }],
    },
    ...overrides,
  };
}

describe('GoogleSheetsLeadSink', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'leads@acme-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
  };

  function fakeGoogle(appendStatus = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === account.token_uri) {
        return Response.json({ access_token: 'ya29.test-token', expires_in: 3600 });
      }
      return new Response('{}', { status: appendStatus });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it('signs a service account JWT and appends one RAW row with every field', async () => {
    const google = fakeGoogle();
    const sink = new GoogleSheetsLeadSink(account, google.fetchFn, () =>
      Date.parse('2026-10-20T14:05:00Z'),
    );
    await sink.write(lead());
    await sink.write(lead());

    // One token for both rows.
    const tokenCalls = google.calls.filter((c) => c.url === account.token_uri);
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(String(tokenCalls[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: account.token_uri,
      exp: Date.parse('2026-10-20T15:05:00Z') / 1000,
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(valid).toBe(true);

    const append = google.calls.find((c) => c.url.includes('sheets.googleapis.com'))!;
    expect(append.url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/${encodeURIComponent("'Leads d''Acme'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    );
    expect(new Headers(append.init.headers).get('authorization')).toBe('Bearer ya29.test-token');
    const { values } = JSON.parse(String(append.init.body)) as { values: string[][] };
    expect(values[0]).toHaveLength(SHEET_COLUMNS.length);
    expect(values[0]).toEqual([
      '2026-10-20 15:05',
      '11111111-1111-1111-1111-111111111111',
      'quote',
      'Lisboa',
      'Ana Silva',
      '+351911111111',
      '',
      'Faro',
      '',
      'Deck de pinho',
      '120',
      'março',
      'Quer orçamento para 120 m² de deck.',
      'https://wa.me/351911111111',
      JSON.stringify({ attachments: [{ type: 'image', message_id: 'wamid.1' }] }),
    ]);
  });

  it('throws when the append fails, so the background task retries it', async () => {
    const sink = new GoogleSheetsLeadSink(account, fakeGoogle(403).fetchFn);
    await expect(sink.write(lead())).rejects.toThrow(/403/);
  });

  it('keeps customer text as plain values', () => {
    const row = leadRow(lead({ fields: { name: '=HYPERLINK("x")', summary: 's' } }));
    expect(row[4]).toBe('=HYPERLINK("x")');
  });
});

describe('LeadSinks', () => {
  it('writes the database first and the other sinks in the background, with retries', async () => {
    const handle = await testDb();
    let attempts = 0;
    const written: LeadRecord[] = [];
    const flakySheets: LeadSink = {
      name: 'sheets',
      async write(record) {
        attempts += 1;
        if (attempts === 1) throw new Error('sheets down');
        written.push(record);
      },
    };
    const sinks = new LeadSinks({
      db: handle.db,
      sinks: [flakySheets],
      background: new BackgroundTasks([0]),
    });
    const row = await sinks.save({
      client: sheetsClient,
      contact: { name: 'Ana', waId: '351911111111' },
      type: 'quote',
      branchId: 'lisboa',
      fields: { summary: 'x' },
    });
    expect(row.type).toBe('quote');
    await sinks.flush();
    expect(attempts).toBe(2);
    expect(written[0]?.id).toBe(row.id);
    await handle.close();
  });
});
