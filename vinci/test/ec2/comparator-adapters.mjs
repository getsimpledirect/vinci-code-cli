import assert from "node:assert/strict";

export const COMPARATOR_PROVIDERS = new Set(["codex", "claude"]);

function jsonLines(raw) {
  const events = [];
  const invalid = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      invalid.push(line);
    }
  }
  return { events, invalid };
}

function normalizedUsage(usage = {}) {
  return {
    input: Number(usage.input_tokens ?? usage.input ?? 0),
    output: Number(usage.output_tokens ?? usage.output ?? 0),
    cacheRead: Number(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cache_read ?? 0),
    cacheWrite: Number(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? usage.cache_write ?? 0),
    reasoning: Number(usage.reasoning_output_tokens ?? usage.reasoning_tokens ?? usage.reasoning ?? 0),
    cost: { total: Number(usage.total_cost_usd ?? usage.cost_usd ?? usage.cost?.total ?? 0) },
  };
}

function mergeUsage(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.cost.total += source.cost.total;
}

function messageEvent(text, model, usage, toolCalls = []) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model,
      responseModel: model,
      usage,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls.map(({ id, name, args }) => ({ type: "toolCall", id, name, arguments: args })),
      ],
    },
  };
}

function codexTool(item) {
  if (item?.type === "command_execution") {
    return { name: "bash", args: { command: item.command ?? "" } };
  }
  if (item?.type === "file_change") {
    return { name: "edit", args: { changes: item.changes ?? [] } };
  }
  if (item?.type === "mcp_tool_call") {
    return { name: `${item.server ?? "mcp"}/${item.tool ?? item.name ?? "tool"}`, args: item.arguments ?? {} };
  }
  if (item?.type === "web_search") {
    return { name: "web_search", args: { query: item.query ?? "" } };
  }
  if (item?.type === "dynamic_tool_call") {
    return { name: item.tool ?? item.name ?? "tool", args: item.arguments ?? {} };
  }
  return null;
}

function codexToolError(item) {
  if (item?.type === "command_execution") return Number(item.exit_code ?? 0) !== 0 || item.status === "failed";
  return item?.status === "failed" || Boolean(item?.error);
}

export function normalizeCodexTranscript(raw) {
  const { events, invalid } = jsonLines(raw);
  const normalized = [];
  const started = new Set();
  const models = new Set();
  const totalUsage = normalizedUsage();
  for (const event of events) {
    if (typeof event.model === "string") models.add(event.model);
    const item = event.item;
    if (typeof item?.model === "string") models.add(item.model);
    const id = String(item?.id ?? `${event.type}-${normalized.length}`);
    const tool = codexTool(item);
    if (event.type === "item.started" && tool) {
      normalized.push({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args: tool.args });
      started.add(id);
    }
    if (event.type === "item.completed" && tool) {
      if (!started.has(id)) {
        normalized.push({ type: "tool_execution_start", toolCallId: id, toolName: tool.name, args: tool.args });
      }
      normalized.push({ type: "tool_execution_end", toolCallId: id, toolName: tool.name, isError: codexToolError(item) });
    }
    if (event.type === "item.completed" && item?.type === "agent_message") {
      const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
      normalized.push(messageEvent(text, item.model ?? event.model, normalizedUsage()));
    }
    if (event.type === "turn.completed") mergeUsage(totalUsage, normalizedUsage(event.usage));
  }
  const lastMessage = normalized.findLast((event) => event.type === "message_end");
  if (lastMessage) lastMessage.message.usage = totalUsage;
  const output = [...normalized.map((event) => JSON.stringify(event)), ...invalid].join("\n");
  return {
    jsonl: output ? `${output}\n` : "",
    metadata: {
      format: "codex-jsonl",
      resolvedModels: [...models],
      modelResolution: models.size ? "reported" : "not exposed by Codex JSONL",
      invalidRawLines: invalid.length,
    },
  };
}

function claudeToolName(name) {
  const names = {
    Bash: "bash",
    Edit: "edit",
    MultiEdit: "edit",
    Write: "write",
    Read: "read",
    Glob: "find",
    Grep: "grep",
    WebSearch: "web_search",
    WebFetch: "web_fetch",
  };
  return names[name] ?? name ?? "tool";
}

export function normalizeClaudeTranscript(raw) {
  const { events, invalid } = jsonLines(raw);
  const normalized = [];
  const models = new Set();
  const started = new Map();
  const messages = new Map();
  let resultText = "";
  let resultUsage = normalizedUsage();
  let resultTurns = 0;
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") models.add(event.model);
    if (event.type === "assistant" && event.message) {
      const message = event.message;
      if (typeof message.model === "string") models.add(message.model);
      const blocks = Array.isArray(message.content) ? message.content : [];
      const id = String(message.id ?? event.request_id ?? `message-${messages.size}`);
      let normalizedMessage = messages.get(id);
      if (!normalizedMessage) {
        normalizedMessage = messageEvent("", message.model, normalizedUsage());
        messages.set(id, normalizedMessage);
        normalized.push(normalizedMessage);
      }
      const content = normalizedMessage.message.content;
      for (const block of blocks.filter((candidate) => candidate?.type === "text" && typeof candidate.text === "string")) {
        if (!content.some((part) => part.type === "text" && part.text === block.text)) {
          content.push({ type: "text", text: block.text });
        }
      }
      for (const block of blocks.filter((candidate) => candidate?.type === "tool_use")) {
        const toolId = String(block.id ?? `tool-${normalized.length}`);
        if (started.has(toolId)) continue;
        const tool = { id: toolId, name: claudeToolName(block.name), args: block.input ?? {} };
        started.set(toolId, tool);
        content.push({ type: "toolCall", id: toolId, name: tool.name, arguments: tool.args });
        normalized.push({ type: "tool_execution_start", toolCallId: toolId, toolName: tool.name, args: tool.args });
      }
    }
    if (event.type === "user" && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content.filter((candidate) => candidate?.type === "tool_result")) {
        const id = String(block.tool_use_id ?? "unknown-tool");
        const tool = started.get(id);
        normalized.push({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: tool?.name ?? "tool",
          isError: block.is_error === true,
        });
      }
    }
    if (event.type === "result") {
      if (typeof event.result === "string") resultText = event.result.trim();
      resultUsage = normalizedUsage({ ...event.usage, total_cost_usd: event.total_cost_usd });
      resultTurns = Number.isInteger(event.num_turns) ? event.num_turns : 0;
      if (event.modelUsage && typeof event.modelUsage === "object") {
        for (const model of Object.keys(event.modelUsage)) models.add(model);
      }
    }
  }
  const messageEvents = normalized.filter((event) => event.type === "message_end");
  while (messageEvents.length < resultTurns) {
    const synthetic = messageEvent("", [...models].at(-1), normalizedUsage());
    normalized.push(synthetic);
    messageEvents.push(synthetic);
  }
  if (
    resultText &&
    !messageEvents.some((event) => event.message.content.some((part) => part.type === "text" && part.text === resultText))
  ) {
    const target = messageEvents.at(-1) ?? messageEvent("", [...models].at(-1), normalizedUsage());
    if (!messageEvents.length) {
      normalized.push(target);
      messageEvents.push(target);
    }
    target.message.content.push({ type: "text", text: resultText });
  }
  const usageTarget = messageEvents.at(-1);
  if (usageTarget) usageTarget.message.usage = resultUsage;
  const output = [...normalized.map((event) => JSON.stringify(event)), ...invalid].join("\n");
  return {
    jsonl: output ? `${output}\n` : "",
    metadata: {
      format: "claude-stream-json",
      resolvedModels: [...models],
      modelResolution: "reported by Claude init and result events",
      invalidRawLines: invalid.length,
    },
  };
}

export function normalizeComparatorTranscript(provider, raw) {
  assert.ok(COMPARATOR_PROVIDERS.has(provider), `Unsupported comparator provider: ${provider}`);
  return provider === "codex" ? normalizeCodexTranscript(raw) : normalizeClaudeTranscript(raw);
}

export function comparatorInvocation(provider, checkout, task, environment = process.env) {
  assert.ok(COMPARATOR_PROVIDERS.has(provider), `Unsupported comparator provider: ${provider}`);
  if (provider === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--disable",
        "standalone_web_search",
        "--disable",
        "browser_use",
        "--disable",
        "in_app_browser",
        "--disable",
        "apps",
        "--sandbox",
        "workspace-write",
        "--color",
        "never",
        "--json",
        "--cd",
        checkout,
        task,
      ],
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      configuration: "stock-default-model, ignored user config, workspace-write sandbox, web search disabled",
    };
  }
  return {
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-chrome",
      "--disallowedTools",
      "WebSearch,WebFetch",
      task,
    ],
    env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
    configuration: "stock-default-model, project settings only, acceptEdits permission mode, web tools disabled",
  };
}
