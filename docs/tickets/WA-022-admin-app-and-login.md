# WA-022: Team dashboard shell, login and settings

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M5        | WA-020     |     |

## Why

The client's team needs its own place to work: the simulator's back-office panel is a demo of the customer side, not a tool a salesperson can use every day.

## Scope

- Angular app at `/admin` on the same service and URL as the simulator (WA-020), mobile first: salespeople are in the warehouse or on site, not at a desk. pt-PT copy.
- **Team members** per client: name, email, role (`admin` or `sales`), branches they belong to. Admins invite and remove members.
- **Login** by one-time email link (Resend, WA-015), 15-minute links, session cookie (httpOnly, 30 days). No passwords. Every admin API call is scoped to the member's client; sales members see their branches only.
- **Settings** (admins): lead recipients per branch, response time, opening hours, handoff triggers. Stored in the database as overrides on top of `clients/<id>.yaml`, applied without a redeploy; the prompt cache is rebuilt when they change.
- Navigation for the M5 screens: Inbox, Leads, Customers, Knowledge, Overview, Settings.

## Acceptance criteria

- [ ] An invited member receives a link, logs in on a phone, and sees only their client's data (and only their branches as `sales`).
- [ ] Changing a branch's lead recipients in Settings changes who receives the next lead, without a redeploy.
- [ ] Admin API routes reject requests without a valid session (tests).

## Out of scope

Single sign-on, two-factor login, billing, multi-client admin for the service owner.

## Notes

Demo seed: one admin and one salesperson per branch with `example.invalid` addresses; with `MAIL_REDIRECT_TO` set (WA-015) the login links reach the demo inbox.
