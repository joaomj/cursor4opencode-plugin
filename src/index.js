import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = join(__dirname, "cursor-proxy.cjs");

let child = null;

/** Returns true if something is already listening on the given TCP port. */
function isPortOccupied(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => {
      probe.close();
      resolve(false);
    });
    probe.listen(port, "127.0.0.1");
  });
}

/** Returns true if a healthy cursor-proxy is responding on the given port. */
function isProxyHealthy(port) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health", timeout: 2_000 },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export default async function cursorProxyPlugin() {
  const port = parseInt(process.env.CURSOR_PROXY_PORT || "32124", 10);
  const cursorBin = process.env.CURSOR_AGENT_BIN || "cursor-agent";
  const workspace = process.env.CURSOR_WORKSPACE || process.cwd();

  // Fix 2: don't spawn a second proxy if one is already running on the port.
  // This prevents EADDRINUSE crashes when OpenCode restarts while the daemon
  // proxy (cursor-proxy-start.sh) is still alive.
  const occupied = await isPortOccupied(port);
  if (occupied) {
    const healthy = await isProxyHealthy(port);
    if (healthy) {
      console.log(`[cursor-proxy] port ${port} already has a healthy proxy — skipping spawn`);
    } else {
      console.warn(
        `[cursor-proxy] port ${port} is occupied by an unhealthy or unknown process — skipping spawn`
      );
    }
  } else {
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
  }

  // Fix 2: graceful shutdown — wait up to 10 s for in-flight requests to drain
  // before killing the proxy process.
  const kill = () => {
    if (!child) return;
    const proc = child;
    child = null;

    const doKill = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3_000);
    };

    // If the proxy exposed its drain hook, wait for it
    if (proc.pid) {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        doKill();
      };
      // Give in-flight requests up to 10 s to complete
      const drainTimeout = setTimeout(settle, 10_000);
      // Try to reach the drain callback via the health endpoint
      httpRequest(
        { host: "127.0.0.1", port, path: "/health", timeout: 1_000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const { inflight } = JSON.parse(body);
              if (inflight === 0) {
                clearTimeout(drainTimeout);
                settle();
              } else {
                // Poll until inflight reaches 0 or timeout fires
                const poll = setInterval(async () => {
                  if (settled) { clearInterval(poll); return; }
                  const h = httpRequest(
                    { host: "127.0.0.1", port, path: "/health", timeout: 1_000 },
                    (r) => {
                      let b = "";
                      r.on("data", (c) => (b += c));
                      r.on("end", () => {
                        try {
                          const { inflight: inf } = JSON.parse(b);
                          if (inf === 0) {
                            clearTimeout(drainTimeout);
                            clearInterval(poll);
                            settle();
                          }
                        } catch { /* ignore */ }
                      });
                    }
                  );
                  h.on("error", () => {});
                  h.end();
                }, 500);
              }
            } catch {
              clearTimeout(drainTimeout);
              settle();
            }
          });
        }
      ).on("error", () => { doKill(); }).end();
    } else {
      doKill();
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
