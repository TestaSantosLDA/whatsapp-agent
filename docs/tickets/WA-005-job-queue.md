# WA-005: Job queue abstraction

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M1        | WA-004     |     |

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

- 2026-10-21: `CloudTasksQueue` moved to WA-020 (deploy), where it is first needed; M1 ships the `Queue` interface and `InProcessQueue`. Failed turns are logged to the console for now; `agent_runs` logging comes with the agent (WA-009).
- Bursts of messages are merged by waiting until the newest one is 1.5 s old before answering.

Cloud Tasks free tier: first 1M operations a month.
