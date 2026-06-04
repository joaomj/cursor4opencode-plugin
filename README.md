# cursor4opencode-plugin

[![npm version](https://img.shields.io/npm/v/cursor4opencode-plugin?label=version&logo=npm)](https://www.npmjs.com/package/cursor4opencode-plugin)

OpenCode plugin that adds a `cursor_delegate` tool backed by the Cursor TypeScript SDK.

## How It Works

This package is an OpenCode plugin. It does not register Cursor as an OpenCode model provider.

Instead, it registers one custom tool:

- `cursor_delegate` - delegates a task to Cursor Agent, usually with `composer-2.5`

OpenCode remains responsible for its normal model, permissions, session state, and native tools. Cursor runs as a separate delegated agent runtime through `@cursor/sdk`, and the tool returns Cursor's streamed assistant/tool/status events plus the final result.

## Installation

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["cursor4opencode-plugin"],
  "permission": {
    "cursor_delegate": "ask"
  }
}
```

OpenCode installs npm plugins automatically at startup.

## Requirements

- Node.js 20.17+
- OpenCode with plugin support
- Cursor API key in `CURSOR_API_KEY`

Create a Cursor API key from the Cursor dashboard, then start OpenCode with:

```bash
export CURSOR_API_KEY="crsr_..."
opencode
```

## Tool Arguments

`cursor_delegate` accepts:

| Argument | Default | Description |
|---|---|---|
| `prompt` | required | Task prompt for Cursor Agent |
| `model` | `composer-2.5` | Cursor model ID |
| `thinking` | unset | Optional Composer thinking level: `low` or `high` |
| `mode` | `agent` | Cursor mode: `agent` or `plan` |
| `runtime` | `local` | Cursor runtime: `local` or `cloud` |
| `cwd` | opencode worktree | Local workspace directory |
| `sandbox` | `false` | Enable Cursor local sandbox when supported |
| `agentId` | unset | Existing Cursor agent ID to resume |
| `repoUrl` | unset | Required for cloud runtime |
| `startingRef` | unset | Cloud runtime starting ref |
| `autoCreatePR` | `false` | Whether cloud runtime should create a PR |

## Example Use

Ask OpenCode:

```text
Use Cursor Composer 2.5 to implement this task: add a failing regression test, fix the bug, and report what changed.
```

OpenCode can call `cursor_delegate` with a prompt like:

```json
{
  "prompt": "Add a failing regression test, fix the bug, and report what changed.",
  "model": "composer-2.5",
  "thinking": "high",
  "mode": "agent",
  "runtime": "local"
}
```

The tool returns a transcript including Cursor tool calls and the final response.

## Why This Is Not A Provider

Cursor Composer is exposed by Cursor as an agent runtime, not a raw OpenAI-compatible chat-completion model. Treating it as an OpenCode provider hides tool execution from OpenCode and can produce unreliable session traces.

This plugin keeps that boundary explicit: Cursor is a delegated agent, surfaced through an auditable OpenCode tool call.

## Supply Chain Security

Every release is published to npm with provenance attestation. New versions are published to the `next` dist-tag first, then promoted after the quarantine window configured in this repository's GitHub Actions workflows.

Pin known-good versions when you need repeatability:

```json
{ "plugin": ["cursor4opencode-plugin@1.0.0"] }
```

## License

[MIT](LICENSE)
