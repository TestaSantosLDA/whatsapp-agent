# WA-005: Job queue abstraction

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M1 | WA-004 | |

## Why
Meta expects a fast `200` from the webhook, and an agent turn takes seconds. Work must happen after the response, and on Cloud Run that means a real queue.

## Scope
- `Queue` interface: `enqueue(job)`, handler registration.
- `InProcessQueue` for local dev and tests.
- `CloudTasksQueue` that calls back `POST /jobs/:name` on the API, authenticated with an OIDC token or shared secret.
- Jobs are processed in order per conversation: a second message from the same customer waits for, or is merged into, the running turn.
- Retries with backoff for transient errors; a failed job is logged on `agent_runs` and the customer gets a short apology and a human handoff.

## Acceptance criteria
- [ ] Two messages sent 1 second apart by the same customer produce one coherent reply, not two overlapping ones.
- [ ] Queue implementation is chosen by env variable; tests use the in-process queue.

## Notes
Cloud Tasks free tier: first 1M operations a month.
