# WA-001: Monorepo, tooling and CI

| Status    | Milestone | Depends on | PR  |
| --------- | --------- | ---------- | --- |
| in review | M1        |            |     |

## Why

Every later ticket needs a place to live, one way to run it, and CI that catches breakage before review.

## Scope

- pnpm workspaces with:
  - `apps/api`: Hono server on Node 24 LTS (webhook, worker, simulator endpoints).
  - `apps/simulator`: Angular app (empty shell for now).
  - `packages/shared`: Zod schemas and TypeScript types shared by both apps.
- TypeScript strict mode, ESLint, Prettier, Vitest.
- `docker-compose.yml` with Postgres 16 for local development.
- `.env.example` listing every variable the app reads; config loaded and validated with Zod at startup.
- GitHub Actions: install, lint, typecheck, test on every PR.
- Root `README.md` section: how to run everything locally in under 5 commands.

## Acceptance criteria

- [ ] `pnpm install && pnpm dev` starts the API and the simulator.
- [ ] `GET /health` on the API returns `200 {"ok":true}`.
- [ ] `pnpm test`, `pnpm lint` and `pnpm typecheck` pass locally and in CI.
- [ ] The API refuses to start with a clear message when a required env variable is missing.

## Out of scope

Deploy (WA-020).
