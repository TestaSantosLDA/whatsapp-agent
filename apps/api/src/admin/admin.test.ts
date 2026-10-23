import { randomUUID } from 'node:crypto';
import type {
  AdminConfig,
  AdminContextView,
  AdminMe,
  AdminMember,
  AdminSettingsView,
  DevLoginMember,
  InviteResult,
} from '@wa/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientSettings, leads, teamMembers } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { adminTestApp, signToken, testKeys } from '../test/admin.js';
import { SECRET, testApp, testClient } from '../test/helpers.js';
import { branchFilter, type AdminContext } from './context.js';
import { SupabaseAdminApi } from './supabase-admin.js';

const acme = testClient({
  branches: [
    {
      ...testClient().branches[0]!,
      id: 'lisboa',
      name: 'Lisboa',
      lead_emails: ['l@example.invalid'],
    },
    { ...testClient().branches[0]!, id: 'porto', name: 'Porto', region: 'Norte' },
  ],
});
const beta = testClient({
  id: 'beta',
  name: 'Beta Lda',
  channel: { type: 'simulator', phone_number_id: 'beta-phone', display_phone_number: '+351 1' },
});

type T = Awaited<ReturnType<typeof testApp>>;
let current: T | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  vi.restoreAllMocks();
});
async function setup(opts: Parameters<typeof adminTestApp>[0] = {}) {
  const t = await adminTestApp({ clients: [acme, beta], ...opts });
  current = t;
  return t;
}

describe('admin API authentication', () => {
  it('answers 401 without a token or with an invalid one', async () => {
    const t = await setup();
    for (const path of ['/api/admin/me', '/api/admin/clients/acme/team', '/api/admin/nope']) {
      const res = await t.call(path, undefined);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'missing_token' });
    }
    expect((await t.call('/api/admin/me', 'garbage')).status).toBe(401);
    const expired = await signToken(t.keys, { id: randomUUID() }, {}, { expiresIn: 1 });
    vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });
    try {
      const res = await t.call('/api/admin/me', expired);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'expired_token' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 when no sign-in is configured', async () => {
    current = await testApp();
    const res = await current.app.request('/api/admin/me', {
      headers: { authorization: 'Bearer x.y.z' },
    });
    expect(res.status).toBe(401);
    const token = await signToken(await testKeys(), { id: randomUUID() });
    expect(
      (
        await current.app.request('/api/admin/me', {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(503);
  });

  it('links an invite to the Supabase user on first sign-in and lists memberships', async () => {
    const t = await setup();
    const { token, userId } = await t.member('acme', {
      email: 'ana@example.invalid',
      role: 'admin',
    });
    await t.member('beta', { email: 'ana@example.invalid', role: 'sales', branches: ['lisboa'] });

    const me = (await (await t.call('/api/admin/me', token)).json()) as AdminMe;
    expect(me.user).toEqual({ id: userId, email: 'ana@example.invalid' });
    expect(me.memberships.map((m) => [m.clientId, m.role]).sort()).toEqual([
      ['acme', 'admin'],
      ['beta', 'sales'],
    ]);
    const rows = await t.db.select().from(teamMembers);
    expect(rows.every((r) => r.userId === userId && r.lastLoginAt)).toBe(true);

    // Another Supabase user with the same email cannot take the linked rows over.
    const other = await signToken(t.keys, { id: randomUUID(), email: 'ana@example.invalid' });
    expect(((await (await t.call('/api/admin/me', other)).json()) as AdminMe).memberships).toEqual(
      [],
    );
    expect((await t.call('/api/admin/clients/acme/context', other)).status).toBe(403);
  });

  it('answers 403 to non-members and to members of another client', async () => {
    const t = await setup();
    const stranger = await signToken(t.keys, { id: randomUUID(), email: 'x@example.invalid' });
    expect((await t.call('/api/admin/clients/acme/context', stranger)).status).toBe(403);
    const { token } = await t.member('beta', { email: 'b@example.invalid', role: 'admin' });
    const res = await t.call('/api/admin/clients/acme/team', token);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not_a_member' });
    expect((await t.call('/api/admin/clients/unknown/context', token)).status).toBe(403);
    expect((await t.call('/api/admin/clients/beta/context', token)).status).toBe(200);
  });
});

describe('member scoping', () => {
  it('gives admins every branch and sales members their own', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const sales = await t.member('acme', {
      email: 's@example.invalid',
      role: 'sales',
      branches: ['porto'],
    });
    const ctxOf = async (token: string) =>
      (await (await t.call('/api/admin/clients/acme/context', token)).json()) as AdminContextView;
    expect((await ctxOf(admin.token)).branches.map((b) => b.id)).toEqual(['lisboa', 'porto']);
    const salesCtx = await ctxOf(sales.token);
    expect(salesCtx.role).toBe('sales');
    expect(salesCtx.branches.map((b) => b.id)).toEqual(['porto']);
    expect(salesCtx.allBranches).toHaveLength(2);
    expect(salesCtx.member).toMatchObject({ email: 's@example.invalid', status: 'active' });

    // Admin-only routes.
    expect((await t.call('/api/admin/clients/acme/settings', sales.token)).status).toBe(403);
    const patch = await t.call(`/api/admin/clients/acme/team/${admin.row.id}`, sales.token, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'sales' }),
    });
    expect(patch.status).toBe(403);
    expect(await patch.json()).toMatchObject({ error: 'admin_only' });
    expect((await t.call('/api/admin/clients/acme/team', sales.token)).status).toBe(200);
  });

  it('branchFilter limits a query to the sales member’s branches', async () => {
    const t = await setup();
    await t.db.insert(leads).values([
      { clientId: 'acme', type: 'quote', branchId: 'lisboa' },
      { clientId: 'acme', type: 'quote', branchId: 'porto' },
      { clientId: 'acme', type: 'info', branchId: null },
    ]);
    const ctx = (role: 'admin' | 'sales', branchIds: string[]) =>
      ({ role, branchIds }) as unknown as AdminContext;
    const query = (c: AdminContext) =>
      t.db
        .select({ branchId: leads.branchId })
        .from(leads)
        .where(and(eq(leads.clientId, 'acme'), branchFilter(c, leads.branchId)));
    expect(await query(ctx('admin', ['lisboa', 'porto']))).toHaveLength(3);
    expect(await query(ctx('sales', ['porto']))).toEqual([{ branchId: 'porto' }]);
    expect(await query(ctx('sales', []))).toEqual([]);
  });
});

describe('team management', () => {
  function fakeSupabase(status = 200, body: unknown = {}) {
    const calls: { url: URL; headers: Headers; body: unknown }[] = [];
    const api = new SupabaseAdminApi({
      supabaseUrl: 'https://testproject.supabase.co',
      serviceRoleKey: 'service-role-key',
      fetch: async (input, init) => {
        calls.push({
          url: new URL(String(input)),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(body, { status });
      },
    });
    return { api, calls };
  }

  it('invites a member through Supabase; they sign in and see their branches', async () => {
    const supabase = fakeSupabase();
    const t = await setup({ supabaseAdmin: supabase.api });
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });

    const res = await t.call('/api/admin/clients/acme/team', admin.token, {
      method: 'POST',
      body: JSON.stringify({
        email: 'Rui@Example.invalid',
        name: 'Rui',
        role: 'sales',
        branches: ['porto'],
      }),
    });
    expect(res.status).toBe(201);
    const result = (await res.json()) as InviteResult;
    expect(result.invite).toBe('sent');
    expect(result.member).toMatchObject({ email: 'rui@example.invalid', status: 'invited' });

    const [call] = supabase.calls;
    expect(call!.url.origin + call!.url.pathname).toBe(
      'https://testproject.supabase.co/auth/v1/invite',
    );
    expect(call!.url.searchParams.get('redirect_to')).toBe('http://test.local/admin/');
    expect(call!.headers.get('apikey')).toBe('service-role-key');
    expect(call!.headers.get('authorization')).toBe('Bearer service-role-key');
    expect(call!.body).toMatchObject({ email: 'rui@example.invalid' });

    // Rui follows the link: Supabase issues a token for his new user.
    const rui = await signToken(t.keys, { id: randomUUID(), email: 'rui@example.invalid' });
    const ctx = (await (
      await t.call('/api/admin/clients/acme/context', rui)
    ).json()) as AdminContextView;
    expect(ctx.branches.map((b) => b.id)).toEqual(['porto']);
    const list = (await (
      await t.call('/api/admin/clients/acme/team', admin.token)
    ).json()) as AdminMember[];
    expect(list.find((m) => m.email === 'rui@example.invalid')?.status).toBe('active');

    const again = await t.call('/api/admin/clients/acme/team', admin.token, {
      method: 'POST',
      body: JSON.stringify({ email: 'rui@example.invalid', role: 'sales', branches: ['porto'] }),
    });
    expect(again.status).toBe(409);
  });

  it('accepts users Supabase already has, and rolls back when the invite fails', async () => {
    const existing = fakeSupabase(422, {
      code: 422,
      error_code: 'email_exists',
      msg: 'A user with this email address has already been registered',
    });
    const t = await setup({ supabaseAdmin: existing.api });
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const ok = await t.call('/api/admin/clients/acme/team', admin.token, {
      method: 'POST',
      body: JSON.stringify({ email: 'old@example.invalid', role: 'admin' }),
    });
    expect(((await ok.json()) as InviteResult).invite).toBe('already_registered');
    await t.close();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = fakeSupabase(500, { msg: 'boom' });
    const t2 = await setup({ supabaseAdmin: down.api });
    const admin2 = await t2.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const failed = await t2.call('/api/admin/clients/acme/team', admin2.token, {
      method: 'POST',
      body: JSON.stringify({ email: 'new@example.invalid', role: 'admin' }),
    });
    expect(failed.status).toBe(502);
    const rows = await t2.db.select().from(teamMembers);
    expect(rows.map((r) => r.email)).toEqual(['a@example.invalid']);
  });

  it('adds members without an email when Supabase invites are not configured', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const res = await t.call('/api/admin/clients/acme/team', admin.token, {
      method: 'POST',
      body: JSON.stringify({ email: 'n@example.invalid', role: 'sales', branches: ['lisboa'] }),
    });
    expect(((await res.json()) as InviteResult).invite).toBe('not_configured');
  });

  it('validates branches, changes roles and keeps at least one admin', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const sales = await t.member('acme', {
      email: 's@example.invalid',
      role: 'sales',
      branches: ['lisboa'],
    });
    const path = (id: string) => `/api/admin/clients/acme/team/${id}`;
    const patch = (id: string, body: unknown) =>
      t.call(path(id), admin.token, { method: 'PATCH', body: JSON.stringify(body) });

    expect((await patch(sales.row.id, { branches: ['faro'] })).status).toBe(400);
    expect((await patch(sales.row.id, { branches: [] })).status).toBe(400);
    expect(await (await patch(sales.row.id, { branches: ['porto'] })).json()).toMatchObject({
      branches: ['porto'],
    });
    expect((await patch(admin.row.id, { role: 'sales', branches: ['lisboa'] })).status).toBe(409);
    expect((await t.call(path(admin.row.id), admin.token, { method: 'DELETE' })).status).toBe(409);

    // Promote, then the first admin may step down, and the removed member loses access.
    expect((await patch(sales.row.id, { role: 'admin' })).status).toBe(200);
    expect((await t.call(path(sales.row.id), admin.token, { method: 'DELETE' })).status).toBe(204);
    expect((await t.call('/api/admin/clients/acme/context', sales.token)).status).toBe(403);
    expect((await t.call(path(randomUUID()), admin.token, { method: 'DELETE' })).status).toBe(404);

    // Never another client's member.
    const other = await t.member('beta', { email: 'z@example.invalid', role: 'admin' });
    expect((await patch(other.row.id, { name: 'X' })).status).toBe(404);
  });
});

describe('settings', () => {
  it('stores only what differs from the file and applies it at once', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const url = '/api/admin/clients/acme/settings';
    const view = (await (await t.call(url, admin.token)).json()) as AdminSettingsView;
    expect(view.overridden).toEqual([]);
    expect(view.settings.branches.map((b) => b.id)).toEqual(['lisboa', 'porto']);

    const edited = structuredClone(view.settings);
    edited.branches[1]!.lead_emails = ['porto@example.invalid', 'chefe@example.invalid'];
    edited.branches[1]!.hours = { ...edited.branches[1]!.hours, sat: ['10:00-13:00'] };
    edited.response_time = 'duas horas úteis';
    const saved = await t.call(url, admin.token, { method: 'PUT', body: JSON.stringify(edited) });
    expect(saved.status).toBe(200);
    const after = (await saved.json()) as AdminSettingsView;
    expect(after.overridden.sort()).toEqual([
      'branches.porto.hours',
      'branches.porto.lead_emails',
      'response_time',
    ]);
    expect(after.updatedBy).toBe('a@example.invalid');
    const [row] = await t.db.select().from(clientSettings);
    expect(row!.overrides).toEqual({
      response_time: 'duas horas úteis',
      branches: {
        porto: {
          lead_emails: ['porto@example.invalid', 'chefe@example.invalid'],
          hours: { mon: ['09:00-18:00'], sat: ['10:00-13:00'] },
        },
      },
    });
    const merged = t.clients.get('acme')!;
    expect(merged.lead.response_time).toBe('duas horas úteis');
    expect(merged.branches[1]!.lead_emails).toEqual([
      'porto@example.invalid',
      'chefe@example.invalid',
    ]);
    expect(merged.branches[0]!.lead_emails).toEqual(['l@example.invalid']);
    expect(t.clients.fileConfig('acme')!.lead.response_time).toBe('um dia útil');

    const reset = await t.call(url, admin.token, { method: 'DELETE' });
    expect(((await reset.json()) as AdminSettingsView).overridden).toEqual([]);
    expect(t.clients.get('acme')!.lead.response_time).toBe('um dia útil');
  });

  it('rejects invalid emails, hours and branch lists', async () => {
    const t = await setup();
    const admin = await t.member('acme', { email: 'a@example.invalid', role: 'admin' });
    const url = '/api/admin/clients/acme/settings';
    const { settings } = (await (await t.call(url, admin.token)).json()) as AdminSettingsView;
    const put = (s: unknown) =>
      t.call(url, admin.token, { method: 'PUT', body: JSON.stringify(s) });

    const badEmail = structuredClone(settings);
    badEmail.branches[0]!.lead_emails = ['not an email'];
    expect((await put(badEmail)).status).toBe(400);
    const badHours = structuredClone(settings);
    badHours.branches[0]!.hours = { mon: ['18:00-09:00'] };
    const res = await put(badHours);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/after the start/);
    const missingBranch = { ...settings, branches: settings.branches.slice(0, 1) };
    expect((await put(missingBranch)).status).toBe(400);
    expect(await t.db.select().from(clientSettings)).toEqual([]);
  });

  it('loads saved settings when the service starts', async () => {
    const t = await setup();
    await t.db.insert(clientSettings).values({
      clientId: 'acme',
      overrides: { handoff: 'ignored', handoff_triggers: ['Pedidos de obra acima de 500 m²'] },
    });
    await t.db.insert(clientSettings).values({ clientId: 'gone', overrides: {} });
    await t.settings.loadAll();
    expect(t.clients.get('acme')!.handoff.triggers).toEqual(['Pedidos de obra acima de 500 m²']);
  });
});

describe('dev login', () => {
  it('signs in as a seeded member without Supabase', async () => {
    const t = await testApp({ clients: [acme], env: { ADMIN_DEV_LOGIN: 'true' } });
    current = t;
    await t.team.ensure('acme', [{ email: 'a@example.invalid', role: 'admin' }]);
    const config = await (await t.app.request('/admin/config')).json();
    expect(config).toEqual({ supabaseUrl: null, supabaseAnonKey: null, devLogin: true });

    const members = (await (
      await t.app.request('/api/admin/dev/members')
    ).json()) as DevLoginMember[];
    expect(members).toHaveLength(1);
    const login = await t.app.request('/api/admin/dev/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: members[0]!.id }),
    });
    const { access_token } = (await login.json()) as { access_token: string };
    const ctx = await t.app.request('/api/admin/clients/acme/context', {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(ctx.status).toBe(200);
  });

  it('is off by default and refused in production or on Cloud Run', async () => {
    const t = await testApp({ clients: [acme] });
    current = t;
    const config = (await (await t.app.request('/admin/config')).json()) as AdminConfig;
    expect(config.devLogin).toBe(false);
    expect((await t.app.request('/api/admin/dev/members')).status).toBe(401);

    const base = { SIMULATOR_WEBHOOK_SECRET: SECRET, ADMIN_DEV_LOGIN: 'true' };
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/ADMIN_DEV_LOGIN/);
    expect(() => loadEnv({ ...base, K_SERVICE: 'wa-demo' })).toThrow(/ADMIN_DEV_LOGIN/);
    expect(loadEnv(base).ADMIN_DEV_LOGIN).toBe(true);
  });
});
