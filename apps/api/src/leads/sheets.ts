import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { LeadRecord, LeadSink } from './sink.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** The parts of a Google service account key file we use. */
export const serviceAccountSchema = z.object({
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().default('https://oauth2.googleapis.com/token'),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** Parses GOOGLE_SERVICE_ACCOUNT_JSON (the key file's contents). */
export function parseServiceAccount(json: string): ServiceAccount {
  return serviceAccountSchema.parse(JSON.parse(json));
}

/** Column headers, in row order. Put them in the sheet's first row. */
export const SHEET_COLUMNS = [
  'Data',
  'ID',
  'Tipo',
  'Loja',
  'Nome',
  'Telefone',
  'Email',
  'Localidade',
  'Linha de negócio',
  'Produtos / projeto',
  'Área (m²)',
  'Prazo',
  'Resumo',
  'WhatsApp',
  'Outros dados',
] as const;

const COLUMN_FIELDS = [
  'name',
  'email',
  'location',
  'business_line',
  'products',
  'area_m2',
  'timeline',
  'summary',
];

/** One spreadsheet row for a lead, in SHEET_COLUMNS order. */
export function leadRow(lead: LeadRecord): string[] {
  const f = lead.fields;
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const rest = Object.fromEntries(
    Object.entries(f).filter(([k]) => !COLUMN_FIELDS.includes(k) && k !== 'request_type'),
  );
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: lead.client.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(lead.createdAt);
  return [
    date,
    lead.id,
    lead.type,
    lead.client.branches.find((b) => b.id === lead.branchId)?.name ?? lead.branchId,
    str(f.name ?? lead.contact.name),
    `+${lead.contact.waId}`,
    str(f.email),
    str(f.location),
    str(f.business_line),
    str(f.products),
    str(f.area_m2),
    str(f.timeline),
    str(f.summary),
    `https://wa.me/${lead.contact.waId}`,
    Object.keys(rest).length ? JSON.stringify(rest) : '',
  ];
}

/**
 * Appends each lead as a row of the client's Google Sheet (`lead.sheets` in config), through the
 * Sheets REST API with a service account: a JWT signed with the account's RSA key (RS256) is
 * exchanged for an access token, cached until shortly before it expires. The sheet must be
 * shared with the service account's email as an editor.
 */
export class GoogleSheetsLeadSink implements LeadSink {
  readonly name = 'sheets';
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async write(lead: LeadRecord): Promise<void> {
    const sheet = lead.client.lead.sheets;
    if (!sheet) throw new Error(`client "${lead.client.id}" has no lead.sheets config`);
    const range = encodeURIComponent(`'${sheet.sheet_name.replace(/'/g, "''")}'!A1`);
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheet_id)}` +
      // RAW: customer text is stored as typed, never parsed as a formula.
      `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ values: [leadRow(lead)] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 401) this.token = undefined;
      const detail = await res.text().catch(() => '');
      throw new Error(`Sheets append answered ${res.status}: ${detail.slice(0, 300)}`);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const res = await this.fetchFn(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(this.account, Math.floor(this.now() / 1000)),
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google token endpoint answered ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }
}

/** The service account's signed assertion for the OAuth JWT bearer grant. */
export function signJwt(account: ServiceAccount, nowSeconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email,
    scope: SCOPE,
    aud: account.token_uri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}
