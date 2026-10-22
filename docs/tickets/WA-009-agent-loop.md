# WA-009: Agent loop with Claude

| Status    | Milestone | Depends on     | PR  |
| --------- | --------- | -------------- | --- |
| in review | M2        | WA-005, WA-002 |     |

## Why

This is the brain: it turns a customer message plus context into a reply, using tools.

## Scope

- Worker job `agent-turn`: load client config, conversation history (last N messages), contact data.
- Skip the turn if the conversation is in `human` status.
- Call Claude with `@anthropic-ai/sdk`, using the SDK tool runner and Zod tool definitions:
  - system prompt built from the client config (identity, tone, branches, hours, policies, rules)
  - prompt caching on the stable prefix (tools + system prompt)
  - model and effort from client config; default `claude-opus-5-5`
- Tool registry: each tool is a module with a Zod input schema, a description, and a handler that receives `{ client, conversation, contact }`. Only tools enabled in config are offered.
- Map the final answer to WhatsApp messages: split long text, turn product lists into images or list messages, add reply buttons where the agent asks a closed question.
- Record each turn in `agent_runs`: tokens, cost estimate, tools called, latency, errors.
- Send a typing indicator while working.

## Acceptance criteria

- [ ] (Needs an API key.) In the simulator, "Olá" gets a greeting in European Portuguese and "Hello" one in English.
- [x] A tool error is returned to Claude as an error result and the customer still gets a sensible reply.
- [ ] Cache reads show up in `agent_runs` from the second turn of a conversation. (Recorded and tested with a mocked client; confirm live once there is an API key.)
- [x] Agent code has unit tests with a mocked Claude client; one live smoke test runs only when `ANTHROPIC_API_KEY` is set.

## Notes

Keep history append-only between turns (no editing earlier messages) so caching and thinking work as intended.

## Implementation notes

- Code in `apps/api/src/agent/`. `ClaudeResponder` replaces the echo bot when `ANTHROPIC_API_KEY` is set; without a key the echo bot keeps the demo running.
- SDK tool runner (`client.beta.messages.toolRunner`) with `betaZodTool`. Tools are plain modules (`AgentTool` in `agent/tool.ts`) wrapped per turn, so they are testable without Claude.
- Caching: the system prompt is frozen per client (no time, no customer) and cached; tools are sorted by name; a breakpoint on the customer's latest message lets the next turn read the conversation from cache. Per-turn facts (time in Lisbon, open branches, first contact) go in a `role: "system"` message after the conversation.
- Earlier turns are replayed as text only, rebuilt deterministically from `messages`, in blocks of 100 so the prefix rarely moves.
- Thinking stays on (Opus 5.5 default); effort comes from client config (`medium` for Jular). Server-side fallback (`fallbacks: "default"`) is on, so a policy refusal is retried on the fallback model; a turn that still ends in a refusal fails and gets the apology + handoff.
- `offer_choices` (buttons or list under the reply) and `request_human` are always on; other tools are enabled per client in `tools:`.
- The tool results Claude sees are JSON; expected failures (`ToolError`) come back with a code, unexpected ones as `internal_error`.
