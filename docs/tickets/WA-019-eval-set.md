# WA-019: Eval set and model comparison

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | M4 | M2, M3 | |

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
