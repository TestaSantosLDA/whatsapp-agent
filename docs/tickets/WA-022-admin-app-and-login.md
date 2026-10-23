# WA-022: Team dashboard shell, login and settings

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M5        | WA-020     |     |

## Why

The client's team needs its own place to work: the simulator's back-office panel is a demo of the customer side, not a tool a salesperson can use every day.

## Scope

- Angular app at `/admin` on the same service and URL as the simulator (WA-020), mobile first: salespeople are in the warehouse or on site, not at a desk. pt-PT copy.
- **Team members** per client: name, email, role (`admin` or `sales`), branches they belong to. Admins invite and remove members.
- **Login** with Supabase Auth (decided 2026-10-23): email one-time link or code, plus "Sign in with Google". Invite only: admins invite members (Supabase invite), public sign-up is disabled. The API verifies the Supabase JWT on every admin call and maps the user to a team member; every call is scoped to the member's client, and sales members see their branches only. Members live in our own `team_members` table keyed by the Supabase user id, so roles and branches stay in our schema.
- **Settings** (admins): lead recipients per branch, response time, opening hours, handoff triggers. Stored in the database as overrides on top of `clients/<id>.yaml`, applied without a redeploy; the prompt cache is rebuilt when they change.
- Navigation for the M5 screens: Inbox, Leads, Customers, Knowledge, Overview, Settings.

## Acceptance criteria

- [ ] An invited member receives a link, logs in on a phone, and sees only their client's data (and only their branches as `sales`).
- [ ] Changing a branch's lead recipients in Settings changes who receives the next lead, without a redeploy.
- [ ] Admin API routes reject requests without a valid session (tests).

## Out of scope

Microsoft sign-in, enforced two-factor login, billing, multi-client admin for the service owner.

## Notes

- Supabase Auth: free up to 50k monthly users. Setup: enable the email and Google providers, disable sign-ups, set the site URL to the Cloud Run URL plus `/admin`; add it to docs/deploy.md. Local development and tests verify JWTs with a test signing key, so the in-memory database (PGlite) keeps working without Supabase running.
- Demo seed: one admin and one salesperson per branch with `example.invalid` addresses; with `MAIL_REDIRECT_TO` set (WA-015) the login links reach the demo inbox.
