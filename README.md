# opencode-cursor-agent-proxy

[![npm version](https://img.shields.io/npm/v/opencode-cursor-agent-proxy?label=version&logo=npm)](https://www.npmjs.com/package/opencode-cursor-agent-proxy)

OpenCode plugin that transparently proxies LLM calls through Cursor's `cursor-agent` CLI.

## How it works

The plugin starts a local HTTP server (`src/cursor-proxy.cjs`) that translates OpenAI-compatible `/v1/chat/completions` requests into `cursor-agent --print --output-format stream-json` CLI calls, then streams token deltas back as SSE. On init, it also injects the `cursor-acp` provider configuration into OpenCode with model definitions.

No MCP bridging, no tool-loop interception — just a thin HTTP server.

## Installation

### Via npm (recommended)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cursor-agent-proxy"]
}
```

OpenCode will install and load it automatically at startup.

### Via local path (no npm publish needed)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/opencode-cursor-agent-proxy"]
}
```

Or drop the `src/` directory contents into `~/.config/opencode/plugins/` for auto-discovery.

## Configuration

Set these environment variables to customize behavior:

| Variable | Default | Description |
|---|---|---|
| `CURSOR_AGENT_BIN` | `cursor-agent` | Path to the cursor-agent binary |
| `CURSOR_WORKSPACE` | `process.cwd()` | Workspace directory passed to cursor-agent |
| `CURSOR_PROXY_PORT` | `32124` | Port the proxy listens on |
| `CURSOR_PROXY_TIMEOUT` | `300000` | Request timeout in ms (5 min) |

## Models

The plugin registers these Cursor models under the `cursor-acp/` prefix:

- `cursor-acp/composer-2.5` (default)
- `cursor-acp/claude-4.6-opus-high`
- `cursor-acp/claude-4.6-opus-max`
- `cursor-acp/claude-4.6-opus-max-thinking`
- `cursor-acp/claude-4.6-sonnet-medium`
- `cursor-acp/claude-4.6-sonnet-medium-thinking`
- `cursor-acp/gpt-5.5-none`
- `cursor-acp/gpt-5.5-low` (default small model)
- `cursor-acp/gpt-5.5-medium`
- `cursor-acp/gpt-5.5-high`
- `cursor-acp/gpt-5.5-extra-high`

## Supply Chain Security

This plugin employs several measures to protect users from supply chain attacks:

**Zero dependencies.** The plugin has no npm dependencies. There are zero transitive packages that could be compromised upstream. The published tarball contains only 6 files (22 kB unpacked).

**npm provenance.** Every release is published to npm with [Sigstore](https://www.sigstore.dev/) provenance attestation. Users can verify the package was built and published from this repository's GitHub Actions CI:

```bash
npm audit signatures --package opencode-cursor-agent-proxy
```

**Delayed rollout.** New versions are published to the `next` dist-tag first. A 7-day quarantine period must elapse before automatic promotion to `latest`. This provides a window to catch malicious or defective releases before they reach the default install path.

**Verification.** To install a specific trusted version, pin the version explicitly:

```json
{ "plugin": ["opencode-cursor-agent-proxy@1.0.0"] }
```

## Requirements

- Node.js 18+
- `cursor-agent` CLI installed and available in PATH (or pointed to via `CURSOR_AGENT_BIN`)
- OpenCode with plugin support

## License

[MIT](LICENSE)
