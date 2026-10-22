# WhatsApp Agent

A multi-client WhatsApp sales and support agent powered by Claude. The first client is Jular Madeiras ([loja.jular.pt](https://loja.jular.pt), [jular.pt](https://jular.pt)).

Status: M1 (foundation and WhatsApp simulator). See [docs/architecture.md](docs/architecture.md) and the [tickets](docs/tickets/README.md).

## Run it locally

Requires Node 24 LTS and pnpm (`corepack enable`).

```sh
pnpm install
cp .env.example .env   # then set SIMULATOR_WEBHOOK_SECRET to any 8+ character string
pnpm dev               # API on http://localhost:3000, simulator on http://localhost:4200
```

Open http://localhost:4200, pick a client and a persona, and chat. Until the Claude agent lands (M2), a test bot echoes messages; type `botões`, `lista` or `imagem` to see buttons, list messages and images.

No database setup is needed: without `DATABASE_URL` the API uses an embedded Postgres (PGlite) in `data/pglite`. For a real Postgres, `docker compose up -d` and set `DATABASE_URL=postgres://wa:wa@localhost:5432/wa`.

| Command                                        | What it does                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `pnpm test`                                    | Unit and API tests (in-memory database)                       |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code checks                                                   |
| `pnpm db:generate`                             | Create a migration after changing `apps/api/src/db/schema.ts` |
| `pnpm db:seed`                                 | Add a demo conversation                                       |

## Layout

- `apps/api`: Hono API: webhook, conversation worker, simulator endpoints.
- `apps/simulator`: Angular WhatsApp-style simulator.
- `packages/shared`: Zod schemas and types shared by both (WhatsApp payloads, client config, simulator events).
- `clients/*.yaml`: one config file per client.
- `docs/`: architecture and tickets.

## Automatic PR review

When a Claude Code session (CLI, desktop or the Claude app) opens a pull request, with the GitHub MCP tool or `gh pr create`, a PostToolUse hook ([.claude/hooks/pr-created.sh](.claude/hooks/pr-created.sh), registered in [.claude/settings.json](.claude/settings.json)) asks the session to start a fresh background reviewer. The reviewer follows the [`pr-review` skill](.claude/skills/pr-review/SKILL.md): it checks the PR against its ticket and the architecture doc, runs the checks, and posts inline comments plus a summary (Must fix / Recommended). It uses the session's own Claude subscription, no API key and no GitHub Action, and it only comments: it never approves, merges or pushes.

Limit: only PRs opened from Claude Code sessions are reviewed; PRs opened by hand on GitHub are not. See [WA-021](docs/tickets/WA-021-automatic-pr-review.md).
