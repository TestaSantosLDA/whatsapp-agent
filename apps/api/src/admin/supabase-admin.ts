/**
 * The bit of the Supabase Auth Admin API the dashboard uses: inviting a team member. Sign-ups are
 * disabled on the project, so an invite (or an existing account) is the only way in.
 */
import type { InviteStatus } from '@wa/shared';

export interface InviteRequest {
  email: string;
  /** Where the invite link lands: the dashboard, `<PUBLIC_BASE_URL>/admin/`. */
  redirectTo: string;
  /** Stored on the Supabase user as user_metadata. Informational only: roles live in our DB. */
  data?: Record<string, unknown>;
}

export interface SupabaseAdmin {
  /** Sends Supabase's invite email. Throws when Supabase refuses for another reason. */
  invite(request: InviteRequest): Promise<Exclude<InviteStatus, 'not_configured'>>;
}

export class SupabaseAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SupabaseAdminError';
  }
}

/** POST <SUPABASE_URL>/auth/v1/invite with the service role key. */
export class SupabaseAdminApi implements SupabaseAdmin {
  constructor(
    private readonly opts: {
      supabaseUrl: string;
      serviceRoleKey: string;
      fetch?: typeof fetch;
    },
  ) {}

  async invite({ email, redirectTo, data }: InviteRequest) {
    const url = new URL(`${this.opts.supabaseUrl}/auth/v1/invite`);
    url.searchParams.set('redirect_to', redirectTo);
    const res = await (this.opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, data: data ?? {} }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'sent' as const;
    const detail = await res.text().catch(() => '');
    // Already a Supabase user (e.g. on another client's team): they sign in with a magic link
    // or Google straight away, no invite needed.
    if (
      res.status === 422 &&
      /already (been )?registered|email_exists|user_already_exists/i.test(detail)
    ) {
      return 'already_registered' as const;
    }
    throw new SupabaseAdminError(
      `Supabase invite answered ${res.status}: ${detail.slice(0, 300)}`,
      res.status,
    );
  }
}
