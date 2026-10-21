# WhatsApp Agent

A multi-client WhatsApp sales and support agent powered by Claude. The first client is Jular Madeiras ([loja.jular.pt](https://loja.jular.pt), [jular.pt](https://jular.pt)).

Status: planning. See [docs/architecture.md](docs/architecture.md) and the [tickets](docs/tickets/README.md).

## Automatic PR review

When a Claude Code session (CLI, desktop or the Claude app) opens a pull request, with the GitHub MCP tool or `gh pr create`, a PostToolUse hook ([.claude/hooks/pr-created.sh](.claude/hooks/pr-created.sh), registered in [.claude/settings.json](.claude/settings.json)) asks the session to start a fresh background reviewer. The reviewer follows the [`pr-review` skill](.claude/skills/pr-review/SKILL.md): it checks the PR against its ticket and the architecture doc, runs the checks, and posts inline comments plus a summary (Must fix / Recommended). It uses the session's own Claude subscription, no API key and no GitHub Action, and it only comments: it never approves, merges or pushes.

Limit: only PRs opened from Claude Code sessions are reviewed; PRs opened by hand on GitHub are not. See [WA-021](docs/tickets/WA-021-automatic-pr-review.md).
