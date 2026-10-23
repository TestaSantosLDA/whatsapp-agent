# Deploying the demo (Cloud Run + Supabase)

Runbook for [WA-020](tickets/WA-020-deploy.md). The code side is done: a [Dockerfile](../Dockerfile), the [deploy workflow](../.github/workflows/deploy.yml), the `CloudTasksQueue` and the `/jobs/*` routes. This page covers the accounts and the one-time setup. After that, every merge to `main` tests, builds, migrates and deploys on its own.

Until the repository variable `GCP_PROJECT` is set, the deploy workflow skips its job and stays green.

## What runs where

```
Phone / laptop ──https──> Cloud Run "wa-demo" (one container, europe-west1, 0 to 1 instance)
                             ├─ /            the Angular simulator (static files, built into the image)
                             ├─ /admin       the team dashboard (Angular, WA-022); /api/admin/* its API (Supabase JWT)
                             ├─ /sim/*       simulator API + SSE streams (access code)
                             ├─ /webhook/*   Meta-format webhook
                             └─ /jobs/*      x-jobs-secret header
                                   ▲  ▲
          Cloud Tasks "wa-conversations" │  └── Cloud Scheduler: hourly catalogue sync, weekly keep-alive, lead reminders every 15 min
          (one conversation turn per task) │
                                          └── Supabase Postgres (transaction pooler, Paris)
```

Why Cloud Tasks and not the in-process queue: with request-based billing, Cloud Run throttles the CPU as soon as a response is sent, and an instance that scales to zero loses whatever jobs it held in memory. The webhook answers straight away, so the agent's turn would run throttled or not at all. With `QUEUE=cloudtasks` the webhook creates a task that Cloud Tasks POSTs back to `/jobs/run/process-conversation` 1.5 s later (the debounce for a burst of messages). The turn then runs inside a request, at full CPU, and Cloud Tasks retries it if the instance dies.

Why one instance at most: the simulator's replies reach the browser through an in-memory event bus ([bus.ts](../apps/api/src/bus.ts)). A second instance would not see them. One instance handles 80 concurrent requests, which is plenty for a demo. Going wider needs Postgres `LISTEN/NOTIFY` on the bus first.

Why the Cloud Tasks queue dispatches one task at a time: two turns for the same conversation must never run at the same time (both would answer). One dispatch at a time also serialises different customers, which is fine at demo volume.

## Costs

Everything below stays inside the free tiers at demo volume. Only the Claude API costs money.

| Service           | Free tier (per billing account, per month)                          | Our use                                                           |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cloud Run         | 180,000 vCPU-s, 360,000 GiB-s, 2 M requests (request-based billing) | 1 vCPU, 512 MiB, min 0 instances                                  |
| Artifact Registry | 0.5 GB storage                                                      | ~100 MB per image; a cleanup policy keeps the last 3              |
| Cloud Tasks       | 1 M operations                                                      | a few per message                                                 |
| Cloud Scheduler   | 3 jobs                                                              | 3 jobs (a fourth costs $0.10 a month)                             |
| Secret Manager    | 6 active secret versions, 10,000 accesses                           | 5 to 8 secrets (one version each: destroy old ones when rotating) |
| Supabase          | 500 MB database; pauses after 7 days without activity               | the hourly sync keeps it awake                                    |

The region is `europe-west1` (Belgium): a Tier 1 region (the cheapest price list, which the free tier is computed against) that offers every service used here. Supabase's closest region is West EU (Paris).

Watch out: an open simulator tab holds an SSE connection, and Cloud Run bills an instance for as long as a request is open. 180,000 vCPU-seconds is 50 hours of a tab left open per month. Close the tab after a meeting. The €1 budget alert below catches this.

## Setup

Run these from a terminal with the [gcloud CLI](https://cloud.google.com/sdk/docs/install) signed in (`gcloud auth login`). Steps 1 to 9 are one-time.

```sh
export PROJECT=wa-demo-jular          # must be globally unique: add a suffix if it is taken
export REGION=europe-west1
export SERVICE=wa-demo
export REPO=wa
export QUEUE=wa-conversations
export GITHUB_REPO=TestaSantosLDA/whatsapp-agent
```

### 1. Project and billing

Cloud Run needs a billing account with a card, even inside the free tier.

```sh
gcloud projects create "$PROJECT" --name="WhatsApp agent demo"
gcloud config set project "$PROJECT"
gcloud billing accounts list                     # copy the ACCOUNT_ID
export BILLING=XXXXXX-XXXXXX-XXXXXX
gcloud billing projects link "$PROJECT" --billing-account="$BILLING"
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
```

### 2. APIs

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudtasks.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com billingbudgets.googleapis.com
```

### 3. Budget alert at €1

An alert, not a cap: Google emails the billing admins at 50 % and 100 %. The amount's currency must be the billing account's currency (use `1USD` if the account is in dollars).

```sh
gcloud billing budgets create --billing-account="$BILLING" \
  --display-name="wa-demo 1 EUR" --budget-amount=1EUR \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

### 4. Artifact Registry, with a cleanup policy

```sh
gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"
cat > /tmp/cleanup.json <<'EOF'
[
  { "name": "keep-last-3", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 3 } },
  { "name": "delete-older", "action": { "type": "Delete" }, "condition": { "tagState": "ANY", "olderThan": "7d" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" \
  --policy=/tmp/cleanup.json --no-dry-run
```

### 5. Supabase

1. Create a free account at [supabase.com](https://supabase.com) and a new project: name `wa-demo`, region **West EU (Paris)**, a long generated database password (save it in your password manager).
2. Open **Connect** (top bar) and copy the **Transaction pooler** connection string (port **6543**):
   `postgresql://postgres.<project-ref>:<password>@aws-0-eu-west-3.pooler.supabase.com:6543/postgres`
   Copy the host exactly as the dashboard shows it (it can read `aws-0-…` or `aws-1-…`).
3. Put your password in, and append `?sslmode=require`. If the password has characters like `@`, `/` or `#`, URL-encode them.

Why the transaction pooler: the direct connection (`db.<ref>.supabase.co`) is IPv6 only, and neither Cloud Run nor GitHub's runners have IPv6 egress by default. The transaction pooler is IPv4 and meant for serverless clients. It does not support prepared statements, so the API opens Postgres with `prepare: false` ([db/index.ts](../apps/api/src/db/index.ts)). The migrations from CI use the same string.

The schema is created by the first deploy (`pnpm --filter @wa/api db:migrate`). Nothing to do in the Supabase dashboard for the database.

### 5b. Supabase Auth (team dashboard sign-in, WA-022)

The team dashboard at `<service URL>/admin` signs people in with Supabase Auth: an email link or code, or Google. It is invite only: admins invite colleagues from **Definições → Equipa**, and nobody can sign up on their own. Roles and branches live in our own `team_members` table; Supabase only proves who the person is. Free up to 50,000 monthly users.

The service URL is only known after the first deploy (step 12): do the URL parts then, and the rest now.

1. **Authentication → Sign In / Providers → User Signups:** turn **Allow new users to sign up** off. Invites still work; strangers get "Signups not allowed".
2. **Email provider:** on (the default). Keep **Confirm email** on. In **Authentication → Emails → Magic Link**, add `{{ .Token }}` to the template (e.g. "Ou escreva este código: {{ .Token }}"), so people whose phone opens the link in another browser can type the code instead. Translate the Invite and Magic Link templates to pt-PT while there.
3. **Google provider:**
   1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials) of the same project: **OAuth consent screen** → External, app name "Painel da equipa", support email, and publish it (In production; only the basic scopes `email`, `profile`, `openid` are used, so no verification is needed).
   2. **Credentials → Create credentials → OAuth client ID** → Web application. **Authorised redirect URI:** `https://<project-ref>.supabase.co/auth/v1/callback` (Supabase shows it on the Google provider page). No JavaScript origins are needed.
   3. In Supabase, **Authentication → Sign In / Providers → Google**: enable, paste the client ID and secret, save.
      With sign-ups off, Google sign-in only works for someone already invited (same email).
4. **URL configuration** (after the first deploy): **Site URL** `https://<service URL>/admin/`; **Redirect URLs** add `https://<service URL>/admin` and `https://<service URL>/admin/**`. For local development also add `http://localhost:3000/admin/**` and `http://localhost:4300/admin/**`.
5. **Keys** (**Project Settings → API Keys**): the publishable (anon) key goes into the repository variable `SUPABASE_ANON_KEY` (step 11), the project URL into `SUPABASE_URL`; both are public, the browser gets them from `GET /admin/config`. The secret (service role) key goes into Secret Manager as `SUPABASE_SERVICE_ROLE_KEY` (step 6): the API uses it to send invites and to store knowledge base files in a private Storage bucket (`knowledge`, created on the first upload; WA-026). Projects on the new **JWT signing keys** (the default) need nothing else: the API checks tokens against `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`. A project still on the legacy JWT secret also needs `SUPABASE_JWT_SECRET` (step 6).
6. **The first admin:** the dashboard has no admin yet, so add one row by hand once the schema exists, then sign in with that email (magic link or Google) and invite everyone else from the dashboard:
   ```sql
   insert into team_members (client_id, email, name, role) values ('jular', 'you@example.com', 'Your name', 'admin');
   ```
   (Supabase → SQL editor.) Because sign-ups are disabled, also create that user once in **Authentication → Users → Invite user**.

`ADMIN_DEV_LOGIN` (sign in as anyone, for local development) is refused at startup with `NODE_ENV=production` or on Cloud Run; never set it there.

### 6. Secrets

`printf '%s'` avoids a trailing newline in the secret.

```sh
secret() { printf '%s' "$2" | gcloud secrets create "$1" --replication-policy=automatic --data-file=-; }

secret ANTHROPIC_API_KEY        'sk-ant-...'                      # see step 10 for its spending limit
secret DATABASE_URL             'postgresql://postgres.<ref>:<password>@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?sslmode=require'
secret SIMULATOR_ACCESS_CODE    'pick-a-code-to-give-prospects'
secret JOBS_SECRET              "$(openssl rand -hex 24)"
secret SIMULATOR_WEBHOOK_SECRET "$(openssl rand -hex 24)"
# Optional: real emails through Resend. Without it, emails stay in the back-office panel.
# secret RESEND_API_KEY 're_...'
# Optional, for demos: every email goes to this address instead of the branch teams. With
# Resend's test sender (onboarding@resend.dev) it must be the Resend account's own address.
# secret MAIL_REDIRECT_TO 'you@example.com'
# Team dashboard (step 5b): invites. Without it, admins can add members but no invite email goes out.
# secret SUPABASE_SERVICE_ROLE_KEY 'sb_secret_...'
# Only for a Supabase project still on the legacy JWT secret (at least 32 characters).
# secret SUPABASE_JWT_SECRET '...'
```

To change one later: `printf '%s' 'new' | gcloud secrets versions add NAME --data-file=-`, redeploy (re-run the workflow), then `gcloud secrets versions destroy <old-version> --secret=NAME` to stay within the 6 free versions.

### 7. Service accounts

Two accounts: `wa-run` is the identity of the running service, `wa-deploy` is what GitHub Actions acts as.

```sh
gcloud iam service-accounts create wa-run    --display-name="wa-demo runtime"
gcloud iam service-accounts create wa-deploy --display-name="wa-demo deploy (GitHub Actions)"
export RUN_SA=wa-run@$PROJECT.iam.gserviceaccount.com
export DEPLOY_SA=wa-deploy@$PROJECT.iam.gserviceaccount.com

# Runtime: read its secrets, create Cloud Tasks.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUN_SA" \
  --role=roles/secretmanager.secretAccessor --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUN_SA" \
  --role=roles/cloudtasks.enqueuer --condition=None

# Deploy: manage the Cloud Run service (including making it public), push images, list secrets,
# read DATABASE_URL for the migrations, and run the service as wa-run.
for role in roles/run.admin roles/secretmanager.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" \
    --role="$role" --condition=None
done
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer
gcloud secrets add-iam-policy-binding DATABASE_URL \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/secretmanager.secretAccessor
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
```

### 8. Cloud Tasks queue

`--max-attempts=3` must match the API's `CloudTasksQueue` (3 attempts, then it apologises to the customer and hands the conversation to a person).

```sh
gcloud tasks queues create "$QUEUE" --location="$REGION" \
  --max-concurrent-dispatches=1 --max-attempts=3 \
  --min-backoff=2s --max-backoff=20s --max-retry-duration=600s
```

### 9. Workload Identity Federation (GitHub → Google, no JSON key)

Only workflow runs on `main` of this repository can act as `wa-deploy`. The trust is pinned to the repository's numeric id, which never changes, as well as its name: if the repository were renamed or deleted, someone recreating the name could not use it.

```sh
GITHUB_REPO_ID=$(gh api "repos/$GITHUB_REPO" --jq .id)
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc whatsapp-agent \
  --location=global --workload-identity-pool=github --display-name="whatsapp-agent" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_id == '$GITHUB_REPO_ID' && assertion.repository == '$GITHUB_REPO' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$GITHUB_REPO_ID"
```

### 10. Spending limit on the Claude API key

In the [Anthropic Console](https://console.anthropic.com): create a workspace `wa-demo` (Settings → Workspaces), set a monthly **spend limit** on it (for example $20), and create the API key from step 6 inside that workspace. Limits apply per workspace, so the demo cannot spend more than that whatever happens. Also set an email notification threshold below the limit.

### 11. GitHub repository variables

No GitHub secrets are needed: credentials come from Workload Identity Federation, application secrets from Secret Manager. Set `GCP_PROJECT` last, because it switches the deploy on.

```sh
gh variable set GCP_REGION       --repo "$GITHUB_REPO" --body "$REGION"
gh variable set GCP_WIF_PROVIDER --repo "$GITHUB_REPO" \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/whatsapp-agent"
gh variable set GCP_DEPLOY_SA    --repo "$GITHUB_REPO" --body "$DEPLOY_SA"
gh variable set GCP_RUNTIME_SA   --repo "$GITHUB_REPO" --body "$RUN_SA"
gh variable set GCP_PROJECT      --repo "$GITHUB_REPO" --body "$PROJECT"
```

For the team dashboard (step 5b), set the two public Supabase values as variables (not secrets, which keeps Secret Manager inside its free versions):

```sh
gh variable set SUPABASE_URL      --repo "$GITHUB_REPO" --body "https://<project-ref>.supabase.co"
gh variable set SUPABASE_ANON_KEY --repo "$GITHUB_REPO" --body "sb_publishable_..."
```

Without them the dashboard is served but shows "sign-in is not configured".

Optional variables, with their defaults: `CLOUD_RUN_SERVICE` (`wa-demo`), `ARTIFACT_REPOSITORY` (`wa`), `CLOUD_TASKS_QUEUE` (`wa-conversations`), `PUBLIC_BASE_URL` (the service's `run.app` URL; set it only for a custom domain).

### 12. First deploy

Merge to `main`, or run the workflow by hand:

```sh
gh workflow run deploy.yml --repo "$GITHUB_REPO" --ref main
gh run watch --repo "$GITHUB_REPO"
export URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
echo "$URL"
```

The workflow runs typecheck and tests, builds and pushes the image, applies the migrations to Supabase, deploys with `--min-instances 0 --max-instances 1`, and on the very first deploy sets `PUBLIC_BASE_URL` to the new URL. It ends with a `curl` of `$URL/health`.

### 13. Cloud Scheduler jobs

Created once, after the first deploy (they need the URL). The hourly catalogue sync also counts as database activity, so it already keeps Supabase awake; the weekly keep-alive is a backstop that does not depend on Shopify answering.

```sh
JOBS_SECRET=$(gcloud secrets versions access latest --secret=JOBS_SECRET)
gcloud scheduler jobs create http wa-catalogue-sync --location="$REGION" \
  --schedule="0 * * * *" --time-zone=Europe/Lisbon \
  --uri="$URL/jobs/catalogue-sync" --http-method=POST \
  --headers="x-jobs-secret=$JOBS_SECRET" --attempt-deadline=300s
gcloud scheduler jobs create http wa-lead-reminders --location="$REGION" \
  --schedule="*/15 * * * *" --time-zone=Europe/Lisbon \
  --uri="$URL/jobs/lead-reminders" --http-method=POST \
  --headers="x-jobs-secret=$JOBS_SECRET" --attempt-deadline=120s
gcloud scheduler jobs create http wa-privacy-retention --location="$REGION" \
  --schedule="30 3 * * *" --time-zone=Europe/Lisbon \
  --uri="$URL/jobs/privacy-retention" --http-method=POST \
  --headers="x-jobs-secret=$JOBS_SECRET" --attempt-deadline=300s
gcloud scheduler jobs create http wa-weekly-insights --location="$REGION" \
  --schedule="0 8 * * 1" --time-zone=Europe/Lisbon \
  --uri="$URL/jobs/weekly-insights" --http-method=POST \
  --headers="x-jobs-secret=$JOBS_SECRET" --attempt-deadline=300s
gcloud scheduler jobs run wa-catalogue-sync --location="$REGION"   # run it once now
```

`wa-lead-reminders` ([WA-024](tickets/WA-024-leads-pipeline.md)) emails a lead's owner once it is still `new` after the client's `lead.response_time_hours` (default 8) counted in the branch's opening hours, and the branch's admins once after 24 working hours. Each reminder is claimed in the database before it is sent, so a retried or overlapping run never sends one twice; the answer is `{ checked, owner, admin }`. Every 15 minutes keeps a reminder at most 15 minutes late; it is a short request (one query, mostly no email), well inside the Cloud Run free tier.

There is no separate keep-alive job: the hourly catalogue sync and the lead reminders touch the database far more often than Supabase's 7-day pause, so the three jobs stay inside Cloud Scheduler's free tier. `POST /jobs/keepalive` still exists for a manual ping.

The daily privacy retention job ([WA-028](tickets/WA-028-privacy-tools.md)) deletes customers with no activity for longer than the client's `privacy.retention_months` (default 24), at most 500 per client and run, through the same handlers as a delete from the dashboard; leads are anonymised, and each deletion is in the privacy audit log as "Apagado por retenção". `?client=<id>` runs one client. Admins see whom it deletes in the next 7 days in Privacidade → Retenção.

`wa-weekly-insights` ([WA-029](tickets/WA-029-insights.md)) emails each client's admins, on Monday at 08:00, last week's overview (conversations, leads by type, handoffs, quoted, won/lost, the team's median first response, Claude's cost) and the top five "couldn't answer" topics. Each client's week is claimed in `insight_reports` before sending, so a retry never sends it twice; `?client=<id>` runs one client. It is the fourth job: Cloud Scheduler's free tier covers three per billing account, the fourth costs about $0.10 a month.

The secret is stored in the job's configuration, readable by project owners only. After rotating `JOBS_SECRET`, run `gcloud scheduler jobs update http <job> --location="$REGION" --update-headers="x-jobs-secret=<new>"` for every job.

## Verify

1. **Health:** `curl -s "$URL/health"` answers `{"ok":true}`. Use `/health`, not `/healthz`: Cloud Run's front end reserves some paths ending in `z` and never forwards them.
2. **On a phone:** open `$URL`, enter the access code, pick a persona and ask for a product. Without the code, `curl -s "$URL/sim/clients"` answers 401.
3. **Cold start:** wait about 15 minutes without traffic (the instance scales to zero), then time the first request and the first reply:
   ```sh
   curl -s -o /dev/null -w 'cold: %{time_total}s\n' "$URL/health"
   curl -s -o /dev/null -w 'warm: %{time_total}s\n' "$URL/health"
   ```
   In the simulator, the first reply after a cold start should arrive in under 10 s and later replies in under 6 s (WA-020's acceptance criteria). Locally the image is ready about 1 s after start; Cloud Run adds the image pull and the startup CPU boost is on.
4. **Queue:** `gcloud tasks list --queue="$QUEUE" --location="$REGION"` is empty once replies have arrived. Failed deliveries show in the logs as `[queue] job ... failed`.
5. **Logs:** `gcloud run services logs read "$SERVICE" --region="$REGION" --limit=50`.
6. **Scheduler:** `gcloud scheduler jobs describe wa-catalogue-sync --location="$REGION"` shows the last attempt's status.
7. **Costs:** after a few days, the billing report for the project shows €0.00.
8. **Dashboard:** open `$URL/admin/` on a phone, sign in with the first admin's email, open Definições → Equipa and invite a colleague; `curl -s "$URL/api/admin/me"` answers 401.

## Day to day

- **Deploy:** merge to `main`. A failed migration stops the deploy before traffic moves.
- **Roll back:** `gcloud run revisions list --service="$SERVICE" --region="$REGION"`, then `gcloud run services update-traffic "$SERVICE" --region="$REGION" --to-revisions=<revision>=100`. Migrations are not rolled back: keep them additive.
- **Run locally like production:** `pnpm build && SIMULATOR_WEBHOOK_SECRET=... node apps/api/dist/server.js` serves the simulator and the API on one port (PGlite without `DATABASE_URL`). Or `docker build -t wa-api . && docker run --rm -p 8080:8080 -e SIMULATOR_WEBHOOK_SECRET=change-me-please wa-api`.
- **Take the demo offline:** remove public access with `gcloud run services remove-iam-policy-binding "$SERVICE" --region="$REGION" --member=allUsers --role=roles/run.invoker` (the next deploy makes it public again).

## Not done here

- **GitHub Pages copy of the simulator:** deferred. The simulator is already served by Cloud Run at the same URL; a Pages copy would need CORS on `/sim` and `/static` and a build pointed at the Cloud Run URL, for no gain in the demo.
- **OIDC tokens on Cloud Tasks and Scheduler calls:** not used. The service has to be public for the simulator, so Cloud Run would not check them; `/jobs/*` is protected by the `x-jobs-secret` header instead.
