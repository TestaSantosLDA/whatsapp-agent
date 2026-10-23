# WA-022: Team dashboard shell, login and settings

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M5        | WA-020     |     |

## Why

The client's team needs its own place to work: the simulator's back-office panel is a demo of the customer side, not a tool a salesperson can use every day.

## Scope

- Angular app at `/admin` on the same service and URL as the simulator (WA-020), mobile first: salespeople are in the warehouse or on site, not at a desk. pt-PT copy.
- **Team members** per client: name, email, role (`admin` or `sales`), branches they belong to. Admins invite and remove members.
- **Login** with Supabase Auth (decided 2026-10-23): email one-time link or code, plus "Sign in with Google". Invite only: admins invite members (Supabase invite), public sign-up is disabled. The API verifies the Supabase JWT on every admin call and maps the user to a team member; every call is scoped to the member's client, and sales members see their branches only. Members live in our own `team_members` table keyed by the Supabase user id, so roles and branches stay in our schema.
- **Settings** (admins): lead recipients per branch, response time, opening hours, handoff triggers. Stored in the database as overrides on top of `clients/<id>.yaml`, applied without a redeploy; the prompt cache is rebuilt when they change.
- Navigation for the M5 screens: Inbox, Leads, Customers, Knowledge, Overview, Settings.

## Acceptance criteria

- [ ] An invited member receives a link, logs in on a phone, and sees only their client's data (and only their branches as `sales`). Verified locally without Supabase: the invite call to Supabase (fake fetch), the first sign-in linking the invite, client scoping (403 for another client) and branch scoping for sales (tests), and the phone layout with the dev login (screenshots). Still to check end to end with a real Supabase project and inbox.
- [x] Changing a branch's lead recipients in Settings changes who receives the next lead, without a redeploy (test: Settings PUT, then the next `save_lead` emails the new recipients and the rebuilt system prompt carries the new response time).
- [x] Admin API routes reject requests without a valid session (tests: missing, malformed, expired, wrong issuer or audience, unknown key, anon role, unsigned → 401; not a member or another client → 403; sales on admin routes → 403).

## Out of scope

Microsoft sign-in, enforced two-factor login, billing, multi-client admin for the service owner.

## Notes

- Supabase Auth: free up to 50k monthly users. Setup: enable the email and Google providers, disable sign-ups, set the site URL to the Cloud Run URL plus `/admin`; add it to docs/deploy.md. Local development and tests verify JWTs with a test signing key, so the in-memory database (PGlite) keeps working without Supabase running.
- Demo seed: one admin and one salesperson per branch with `example.invalid` addresses; with `MAIL_REDIRECT_TO` set (WA-015) the login links reach the demo inbox.

## Implementation (2026-10-23)

- **Where:** a second Angular app, `apps/admin` (standalone, zoneless, signals), built with `baseHref: /admin/` and served by the API at `/admin` with an SPA fallback (`serveAdmin` in `routes/spa.ts`); the simulator stays at `/` and never answers below `/admin`. Colours and font are shared with the simulator through `packages/shared/styles/tokens.css`. Bottom tab bar on phones, side bar from 900 px. Inbox, Leads, Customers, Knowledge and Overview are placeholders for their tickets; Settings has "Atendimento e filiais" and "Equipa".
- **Sign-in:** `@supabase/supabase-js` in the browser (PKCE; magic link with `shouldCreateUser: false`, the 6-digit code from the same email, Google), loaded lazily. `GET /admin/config` gives the browser `SUPABASE_URL` and the anon key, so the build has no settings baked in.
- **API auth:** `/api/admin/*`. Tokens verified with `jose`: asymmetric keys from the project's JWKS (cached 10 min, refetched for unknown keys at most every 30 s) or the legacy HS256 `SUPABASE_JWT_SECRET`; issuer `<SUPABASE_URL>/auth/v1`, audience and role `authenticated`. `sub` maps to `team_members.user_id`; a row with no user id yet (an invite) is linked by email on the first sign-in. Feature routes get an `AdminContext` and helpers (`branchFilter`, `assertBranch`, `requireAdmin`); conventions in docs/architecture.md, "Admin dashboard".
- **Team:** `team_members` (migration 0002). Admins list, invite (Supabase `POST /auth/v1/invite` with the service role key; an existing Supabase user counts as invited; a failed invite removes the row), change role and branches, and remove members; the last admin cannot be demoted or removed. Without `SUPABASE_SERVICE_ROLE_KEY` members are added without an email.
- **Settings:** `client_settings` stores only what differs from the YAML (lead recipients and opening hours per branch, response time text and hours, handoff triggers), validated with the shared schema (`packages/shared/src/settings.ts`). `ClientRegistry.get()` returns the merged config and tells listeners; the Claude responder drops its cached system prompt. New `lead.response_time_hours` (working hours, default 8) for WA-024's alerts.
- **Demo seed and local development:** `pnpm db:seed` adds one admin and one salesperson per branch (`admin.jular@example.invalid`, `vendas.<branch>.jular@example.invalid`). `ADMIN_DEV_LOGIN=true` shows "sign in as" buttons for them without Supabase (and seeds them on start if the team is empty); it is refused at startup with `NODE_ENV=production` or on Cloud Run (`K_SERVICE`).
- The note about `MAIL_REDIRECT_TO` does not apply to login links: Supabase sends those itself. For a demo, invite real addresses.
- Screenshots: `m5/admin-*.png` in the project files.
- Open: a real Supabase project (docs/deploy.md, step 5b) and an end-to-end check on a phone; the first admin row is inserted by hand (SQL in the runbook).
