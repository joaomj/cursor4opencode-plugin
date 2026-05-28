#!/usr/bin/env node
/**
 * cursor-proxy.cjs — Minimal OpenAI-compatible proxy for cursor-agent
 *
 * Performance fixes applied:
 *   Fix 1 - Session continuity: capture cursor-agent session_id and --resume
 *            subsequent turns with only the NEW user/tool messages.
 *   Fix 2 - In-flight tracking: requests are counted so the server can drain
 *            before shutdown rather than killing mid-stream processes.
 *   Fix 3 - TTFT logging: records spawn-time and first-token-time per request.
 *   Fix 4 - Concurrency cap: at most CURSOR_MAX_CONCURRENT cursor-agent
 *            processes run in parallel; excess requests are queued.
 *   Fix 5 - Pre-warm: runs `cursor-agent status` on startup to prime auth.
 *
 * Usage: node cursor-proxy.cjs [port]
 * Env vars:
 *   PORT                  HTTP port (default 32124)
 *   CURSOR_AGENT_BIN      path to cursor-agent binary
 *   CURSOR_WORKSPACE      workspace directory
 *   CURSOR_PROXY_TIMEOUT  per-request timeout ms (default 300000)
 *   CURSOR_MAX_CONCURRENT max concurrent cursor-agent processes (default 2)
 *   CURSOR_STREAM_REASONING set "true" to expose Cursor thinking output
 */

"use strict";

const http = require("http");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "32124", 10);
const CURSOR_BIN = process.env.CURSOR_AGENT_BIN || "cursor-agent";
const WORKSPACE = process.env.CURSOR_WORKSPACE || process.cwd();
const REQUEST_TIMEOUT = parseInt(process.env.CURSOR_PROXY_TIMEOUT, 10) || 300_000;
const MAX_CONCURRENT = parseInt(process.env.CURSOR_MAX_CONCURRENT, 10) || 2;
const MAX_SESSIONS = 100;
const STREAM_REASONING = process.env.CURSOR_STREAM_REASONING === "true";

// ── Fix 1: Session continuity ────────────────────────────────────────────────
// Map: conversationKey -> { chatId: string, sentCount: number }
const conversationSessions = new Map();

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text")
      .map((p) => p.text || "")
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function makeConversationKey(model, messages) {
  const firstUser = messages.find((m) => m.role === "user");
  // Strip <system-reminder> blocks that OpenCode injects inconsistently
  const userText = extractText(firstUser?.content)
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "")
    .trim();
  return (
    model +
    ":" +
    crypto
      .createHash("sha256")
      .update(userText.slice(0, 500))
      .digest("hex")
      .slice(0, 16)
  );
}

function rememberSession(key, chatId, sentCount) {
  if (!chatId || conversationSessions.has(key)) return;
  if (conversationSessions.size >= MAX_SESSIONS) {
    conversationSessions.delete(conversationSessions.keys().next().value);
  }
  conversationSessions.set(key, { chatId, sentCount });
  console.log(
    `[${new Date().toISOString()}] captured cursor session ${chatId.slice(0, 8)}… key=${key}`
  );
}

// ── Fix 4: Concurrency control ───────────────────────────────────────────────
let concurrentCount = 0;
const pendingQueue = [];

function acquireSlot(fn) {
  if (concurrentCount < MAX_CONCURRENT) {
    concurrentCount++;
    fn();
  } else {
    pendingQueue.push(fn);
  }
}

function releaseSlot() {
  if (pendingQueue.length > 0) {
    // Hand the slot directly to the next waiter (count stays the same)
    pendingQueue.shift()();
  } else {
    concurrentCount--;
  }
}

// ── Fix 2: In-flight tracking for graceful shutdown ──────────────────────────
let inflightTotal = 0;
const drainListeners = [];

function inflightInc() { inflightTotal++; }

function inflightDec() {
  if (--inflightTotal === 0 && drainListeners.length > 0) {
    drainListeners.splice(0).forEach((cb) => cb());
  }
}

// Exposed so index.js could tap in (best-effort; the /health endpoint is the
// primary drain signal used by index.js).
process.__cursorProxyInflight = () => inflightTotal;

// ── helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Build prompt from only the NEW messages (delta since last cursor-agent call).
 * Strips assistant messages because cursor-agent already produced them and they
 * live in its session history.  Returns null if there is nothing new to send.
 */
function buildDeltaPrompt(deltaMessages) {
  const newMessages = deltaMessages.filter((m) => m.role !== "assistant");
  if (newMessages.length === 0) return null;
  const hasToolResults = newMessages.some((m) => m.role === "tool");
  return hasToolResults ? buildPromptWithToolResults(newMessages) : buildPrompt(newMessages);
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
      if (this.text && delta.startsWith(this.text)) delta = delta.slice(this.text.length);
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
      if (this.thinking && delta.startsWith(this.thinking)) delta = delta.slice(this.thinking.length);
      if (!delta) return "";
      this.thinking = newThinking;
      return delta;
    }
    this.thinking = newThinking;
    return newThinking;
  }
}

// ── Fix 5: Pre-warm on startup ───────────────────────────────────────────────
function prewarm() {
  const t0 = Date.now();
  const child = spawn(CURSOR_BIN, ["status"], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  child.on("close", (code) => {
    console.log(
      `[${new Date().toISOString()}] pre-warm complete code=${code} elapsed=${Date.now() - t0}ms`
    );
  });
  child.on("error", () => {});
}

// ── cursor-agent spawner ─────────────────────────────────────────────────────

function spawnCursorAgent({ res, model, modelId, id, created, stream, prompt, resumeChatId, onSessionId }) {
  // Fix 3: track timing
  const spawnTime = Date.now();
  let firstTokenTime = null;
  // Declare streamed here (before parseOutputLine) to avoid temporal dead zone
  let streamed = false;
  let usage = null;
  let emittedSessionId = false;

  const args = [];
  if (resumeChatId) args.push("--resume", resumeChatId);
  args.push(
    "--print",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--force",
    "--workspace", WORKSPACE,
    "--model", model
  );

  const child = spawn(CURSOR_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    if (!res.writableEnded) {
      if (stream) {
        res.write(formatSseFinal(id, created, modelId, ""));
        res.end();
      } else {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/json" });
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

  // Fix 3: TTFT measurement — called from streaming path
  const parseOutputLine = (line, tracker) => {
    const ev = parseLine(line);
    if (!ev) return;
    const isPartial = typeof ev.timestamp_ms === "number";

    if (!emittedSessionId && typeof ev.session_id === "string") {
      emittedSessionId = true;
      onSessionId?.(ev.session_id);
    }
    if (ev.type === "result" && ev.usage) usage = ev.usage;
    if (!isPartial || res.writableEnded) return;

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const part of ev.message.content) {
        if (part.type === "text" && part.text) {
          const delta = tracker ? tracker.nextText(part.text) : part.text;
          if (delta) {
            if (!firstTokenTime) firstTokenTime = Date.now();
            res.write(formatSseChunk(id, created, modelId, { content: delta }));
            streamed = true;
          }
        }
        if (part.type === "thinking" && part.thinking) {
          const delta = tracker ? tracker.nextThinking(part.thinking) : part.thinking;
          if (delta && STREAM_REASONING) {
            if (!firstTokenTime) firstTokenTime = Date.now();
            res.write(formatSseChunk(id, created, modelId, { reasoning_content: delta }));
            streamed = true;
          }
        }
      }
    }
    if (ev.type === "thinking" && ev.text) {
      const delta = tracker ? tracker.nextThinking(ev.text) : ev.text;
      if (delta && STREAM_REASONING) {
        if (!firstTokenTime) firstTokenTime = Date.now();
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

  // Fix 2+3: shared cleanup — called on every exit path
  const done = (code, didStream) => {
    clearTimeout(timeout);
    releaseSlot();
    inflightDec();
    const total = Date.now() - spawnTime;
    const ttft = firstTokenTime != null ? firstTokenTime - spawnTime : null;
    console.log(
      `[${new Date().toISOString()}] stream done id=${id} model=${model} code=${code}` +
        ` streamed=${didStream} ttft=${ttft != null ? ttft + "ms" : "n/a"}` +
        ` total=${total}ms usage=${JSON.stringify(usage)}` +
        (resumeChatId ? ` resumed=${resumeChatId.slice(0, 8)}…` : "")
    );
  };

  // ── non-streaming path ──────────────────────────────────────────────────
  if (!stream) {
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => {
      if (!firstTokenTime) firstTokenTime = Date.now();
      stdoutChunks.push(c);
    });
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();

      const tracker = new DeltaTracker();
      let content = "";
      for (const line of stdout.split("\n")) {
        const ev = parseLine(line);
        if (!ev) continue;
        const isPartial = typeof ev.timestamp_ms === "number";
        if (!emittedSessionId && typeof ev.session_id === "string") {
          emittedSessionId = true;
          onSessionId?.(ev.session_id);
        }
        if (ev.type === "result" && ev.usage) usage = ev.usage;
        if (ev.type === "assistant" && Array.isArray(ev.message?.content) && isPartial) {
          for (const part of ev.message.content) {
            if (part.type === "text" && part.text) content += tracker.nextText(part.text);
          }
        }
      }
      if (code !== 0 || (stderr && !content)) {
        content = `Error: ${stderr || `cursor-agent exited with code ${code}`}`;
      }

      done(code, false);
      if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildFinalResponse(content)));
    });
    child.on("error", (err) => {
      done(-1, false);
      if (!res.writableEnded) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildFinalResponse(`Error: ${err.message}`)));
      }
    });
    return;
  }

  // ── streaming path ──────────────────────────────────────────────────────
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let buffer = "";
  const tracker = new DeltaTracker();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) parseOutputLine(line, tracker);
  });

  child.on("close", (code) => {
    if (buffer) parseOutputLine(buffer, tracker);
    if (!res.writableEnded) {
      const usageChunk = buildSseUsageChunk();
      if (usageChunk) res.write(usageChunk);
      res.write(formatSseFinal(id, created, modelId, streamed ? "" : undefined));
      res.end();
    }
    done(code, streamed);
  });

  child.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] spawn error id=${id} model=${model}: ${err.message}`);
    if (!res.writableEnded) {
      res.write(formatSseChunk(id, created, modelId, { content: `Error: ${err.message}` }));
      res.write(formatSseFinal(id, created, modelId, ""));
      res.end();
    }
    done(-1, streamed);
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── health ──────────────────────────────────────────────────────────────
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workspace: WORKSPACE, inflight: inflightTotal }));
    return;
  }

  // ── model list ──────────────────────────────────────────────────────────
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    try {
      const output = execSync(`${CURSOR_BIN} models`, { encoding: "utf8", timeout: 10_000 });
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

  // ── reject unknown paths ────────────────────────────────────────────────
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    console.error(`[${new Date().toISOString()}] 404: ${url.pathname}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // ── parse request body ──────────────────────────────────────────────────
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    console.error(`[${new Date().toISOString()}] 400: invalid JSON`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const stream = parsed.stream === true;
  const model = stripModelPrefix(parsed.model);
  const id = `cursor-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = `cursor-acp/${model}`;

  // ── Fix 1: resolve session + build prompt ───────────────────────────────
  const convKey = makeConversationKey(model, messages);
  const existingSession = conversationSessions.get(convKey);
  const isContinuation =
    existingSession != null &&
    messages.length > existingSession.sentCount;

  let resumeChatId = null;
  let prompt;

  if (isContinuation) {
    const delta = messages.slice(existingSession.sentCount);
    const deltaPrompt = buildDeltaPrompt(delta);
    if (deltaPrompt) {
      resumeChatId = existingSession.chatId;
      prompt = deltaPrompt;
      existingSession.sentCount = messages.length;
      console.log(
        `[${new Date().toISOString()}] ${req.method} /v1/chat/completions model=${model}` +
          ` msgs=${messages.length} stream=${stream}` +
          ` delta=${deltaPrompt.length}ch resume=${resumeChatId.slice(0, 8)}…`
      );
    } else {
      // Delta contained only assistant messages — nothing new; use full prompt
      prompt = buildPrompt(messages);
      console.log(
        `[${new Date().toISOString()}] ${req.method} /v1/chat/completions model=${model}` +
          ` msgs=${messages.length} stream=${stream} prompt=${prompt.length}ch (empty-delta fallback)`
      );
    }
  } else {
    const hasToolResults = messages.some((m) => m.role === "tool");
    prompt = hasToolResults ? buildPromptWithToolResults(messages) : buildPrompt(messages);
    console.log(
      `[${new Date().toISOString()}] ${req.method} /v1/chat/completions model=${model}` +
        ` msgs=${messages.length} stream=${stream} prompt=${prompt.length}ch (new session)`
    );
  }

  // ── Fix 4: queue if at concurrency limit; Fix 2: track inflight ─────────
  inflightInc();
  acquireSlot(() => {
    spawnCursorAgent({
      res,
      model,
      modelId,
      id,
      created,
      stream,
      prompt,
      resumeChatId,
      onSessionId: (sessionId) => rememberSession(convKey, sessionId, messages.length),
    });
  });
});

// ── start server ─────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${new Date().toISOString()}] cursor-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(
    `[${new Date().toISOString()}] config: MAX_CONCURRENT=${MAX_CONCURRENT} TIMEOUT=${REQUEST_TIMEOUT}ms STREAM_REASONING=${STREAM_REASONING} WORKSPACE=${WORKSPACE}`
  );
  // Fix 5: pre-warm authentication + connection pool on startup
  prewarm();
});
