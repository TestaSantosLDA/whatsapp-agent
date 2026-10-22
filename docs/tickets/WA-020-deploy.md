# WA-020: Deploy to Cloud Run and Supabase

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M4        | M1–M3      |     |

## Why

A public demo URL we can open in any sales meeting.

## Scope

- Dockerfile for `apps/api`; the Angular simulator built as static files and served by the API (one service, one URL).
- Supabase project (free tier), migrations applied from CI.
- Google Cloud project: Cloud Run service (min instances 0), Cloud Tasks queue, Cloud Scheduler job for the hourly catalogue sync, secrets in Secret Manager (`ANTHROPIC_API_KEY`, DB URL, simulator access code).
- `CloudTasksQueue` implementing the `Queue` interface (moved here from WA-005).
- GitHub Actions: deploy on merge to `main`.
- Optional (asked 2026-10-22): also publish the simulator on GitHub Pages, built with the Cloud Run API URL (needs CORS on `/sim` and `/static`). Only once the API is hosted: Pages serves static files, the simulator alone does nothing. **Deferred:** Cloud Run already serves the simulator at the same URL.
- Spending limit set on the Claude API key; Google Cloud budget alert at €1.

## Acceptance criteria

- [ ] Demo URL works on a phone, protected by the access code.
- [ ] First reply after a cold start arrives in under 10 seconds; warm replies in under 6.
- [ ] Monthly Google Cloud and Supabase cost is €0 at demo volume.

None of these can be checked before the accounts exist. What was verified without them is listed under Notes.

## Notes

### Code (this PR)

- **One service, one URL.** `pnpm build` (root) builds `@wa/shared`, the API (`tsc`, to `apps/api/dist`) and the simulator (`ng build`). The API serves `apps/simulator/dist/simulator/browser` at `/` ([routes/spa.ts](../../apps/api/src/routes/spa.ts)): `index.html` with `no-cache` and as the fallback for HTML requests outside `/sim`, `/webhook`, `/jobs` and `/static`; hashed assets (`main-XXXXXXXX.js`) with `max-age=31536000, immutable`; other files one hour. The simulator already called the API with same-origin paths, so nothing changed there. `SIMULATOR_DIST_DIR` overrides the folder; when it is missing (plain `pnpm dev`) nothing is served.
- **`/healthz`** added next to `/health`. Cloud Run's front end reserves some paths ending in `z`, so probes and the deploy workflow use `/health`.
- **Dockerfile** (multi-stage, `node:24-slim`, pnpm through corepack, `pnpm --filter @wa/api deploy --prod`, runs as `node`, honours `PORT`, 96 MB compressed). The runtime image mirrors the repo layout, so the default `CLIENTS_DIR`, `SIMULATOR_DIST_DIR` and `PGLITE_DIR` resolve. `.dockerignore` keeps `node_modules`, `dist`, `.git` and secrets out of the context. CI now also builds the image on every PR.
- **Migrations:** `pnpm --filter @wa/api db:migrate` (unchanged script) applies the drizzle migrations to `DATABASE_URL`; already-applied ones are skipped, so it is safe to run twice. The deploy workflow runs it before the new revision; `MIGRATE_ON_START=false` on Cloud Run. Postgres is opened with `prepare: false` for Supabase's transaction pooler.
- **`CloudTasksQueue`** ([queue/cloud-tasks.ts](../../apps/api/src/queue/cloud-tasks.ts)), selected by `QUEUE=cloudtasks`: creates an HTTP task through the Cloud Tasks REST API (plain `fetch`, access token from the metadata server, no Google SDK) that POSTs the payload to `PUBLIC_BASE_URL/jobs/run/<job>` with the `x-jobs-secret` header, `scheduleTime` = now + `CLOUD_TASKS_DELAY_MS` (1.5 s debounce). `POST /jobs/run/:name` runs the job; it answers 500 so Cloud Tasks retries, and after the last attempt (`X-CloudTasks-TaskRetryCount` + 1 = 3) runs the same failure handler as the in-process queue (apology and handoff) and answers 200. Why Cloud Tasks: on Cloud Run with min instances 0 the CPU is throttled once a response is sent, and an instance that scales down loses its in-memory jobs. Turns are serialised by creating the queue with `--max-concurrent-dispatches=1`. Default stays `inprocess`.
- **`POST /jobs/keepalive`** runs `select 1`, for the weekly Supabase keep-alive. The hourly `/jobs/catalogue-sync` also touches the database.
- **Startup:** `SYNC_ON_START=false` on Cloud Run (Scheduler syncs hourly; background work after a response is throttled).
- **Deploy workflow** ([deploy.yml](../../.github/workflows/deploy.yml)): on push to `main` and by hand. Typecheck and tests, build and push to Artifact Registry, migrations against Supabase (`DATABASE_URL` from Secret Manager), `gcloud run deploy` (min 0, **max 1**, 1 vCPU, 512 MiB, startup CPU boost, 3600 s timeout for SSE) with the secrets mounted from Secret Manager (`RESEND_API_KEY` only if it exists), `PUBLIC_BASE_URL` set to the service URL after the first deploy, then a `curl` of `/health`. Workload Identity Federation, no JSON keys; actions pinned by commit SHA. When the repository variable `GCP_PROJECT` is unset the job is skipped and a notice job runs instead, so the run is green.
- **Max instances 1, not 2:** simulator replies reach the browser through the in-memory `EventBus`; a second instance would not see them.
- **Region `europe-west1`:** Tier 1 pricing, every service available; the free tier is computed against Tier 1 prices. Supabase in West EU (Paris).
- **New env vars:** `QUEUE=cloudtasks`, `GCP_PROJECT`, `CLOUD_TASKS_LOCATION`, `CLOUD_TASKS_QUEUE`, `CLOUD_TASKS_DELAY_MS`, `MIGRATE_ON_START`, `SYNC_ON_START`, `SIMULATOR_DIST_DIR`. `loadEnv` refuses `QUEUE=cloudtasks` without the Cloud Tasks settings, `JOBS_SECRET` and an https `PUBLIC_BASE_URL`.

### Verified locally

- Unit tests with a fake `fetch` for `CloudTasksQueue` (task body, URL, schedule time, auth header, API errors, retry and failure handling, token caching) and app tests with `QUEUE=cloudtasks` (webhook creates a task, nothing runs in-process, the delivered task answers the customer, 500 then handoff after the last attempt, `/jobs/run` 404 with the in-process queue), static serving (index, fallback, cache headers, API routes untouched, traversal) and `/jobs/keepalive`.
- `pnpm build`, then `node apps/api/dist/server.js` with PGlite: `/`, `/health`, `/healthz`, `/sim/config`, `/favicon.ico`, the hashed `main-*.js` (immutable), `/static/demo-product.svg` and the access code on `/sim/clients` all work from one port; a simulator message got the echo reply over SSE.
- `docker build`, then the container (as `node`, `PORT=9090`) against a local Postgres 16 with `MIGRATE_ON_START=false`, after `db:migrate` ran twice (second run a no-op): page, assets and a full message round trip work; `prepare: false` works on a direct connection. Ready about 1 s after `docker start`; exits 0 on SIGTERM.
- `actionlint` passes on both workflows.

### What Afonso has to do

Follow [docs/deploy.md](../deploy.md): create the Google Cloud project with billing and the €1 budget alert, the Supabase project, the secrets, the two service accounts, the Cloud Tasks queue and Workload Identity Federation; set the spending limit on the Claude API key; set the GitHub repository variables (`GCP_PROJECT` last); merge; create the two Cloud Scheduler jobs; then check the three acceptance criteria on a phone.

### Open

- Not verified against real Google Cloud or Supabase: the Cloud Tasks request format follows the v2 REST API, the workflow and the `gcloud` commands have not run.
- An open simulator tab keeps the instance billed (SSE). 180,000 free vCPU-seconds are about 50 hours a month; the budget alert covers it. An idle disconnect in the simulator would close the gap.
- A message stored by the webhook whose task creation fails is not retried (Meta's redelivery is treated as a duplicate). Rare; the customer would have to write again.
