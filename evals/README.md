# Evals (WA-019)

Scripted customer conversations that run through the real agent, to catch regressions and to choose a model per client.

```sh
pnpm eval --client jular --model claude-haiku-5-5            # prints the cost estimate, asks y/N
pnpm eval --client jular --model claude-opus-5-5 --yes       # no prompt (CI, scripts)
pnpm eval --client jular --case faq-pickup-en,handoff-ask-person-pt --yes
pnpm eval:compare evals/reports/jular-claude-opus-5-5-….json evals/reports/jular-claude-haiku-5-5-….json
```

A model or grader id without a price in `apps/api/src/agent/pricing.ts` is refused, because the cost could not be shown; pass `--allow-unknown-cost` to run it anyway.

Options: `--model` (default: the client's configured model), `--case id[,id]` (repeatable), `--concurrency 4`, `--grader claude-opus-5-5` (default) or `--no-grader`, `--live-catalogue`, `--yes`.

Needs `ANTHROPIC_API_KEY` (environment or the repo-root `.env`); without it the command prints the estimate and exits. **Every run costs real API money**: the estimate is printed first and the run starts only with `--yes` or a typed `y`. Tests never call the API.

## What a run does

1. Builds an in-memory app (PGlite) with the real `ClaudeResponder`, all tools, the client config from `clients/<client>.yaml` with the model overridden and `setup.json`'s `product_data` merged in.
2. Syncs the catalogue (see below) into it.
3. Plays each case by posting the customer's messages to the simulator API (`POST /sim/<client>/messages`), so they go through the webhook, the queue, the conversation job, the tools and the history replay exactly as in the simulator. Each case has its own customer phone and its own clock (`now`), so opening hours are deterministic.
4. Collects the replies (with buttons, lists and product captions), tool calls (`agent_runs`), leads, outbox emails, the conversation status, tokens, cost (`apps/api/src/agent/pricing.ts`) and latency.
5. Runs the deterministic checks, then the LLM grader on the rubric (pass/fail with a reason). A case passes only if both pass.
6. Writes `evals/reports/<client>-<model>-<timestamp>.md` and `.json` (git-ignored): per-case result with failed checks and the full transcript, totals, pass rate per use case, cost per conversation, p50/p95 latency per turn.

## Case files

`evals/<client>/*.yaml`, each a list of cases (schema: `apps/api/src/evals/cases.ts`, validated by the tests):

```yaml
- id: faq-pickup-en
  title: Picking up an online order
  use_case: faq # product_advisor | calculator | faq | lead | handoff | treehouse | guardrails
  language: en # pt-PT | en
  now: '2026-10-21T12:00:00+01:00'
  customer: { name: Tom Evans } # optional
  turns:
    - Can I pick up my online order in a store?
    - { tap: Interior } # taps a button / list row the agent offered
  checks: # all optional
    tools_called: [search_products]
    tools_not_called: [create_checkout_link]
    must_include: ['Camarate', '/2\s*(to|-)\s*4/'] # substring or /regex/, case-insensitive
    must_not_include: ['banheiro']
    lead: { type: quote, branch: maia } # or: none (no lead other than a handoff)
    status: human # bot | human, at the end
    emails: [handoff] # lead | handoff | order_draft
    silent_turns: [2] # 1-based turns that must get no reply
  rubric: >-
    What the grader judges: tone, helpfulness, the facts that need judgement.
```

## The Jular catalogue snapshot is synthetic

The eval container cannot reach loja.jular.pt, so `jular/catalogue.json` is a **synthetic** snapshot in Shopify's `products.json` shape: the test fixtures (`apps/api/src/test/fixtures`) extended with Jular-like products (decks, flooring, Osmo oils, glulam beams and CLT tagged "Transporte Especial", the three Treehouse models, an out-of-stock floor and an out-of-stock variant). Product names and prices are realistic but **not** Jular's real data, and the variant ids do not exist in the real store, so checkout links in reports do not work.

`jular/setup.json` adds synthetic m² per box figures (`product_data`) for the eval only; the real figures are still a TODO in `clients/jular.yaml`.

`--live-catalogue` syncs the client's real store instead. The checks are written against the snapshot, so with the live catalogue some product facts (prices, stock, cart variant ids) may fail even when the agent is right.
