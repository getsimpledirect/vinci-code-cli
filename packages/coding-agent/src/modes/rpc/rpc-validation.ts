// [vinci] Wire v1 mandatory envelope/payload fields. Unknown additive fields are retained.
// This is not validation of provider-specific model metadata or arbitrary extension details.
type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === "string";
const flag: Check = (value) => typeof value === "boolean";
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const optional =
	(check: Check): Check =>
	(value) =>
		value === undefined || check(value);
const nullable =
	(check: Check): Check =>
	(value) =>
		value === null || check(value);
const list =
	(check: Check): Check =>
	(value) =>
		Array.isArray(value) && value.every(check);
const fields = (value: unknown, required: Record<string, Check>): boolean =>
	object(value) && Object.entries(required).every(([key, check]) => check(value[key]));
const level: Check = (value) =>
	typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
const mode: Check = (value) => value === "all" || value === "one-at-a-time";
const message: Check = (value) => fields(value, { role: text });
const model: Check = (value) => fields(value, { provider: text, id: text, contextWindow: number, reasoning: flag });
const compaction: Check = (value) => fields(value, { summary: text, firstKeptEntryId: text, tokensBefore: number });
const entry: Check = (value) => fields(value, { id: text, type: text });
const reason: Check = (value) => value === "manual" || value === "threshold" || value === "overflow";

export function validRpcData(command: string, data: unknown): boolean {
	switch (command) {
		case "get_protocol":
			return fields(data, { version: number });
		case "prompt":
		case "steer":
		case "follow_up":
		case "abort":
		case "set_thinking_level":
		case "set_steering_mode":
		case "set_follow_up_mode":
		case "set_auto_compaction":
		case "set_auto_retry":
		case "abort_retry":
		case "abort_bash":
		case "set_session_name":
			return true;
		case "new_session":
		case "switch_session":
		case "clone":
			return fields(data, { cancelled: flag });
		case "fork":
			return (
				object(data) && fields(data, { cancelled: flag, text: data.cancelled === true ? optional(text) : text })
			);
		case "get_state":
			return fields(data, {
				sessionId: text,
				thinkingLevel: level,
				isStreaming: flag,
				isCompacting: flag,
				steeringMode: mode,
				followUpMode: mode,
				autoCompactionEnabled: flag,
				messageCount: number,
				pendingMessageCount: number,
				model: optional(model),
				sessionFile: optional(text),
				sessionName: optional(text),
			});
		case "set_model":
			return model(data);
		case "cycle_model":
			return data === null || fields(data, { model, thinkingLevel: level, isScoped: flag });
		case "get_available_models":
			return fields(data, { models: list(model) });
		case "cycle_thinking_level":
			return data === null || fields(data, { level });
		case "compact":
			return compaction(data);
		case "bash":
			return fields(data, {
				output: text,
				cancelled: flag,
				truncated: flag,
				exitCode: optional(number),
				fullOutputPath: optional(text),
			});
		case "get_session_stats":
			return fields(data, {
				sessionFile: optional(text),
				sessionId: text,
				userMessages: number,
				assistantMessages: number,
				toolCalls: number,
				toolResults: number,
				totalMessages: number,
				cost: number,
				tokens: (value) =>
					fields(value, { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }),
			});
		case "export_html":
			return fields(data, { path: text });
		case "get_fork_messages":
			return fields(data, { messages: list((value) => fields(value, { entryId: text, text })) });
		case "get_entries":
			return fields(data, { entries: list(entry), leafId: nullable(text) });
		case "get_tree":
			return fields(data, {
				tree: list((value) => fields(value, { entry, children: Array.isArray })),
				leafId: nullable(text),
			});
		case "get_last_assistant_text":
			return fields(data, { text: nullable(text) });
		case "get_messages":
			return fields(data, { messages: list(message) });
		case "get_commands":
			return fields(data, {
				commands: list((value) =>
					fields(value, {
						name: text,
						description: optional(text),
						source: (source) => source === "extension" || source === "prompt" || source === "skill",
						sourceInfo: object,
					}),
				),
			});
		default:
			return false;
	}
}

export function validRpcEvent(value: Record<string, unknown>): boolean {
	switch (value.type) {
		case "agent_start":
		case "turn_start":
			return true;
		case "agent_end":
			return fields(value, { messages: list(message), willRetry: optional(flag) });
		case "turn_end":
			return fields(value, { message, toolResults: list(message) });
		case "message_start":
		case "message_end":
			return fields(value, { message });
		case "message_update":
			return fields(value, { message, assistantMessageEvent: object });
		case "tool_hooks_start":
			return fields(value, { toolCallId: text, toolName: text });
		case "tool_execution_start":
			return fields(value, { toolCallId: text, toolName: text }) && "args" in value;
		case "tool_execution_update":
			return fields(value, { toolCallId: text, toolName: text }) && "args" in value && "partialResult" in value;
		case "tool_execution_end":
			return fields(value, { toolCallId: text, toolName: text, isError: flag }) && "result" in value;
		case "queue_update":
			return fields(value, { steering: list(text), followUp: list(text) });
		case "compaction_start":
			return fields(value, { reason, tokens: optional(number) });
		case "compaction_end":
			return fields(value, {
				reason,
				result: optional(compaction),
				aborted: flag,
				willRetry: flag,
				errorMessage: optional(text),
			});
		case "entry_appended":
			return fields(value, { entry });
		case "session_info_changed":
			return fields(value, { name: optional(text) });
		case "thinking_level_changed":
			return fields(value, { level });
		case "auto_retry_start":
			return fields(value, { attempt: number, maxAttempts: number, delayMs: number, errorMessage: text });
		case "auto_retry_end":
			return fields(value, { success: flag, attempt: number, finalError: optional(text) });
		case "extension_error":
			return fields(value, { extensionPath: text, event: text, error: text });
		default:
			return false;
	}
}
