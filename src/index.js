import { Agent } from "@cursor/sdk";
import { tool } from "@opencode-ai/plugin";

const agents = new Map();

function modelSelection(model, thinking) {
  if (!thinking) return { id: model };
  return { id: model, params: [{ id: "thinking", value: thinking }] };
}

function agentKey({ runtime, cwd, model, mode, thinking, repoUrl }) {
  return [runtime, cwd, repoUrl || "", model, mode, thinking || ""].join("\0");
}

async function getCursorAgent(args) {
  const apiKey = args.apiKey || process.env.CURSOR_API_KEY;
  const model = modelSelection(args.model, args.thinking);

  if (args.agentId) {
    return Agent.resume(args.agentId, { apiKey, model });
  }

  const key = agentKey(args);
  const existing = agents.get(key);
  if (existing) return existing;

  const options = {
    apiKey,
    model,
    mode: args.mode,
  };

  if (args.runtime === "cloud") {
    if (!args.repoUrl) {
      throw new Error("cursor_delegate runtime=cloud requires repoUrl");
    }
    options.cloud = {
      repos: [{ url: args.repoUrl, startingRef: args.startingRef }],
      autoCreatePR: Boolean(args.autoCreatePR),
    };
  } else {
    options.local = {
      cwd: args.cwd,
      sandboxOptions: { enabled: Boolean(args.sandbox) },
    };
  }

  const agent = await Agent.create(options);
  agents.set(key, agent);
  return agent;
}

function readTextBlock(block) {
  if (!block || block.type !== "text") return "";
  return block.text || "";
}

function formatToolArgs(value) {
  if (value == null) return "";
  try {
    const text = JSON.stringify(value);
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return String(value);
  }
}

async function runCursorDelegate(input, context) {
  const cwd = input.cwd || context.worktree || context.directory || process.cwd();
  const args = {
    prompt: input.prompt,
    runtime: input.runtime || "local",
    mode: input.mode || "agent",
    model: input.model || "composer-2.5",
    thinking: input.thinking,
    cwd,
    repoUrl: input.repoUrl,
    startingRef: input.startingRef,
    autoCreatePR: input.autoCreatePR,
    sandbox: input.sandbox,
    apiKey: input.apiKey,
    agentId: input.agentId,
  };

  const agent = await getCursorAgent(args);
  const sendOptions = { mode: args.mode };
  if (args.model || args.thinking) sendOptions.model = modelSelection(args.model, args.thinking);

  const run = await agent.send(args.prompt, sendOptions);
  const events = [];
  let assistantText = "";

  for await (const message of run.stream()) {
    if (message.type === "assistant") {
      const text = (message.message?.content || []).map(readTextBlock).join("");
      if (text) {
        assistantText += text;
        events.push(`assistant: ${text.trim()}`);
      }
    } else if (message.type === "thinking") {
      if (message.text) events.push(`thinking: ${message.text.trim()}`);
    } else if (message.type === "tool_call") {
      const detail = message.status === "running" ? formatToolArgs(message.args) : formatToolArgs(message.result);
      events.push(`tool_call ${message.name || message.call_id}: ${message.status}${detail ? ` ${detail}` : ""}`);
    } else if (message.type === "status") {
      events.push(`status: ${message.status}${message.message ? ` ${message.message}` : ""}`);
    } else if (message.type === "task") {
      events.push(`task: ${message.status || "update"}${message.text ? ` ${message.text}` : ""}`);
    } else if (message.type === "request") {
      events.push(`request: ${message.request_id}`);
    }
  }

  const result = await run.wait();
  const finalText = result.result || run.result || assistantText;

  return [
    "Cursor Agent Delegation",
    `Model: ${args.model}${args.thinking ? ` (${args.thinking})` : ""}`,
    `Runtime: ${args.runtime}`,
    `Mode: ${args.mode}`,
    `Agent ID: ${agent.agentId || agent.agent_id || run.agentId || run.agent_id || "unknown"}`,
    `Run ID: ${run.id || "unknown"}`,
    `Status: ${result.status || run.status || "unknown"}`,
    "",
    "Events:",
    events.length ? events.map((event) => `- ${event}`).join("\n") : "- No stream events captured.",
    "",
    "Final:",
    finalText || "No final text returned.",
  ].join("\n");
}

async function closeAgents() {
  for (const agent of agents.values()) {
    try {
      await agent.close?.();
    } catch {
      // Ignore close failures during process shutdown.
    }
  }
  agents.clear();
}

function registerShutdown() {
  const shutdown = () => {
    void closeAgents();
  };
  process.once("exit", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export default async function cursorAgentPlugin() {
  registerShutdown();

  return {
    tool: {
      cursor_delegate: tool({
        description:
          "Delegate a coding task to Cursor Agent using Cursor Composer or another Cursor model. Use when the user explicitly asks to use Cursor, Composer, or Cursor Agent for implementation, investigation, or planning.",
        args: {
          prompt: tool.schema.string().describe("Task prompt to send to Cursor Agent."),
          model: tool.schema.string().optional().describe("Cursor model id. Defaults to composer-2.5."),
          thinking: tool.schema.enum(["low", "high"]).optional().describe("Composer thinking level, when supported."),
          mode: tool.schema.enum(["agent", "plan"]).optional().describe("Cursor mode. Defaults to agent."),
          runtime: tool.schema.enum(["local", "cloud"]).optional().describe("Cursor runtime. Defaults to local."),
          cwd: tool.schema.string().optional().describe("Local workspace directory. Defaults to the opencode worktree."),
          sandbox: tool.schema.boolean().optional().describe("Enable Cursor local sandbox when supported."),
          agentId: tool.schema.string().optional().describe("Existing Cursor agent id to resume."),
          repoUrl: tool.schema.string().optional().describe("Cloud runtime repository URL."),
          startingRef: tool.schema.string().optional().describe("Cloud runtime starting ref."),
          autoCreatePR: tool.schema.boolean().optional().describe("Whether cloud runtime should create a PR."),
        },
        async execute(args, context) {
          return runCursorDelegate(args, context);
        },
      }),
    },
  };
}
