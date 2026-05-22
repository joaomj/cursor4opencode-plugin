import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = join(__dirname, "cursor-proxy.cjs");

let child = null;

export default async function cursorProxyPlugin() {
  const port = parseInt(process.env.CURSOR_PROXY_PORT || "32124", 10);
  const cursorBin = process.env.CURSOR_AGENT_BIN || "cursor-agent";
  const workspace = process.env.CURSOR_WORKSPACE || process.cwd();

  child = spawn("node", [PROXY_SCRIPT], {
    env: {
      ...process.env,
      PORT: String(port),
      CURSOR_AGENT_BIN: cursorBin,
      CURSOR_WORKSPACE: workspace,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.on("error", (err) => {
    console.error(`[cursor-proxy] Failed to start: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(`[cursor-proxy] Exited with code ${code}`);
    }
    child = null;
  });

  const kill = () => {
    if (child) {
      child.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), 3000);
      child = null;
    }
  };

  process.on("exit", kill);
  process.on("SIGINT", kill);
  process.on("SIGTERM", kill);

  return {
    config: (cfg) => {
      cfg.provider = cfg.provider || {};
      cfg.provider["cursor-acp"] = {
        name: "Cursor ACP",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          "composer-2.5": {
            name: "Composer 2.5",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "claude-4.6-opus-high": {
            name: "Opus 4.6 High",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "claude-4.6-opus-max": {
            name: "Opus 4.6 Max",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "claude-4.6-opus-max-thinking": {
            name: "Opus 4.6 Max Thinking",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "claude-4.6-sonnet-medium": {
            name: "Sonnet 4.6 Medium",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "claude-4.6-sonnet-medium-thinking": {
            name: "Sonnet 4.6 Medium Thinking",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "gpt-5.5-none": {
            name: "GPT 5.5 None",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "gpt-5.5-low": {
            name: "GPT 5.5 Low",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "gpt-5.5-medium": {
            name: "GPT 5.5 Medium",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "gpt-5.5-high": {
            name: "GPT 5.5 High",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
          "gpt-5.5-extra-high": {
            name: "GPT 5.5 Extra High",
            limit: { context: 200000, input: 200000, output: 64000 },
          },
        },
      };

      if (!cfg.model) cfg.model = "cursor-acp/composer-2.5";
      if (!cfg.small_model) cfg.small_model = "cursor-acp/gpt-5.5-low";
    },
  };
}
