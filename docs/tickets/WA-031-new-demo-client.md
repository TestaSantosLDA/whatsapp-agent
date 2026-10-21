# WA-031: Onboard a demo client from a website URL

| Status | Milestone | Depends on | PR |
| --- | --- | --- | --- |
| todo | Backlog | WA-002, WA-008 | |

## Why
To pitch a new company, we want their own agent running in the simulator within an hour, from their public website and store.

## Scope
- `pnpm client:new --name "Acme" --site https://acme.pt --store https://loja.acme.pt`:
  - reads the site's contact, FAQ, shipping and returns pages and drafts `clients/acme.yaml` (with Claude), leaving `TODO` where facts are missing
  - runs a first catalogue sync if the store is Shopify
- A human reviews the YAML before the demo.

## Acceptance criteria
- [ ] Running it for a second Shopify store produces a valid config and a working demo chat.
- [ ] No fact in the generated config is made up: each one cites the page it came from in a comment.
