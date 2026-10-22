#!/usr/bin/env bash
# PostToolUse hook: when a tool call has just created a GitHub pull request,
# tell the main agent to start a fresh reviewer subagent (pr-review skill).
# Handles mcp__github__create_pull_request and Bash `gh pr create`.
# Never fails the tool call: always exits 0.

input="$(cat 2>/dev/null)"
command -v node >/dev/null 2>&1 || exit 0

printf '%s' "$input" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(raw || "{}");
    const tool = p.tool_name || "";
    const res = p.tool_response;
    let haystack;
    if (tool === "mcp__github__create_pull_request") {
      haystack = typeof res === "string" ? res : JSON.stringify(res ?? "");
    } else if (tool === "Bash") {
      const cmd = (p.tool_input && p.tool_input.command) || "";
      if (!/\bgh\s+pr\s+create\b/.test(cmd)) return;
      haystack = res && typeof res === "object"
        ? String(res.stdout ?? JSON.stringify(res))
        : String(res ?? "");
    } else {
      return;
    }
    // Undo JSON escaping from nested/stringified payloads (e.g. MCP text blocks).
    haystack = haystack.replace(/\\\//g, "/");
    let m = haystack.match(/https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/);
    if (!m) {
      // Fall back to the REST API form: https://api.github.com/repos/OWNER/REPO/pulls/N
      m = haystack.match(/https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pulls\/(\d+)/);
      if (!m) return;
    }
    const [, owner, repo, num] = m;
    const url = `https://github.com/${owner}/${repo}/pull/${num}`;
    const ref = `${owner}/${repo}#${num}`;
    const ctx =
      `A pull request was just created: ${url}. ` +
      "Start a fresh reviewer now with the Agent tool (subagent_type general-purpose, run_in_background true) " +
      `whose prompt tells it to load the \`pr-review\` skill and review ${ref}. ` +
      "Do not review it yourself in this context.";
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx },
    }) + "\n");
  } catch (_) {
    // Malformed input: stay silent.
  }
});
' 2>/dev/null

exit 0
