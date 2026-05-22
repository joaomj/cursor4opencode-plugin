#!/usr/bin/env node
/**
 * cursor-proxy.cjs — Minimal OpenAI-compatible proxy for cursor-agent
 *
 * Replaces the @rama_nigg/open-cursor plugin with a ~120-line HTTP server.
 * No tool-loop interception, no provider boundary validation, no MCP bridging.
 *
 * Usage: node cursor-proxy.cjs [port]
 * Defaults to port 32124. Set CURSOR_AGENT_BIN to override cursor-agent path.
 */

const http = require("http");
const { spawn } = require("child_process");
const { resolve } = require("path");

const PORT = parseInt(process.env.PORT || "32124", 10);
const CURSOR_BIN = process.env.CURSOR_AGENT_BIN || "cursor-agent";
const WORKSPACE = process.env.CURSOR_WORKSPACE || process.cwd();

// ── helpers ────────────────────────────────────────────────────────────────

function buildPrompt(messages) {
  const lines = [];
  for (const m of messages) {
    const role = m.role || "user";
    const content = m.content;
    if (typeof content === "string" && content.trim()) {
      lines.push(`${role.toUpperCase()}: ${content}`);
    } else if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && p.type === "text")
        .map((p) => p.text || "")
        .join("\n");
      if (text.trim()) lines.push(`${role.toUpperCase()}: ${text}`);
    }
  }

  const last = messages[messages.length - 1];
  const hasUnresolvedToolCalls =
    last && last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;

  let prompt = lines.join("\n\n");
  if (hasUnresolvedToolCalls) {
    const tcNames = last.tool_calls.map((tc) => tc?.function?.name || "?").join(", ");
    prompt += `\n\n(You called tools: ${tcNames}. The caller will provide results.)`;
  }
  return prompt || "Hello";
}

function buildPromptWithToolResults(messages) {
  const lines = [];
  for (const m of messages) {
    const role = m.role || "user";

    if (role === "tool") {
      const id = m.tool_call_id || "?";
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      lines.push(`TOOL_RESULT(${id}): ${body}`);
      continue;
    }

    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const tcs = m.tool_calls
        .map((tc) => `tool_call(${tc.id || "?"}, ${tc.function?.name || "?"}, ${tc.function?.arguments || "{}"})`)
        .join("; ");
      const text = typeof m.content === "string" ? m.content : "";
      lines.push(`ASSISTANT: ${text}${text ? " " : ""}[${tcs}]`);
      continue;
    }

    const content = m.content;
    if (typeof content === "string" && content.trim()) {
      lines.push(`${role.toUpperCase()}: ${content}`);
    } else if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && p.type === "text")
        .map((p) => p.text || "")
        .join("\n");
      if (text.trim()) lines.push(`${role.toUpperCase()}: ${text}`);
    }
  }

  const hasToolResults = messages.some((m) => m.role === "tool");
  let prompt = lines.join("\n\n");
  if (hasToolResults) {
    prompt += "\n\nThe above tool calls have been executed. Continue based on these results.";
  }
  return prompt || "Hello";
}

function stripModelPrefix(model) {
  return String(model || "auto").replace(/^cursor-acp\//, "") || "auto";
}

function formatSseChunk(id, created, model, delta) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    }) +
    "\n\n"
  );
}

function formatSseFinal(id, created, model, content) {
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: "stop" }],
    }) +
    "\n\ndata: [DONE]\n\n"
  );
}

function parseLine(line) {
  try {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

class DeltaTracker {
  constructor() {
    this.text = "";
    this.thinking = "";
  }
  nextText(newText) {
    if (!newText || newText === this.text) return "";
    if (newText.startsWith(this.text)) {
      let delta = newText.slice(this.text.length);
      if (this.text && delta.startsWith(this.text)) {
        delta = delta.slice(this.text.length);
      }
      if (!delta) return "";
      this.text = newText;
      return delta;
    }
    this.text = newText;
    return newText;
  }
  nextThinking(newThinking) {
    if (!newThinking || newThinking === this.thinking) return "";
    if (newThinking.startsWith(this.thinking)) {
      let delta = newThinking.slice(this.thinking.length);
      if (this.thinking && delta.startsWith(this.thinking)) {
        delta = delta.slice(this.thinking.length);
      }
      if (!delta) return "";
      this.thinking = newThinking;
      return delta;
    }
    this.thinking = newThinking;
    return newThinking;
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workspace: WORKSPACE }));
    return;
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    try {
      const { execSync } = require("child_process");
      const output = execSync(`${CURSOR_BIN} models`, { encoding: "utf8", timeout: 10000 });
      const models = [];
      for (const line of output.split("\n")) {
        const m = line.match(/^([a-z0-9.-]+)\s+-\s+(.+?)(?:\s+\((current|default)\))*\s*$/i);
        if (m) {
          models.push({
            id: m[1],
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "cursor",
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] model list failed: ${e}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    console.error(`[${new Date().toISOString()}] 404: ${url.pathname}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    console.error(`[${new Date().toISOString()}] 400: invalid JSON from ${req.socket?.remoteAddress}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const stream = parsed.stream === true;
  const model = stripModelPrefix(parsed.model);
  const promptChars = buildPrompt(messages).length;

  console.log(`[${new Date().toISOString()}] ${req.method} /v1/chat/completions model=${model} msgs=${messages.length} stream=${stream} prompt=${promptChars}ch`);

  const hasToolResults = messages.some((m) => m.role === "tool");
  const prompt = hasToolResults ? buildPromptWithToolResults(messages) : buildPrompt(messages);

  const id = `cursor-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = `cursor-acp/${model}`;

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--workspace",
    WORKSPACE,
    "--model",
    model,
  ];

  const child = spawn(CURSOR_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const REQUEST_TIMEOUT = parseInt(process.env.CURSOR_PROXY_TIMEOUT, 10) || 300000;
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    if (!res.writableEnded) {
      if (stream) {
        res.write(formatSseFinal(id, created, modelId, ""));
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Request timed out. Please try again." },
                finish_reason: "stop",
              },
            ],
          })
        );
      }
    }
  }, REQUEST_TIMEOUT);

  child.stdin.write(prompt);
  child.stdin.end();

  let usage = null;

  const parseOutputLine = (line, tracker) => {
    const ev = parseLine(line);
    if (!ev) return;
    const isPartial = typeof ev.timestamp_ms === "number";

    if (ev.type === "result" && ev.usage) {
      usage = ev.usage;
    }

    if (!isPartial || res.writableEnded) return;

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const part of ev.message.content) {
        if (part.type === "text" && part.text) {
          const delta = tracker ? tracker.nextText(part.text) : part.text;
          if (delta) {
            res.write(formatSseChunk(id, created, modelId, { content: delta }));
            streamed = true;
          }
        }
        if (part.type === "thinking" && part.thinking) {
          const delta = tracker ? tracker.nextThinking(part.thinking) : part.thinking;
          if (delta) {
            res.write(formatSseChunk(id, created, modelId, { reasoning_content: delta }));
            streamed = true;
          }
        }
      }
    }
    if (ev.type === "thinking" && ev.text) {
      const delta = tracker ? tracker.nextThinking(ev.text) : ev.text;
      if (delta) {
        res.write(formatSseChunk(id, created, modelId, { reasoning_content: delta }));
        streamed = true;
      }
    }
  };

  const buildFinalResponse = (content) => ({
    id,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: content || "No response" },
        finish_reason: "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.inputTokens || 0,
          completion_tokens: usage.outputTokens || 0,
          total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
        }
      : undefined,
  });

  const buildSseUsageChunk = () => {
    if (!usage) return "";
    return (
      "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [],
        usage: {
          prompt_tokens: usage.inputTokens || 0,
          completion_tokens: usage.outputTokens || 0,
          total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
        },
      }) +
      "\n\n"
    );
  };

  if (!stream) {
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();

      const tracker = new DeltaTracker();
      let content = "";
      for (const line of stdout.split("\n")) {
        const ev = parseLine(line);
        if (!ev) continue;
        const isPartial = typeof ev.timestamp_ms === "number";
        if (ev.type === "result" && ev.usage) usage = ev.usage;
        if (ev.type === "assistant" && Array.isArray(ev.message?.content) && isPartial) {
          for (const part of ev.message.content) {
            if (part.type === "text" && part.text) {
              content += tracker.nextText(part.text);
            }
          }
        }
      }
      if (code !== 0 || (stderr && !content)) {
        content = `Error: ${stderr || `cursor-agent exited with code ${code}`}`;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildFinalResponse(content)));
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let buffer = "";
  let streamed = false;
  const tracker = new DeltaTracker();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) parseOutputLine(line, tracker);
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    if (buffer) parseOutputLine(buffer, tracker);
    if (!res.writableEnded) {
      const usageChunk = buildSseUsageChunk();
      if (usageChunk) res.write(usageChunk);
      res.write(formatSseFinal(id, created, modelId, streamed ? "" : undefined));
      res.end();
    }
    console.log(`[${new Date().toISOString()}] stream done id=${id} model=${model} code=${code} streamed=${streamed} usage=${JSON.stringify(usage)}`);
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`[${new Date().toISOString()}] spawn error id=${id} model=${model}: ${err.message}`);
    if (!res.writableEnded) {
      res.write(formatSseChunk(id, created, modelId, { content: `Error: ${err.message}` }));
      const usageChunk = buildSseUsageChunk();
      if (usageChunk) res.write(usageChunk);
      res.write(formatSseFinal(id, created, modelId, ""));
      res.end();
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${new Date().toISOString()}] cursor-proxy listening on http://127.0.0.1:${PORT}`);
});
