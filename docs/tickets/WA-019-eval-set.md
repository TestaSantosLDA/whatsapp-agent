# WA-019: Eval set and model comparison

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M4        | M2, M3     |     |

## Why

We need evidence that the agent answers well before showing it to customers, a way to catch regressions, and data to choose the model (cost differs about 40x between Opus 5.5 and Haiku 5.5).

## Scope

- `evals/jular/*.yaml`: 30–50 scripted conversations covering all six use cases in Portuguese and English, including tricky ones (discount requests, delivery promises, islands, out-of-stock, Brazilian Portuguese input).
- Each case lists checks: tools that must or must not be called, facts that must appear, things that must not appear; plus an LLM-graded rubric for tone and helpfulness.
- `pnpm eval --client jular --model <id>` runs them through the real agent with the simulator channel and writes a report (pass rate, cost per conversation, latency).
- Run on `claude-opus-5-5` and `claude-haiku-5-5` and record the result in this ticket.

## Acceptance criteria

- [ ] Report shows per-case pass/fail and totals for both models.
- [ ] The chosen default model for Jular is written into its config with the reason.

## Notes

Evals cost real API money; each full run's cost is shown before it starts.

### Implementation (in review)

How to run and the case format: [evals/README.md](../../evals/README.md).

```sh
pnpm eval --client jular --model claude-opus-5-5 --yes
pnpm eval --client jular --model claude-haiku-5-5 --yes
pnpm eval:compare evals/reports/jular-claude-opus-5-5-<ts>.json evals/reports/jular-claude-haiku-5-5-<ts>.json
```

- **Cases:** 45 in `evals/jular/` (product advisor 5, calculator 6, FAQ and policies 8, leads and order drafts 6, handoff 6, Treehouse 6, guardrails 8), each use case in both pt-PT and English. The tricky ones: discount requests (15% volume, newsletter on a Treehouse), delivery date promise, Madeira and Azores (order draft), out-of-stock floor, special-transport beams, Brazilian Portuguese input, off-topic, prompt injection, rude customer, "falar com uma pessoa", after-hours and weekend handoff, silence after handoff, an old price, a product not in the store, a stock reservation request, first-contact disclosure.
- **Runner** (`apps/api/src/evals/`): an in-memory app (PGlite) with the real `ClaudeResponder` and all tools; each customer message is posted to the simulator API, so it goes through the webhook, queue, job and history replay exactly as in the simulator. Each case has its own clock (`now`) so opening hours are deterministic. Deterministic checks first, then the LLM grader (default `claude-opus-5-5`, `--grader` / `--no-grader`) with structured output (`output_config.format` json_schema via `zodOutputFormat`). A case passes only if both pass.
- **Catalogue:** the container cannot reach loja.jular.pt, so `evals/jular/catalogue.json` is a **synthetic** Shopify snapshot (test fixtures plus Jular-like products), and `evals/jular/setup.json` adds synthetic m² per box figures for the eval only. `--live-catalogue` syncs the real store, but the checks are written against the snapshot.
- **Cost gate:** the estimate (cases × turns × per-request assumptions from `pricing.ts`, in `apps/api/src/evals/cost.ts`) is printed first; the run needs `--yes` or a typed `y`; without `ANTHROPIC_API_KEY` it exits before calling anything. Estimate for one full run with the Opus grader: **Opus 5.5 ~$7.8** (agent ~$6.6), **Haiku 5.5 ~$1.3** (agent ~$0.17), Sonnet 5.5 ~$4.6. The grader is ~$1.15 of each.
- **Reports:** `evals/reports/<client>-<model>-<timestamp>.md` and `.json` (git-ignored), with per-case pass/fail, failed checks, grader reason, full transcripts, pass rate per use case, cost per conversation and p50/p95 latency per turn.
- **Tests (no network):** the case files validate against the schema and only name real tools, branches and catalogue facts; the deterministic checkers; a full CLI run of two cases against a scripted fake Anthropic API including the grader, asserting the report files; the cost-confirmation gate and the missing-key exit.

**Pending (needs an API key):** the comparison run on `claude-opus-5-5` and `claude-haiku-5-5`, recording the results here, and choosing Jular's default model in `clients/jular.yaml` with the reason. Both acceptance criteria stay open until then.
