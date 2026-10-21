# WA-020: Deploy to Cloud Run and Supabase

| Status | Milestone | Depends on | PR  |
| ------ | --------- | ---------- | --- |
| todo   | M4        | M1–M3      |     |

## Why

A public demo URL we can open in any sales meeting.

## Scope

- Dockerfile for `apps/api`; the Angular simulator built as static files and served by the API (one service, one URL).
- Supabase project (free tier), migrations applied from CI.
- Google Cloud project: Cloud Run service (min instances 0), Cloud Tasks queue, Cloud Scheduler job for the hourly catalogue sync, secrets in Secret Manager (`ANTHROPIC_API_KEY`, DB URL, simulator access code).
- `CloudTasksQueue` implementing the `Queue` interface (moved here from WA-005).
- GitHub Actions: deploy on merge to `main`.
- Spending limit set on the Claude API key; Google Cloud budget alert at €1.

## Acceptance criteria

- [ ] Demo URL works on a phone, protected by the access code.
- [ ] First reply after a cold start arrives in under 10 seconds; warm replies in under 6.
- [ ] Monthly Google Cloud and Supabase cost is €0 at demo volume.

## Notes

Cloud Run needs a billing account with a card even within the free tier. Supabase pauses free projects after 7 days of inactivity; a weekly ping job keeps the demo alive.
