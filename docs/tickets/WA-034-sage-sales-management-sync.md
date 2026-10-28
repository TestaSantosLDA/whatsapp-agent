# WA-034: Send leads to Sage Sales Management

| Status | Milestone | Depends on             | PR  |
| ------ | --------- | ---------------------- | --- |
| todo   | Backlog   | WA-014, WA-024, WA-027 |     |

## Why

Jular's sales team works in Sage Sales Management (SSM, formerly ForceManager), with Sage X3 as the ERP. A lead the agent captures on WhatsApp should show up there without anyone retyping it. The integration is built as a generic CRM sink with one adapter per product, so the next client plugs in its own CRM by config.

What Jular runs (2026-10-28): Sage X3 (ERP), Sage Sales Management (sales), Sage 50c RH (payroll, not relevant), Bizdocs (document archive, not relevant for leads). Write-up of the options: <https://claude.ai/artifact/1NsFzHhgDUphacQRV1wzdo>.

Jular's answers (2026-10-28): latest Sage versions, most likely cloud; the move to Sage is in progress and should finish in about six months, so this is built against a test account and switched on when their SSM is live. They have a sales team working a pipeline. Branches are SSM territories with sellers assigned. Status coming back from SSM is wanted (WA-035). Mandatory fields not known yet. What a lead becomes in SSM, and when, is still being discussed.

## Scope

- **Generic CRM sink.** `lead.sinks` accepts `crm`; `lead.crm` in `clients/<id>.yaml` names the adapter and its mapping. A `CrmAdapter` interface (`findContactByPhone`, `upsertAccount`, `upsertContact`, `createOpportunity`, `addActivity`) lives in `apps/api/src/crm/`, with a mock adapter for tests and the simulator.
- **Sync records.** A `crm_links` table: client, adapter, local kind (`contact` or `lead`), local id, external kind and id, status (`pending`, `synced`, `failed`), attempts, last error, next attempt, synced at. Unique on (client, adapter, local kind, local id), so a retry never creates a second record.
- **Flow for one lead.**
  1. Find the customer in SSM by phone number. If none: create an account (business name and NIF when the customer gave them, else the person's name) and a contact with the WhatsApp number.
  2. Create an opportunity on that account: type from the lead type (quote, sample, order, Treehouse), the lead's branch, the owner's SSM user, and a description with the request fields, the summary and a link to the lead in the dashboard.
  3. Add an activity with the conversation summary.
  4. Store the SSM ids in `crm_links` and on the contact, so the next lead from the same customer reuses the account.
- **Reliability.** The first attempt runs in the background right after `LeadSinks.save`, like the Sheet sink; the customer's reply never waits for SSM. Failures are recorded and `POST /jobs/crm-sync` (Cloud Scheduler, every 15 minutes) retries with backoff, up to 8 attempts. After the last one the lead is marked failed and the client's admins get one email.
- **Dashboard.** The lead page shows the Sage state: synced (with a link to the opportunity), pending, or failed with the error and a "Retry" button.
- **Auth.** SSM v4: the public and private API keys are exchanged at `POST /api/v4/login` for a session key sent as `X-Session-Key`. Cached per client, renewed on a 401. The keys are environment variables from Secret Manager, named in the client config (for example `public_key_env: SSM_JULAR_PUBLIC_KEY`), never stored in the repo; the setup script that prompts for secrets (`gcp-setup.sh`) asks for them.
- **Mapping in config.** Branch → SSM territory (and its sellers); lead type → opportunity type and initial status; team member → SSM user, matched by email with a configured default user as fallback. Required SSM extra fields, if any, mapped from lead fields.

## Acceptance criteria

- [ ] A lead saved by the agent appears in SSM as an opportunity on the right account and contact, in the right branch, owned by the lead owner's SSM user, within a minute.
- [ ] A second lead from the same phone number reuses the existing account and contact.
- [ ] With SSM unreachable, the lead is stored and the customer's reply is unaffected; the next job run syncs it, with no duplicate.
- [ ] A failed lead shows the error on its page and can be retried by hand.
- [ ] Another client can use a different adapter, or none, by config only. Tests run against the mock adapter and recorded SSM responses; no test calls the real API.

## Out of scope

- Status coming back from SSM to the dashboard (won, lost). Jular wants it: next ticket (WA-035), using SSM webhooks.
- Writing to Sage X3 directly. SSM and X3 are expected to stay in sync on their side (to confirm, see below).
- Quote PDFs (WA-025) attached to the opportunity: the SSM API lists documents read-only; revisit if Jular needs it.
- Sage 50c RH and Bizdocs.

## Open questions for Jular (before implementation)

1. Are SSM and Sage X3 connected? If accounts must be created in X3 first, the agent may only be allowed to create prospects, or to attach opportunities to existing accounts.
2. Should a WhatsApp lead be an opportunity or an activity? Which opportunity types and statuses do they use?
3. Branches are SSM territories with sellers assigned (answered). Does each salesperson have an SSM user with the same email as in our dashboard?
4. Which SSM fields are mandatory, including extra fields (NIF, source, campaign)?
5. Does their SSM plan include API access? Which admin creates the API key pair for us, and is there a test environment?
6. Will the team work leads in SSM, in our dashboard, or both? This decides how soon status sync back is needed.
