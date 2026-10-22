# WA-009: Agent loop with Claude

| Status | Milestone | Depends on     | PR  |
| ------ | --------- | -------------- | --- |
| todo   | M2        | WA-005, WA-002 |     |

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

- [ ] In the simulator, "Olá" gets a greeting in European Portuguese and "Hello" one in English.
- [ ] A tool error is returned to Claude as an error result and the customer still gets a sensible reply.
- [ ] Cache reads show up in `agent_runs` from the second turn of a conversation.
- [ ] Agent code has unit tests with a mocked Claude client; one live smoke test runs only when `ANTHROPIC_API_KEY` is set.

## Notes

Keep history append-only between turns (no editing earlier messages) so caching and thinking work as intended.
