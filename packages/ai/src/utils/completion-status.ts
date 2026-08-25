import type { AssistantMessage } from "../types.ts";

/**
 * Classification of a completion result, detecting error conditions:
 * - Error or aborted stop reason
 * - Empty or whitespace-only content
 */
export interface CompletionStatus {
	ok: boolean;
	text?: string;
	error?: string;
}

export function classifyCompletionResult(response: AssistantMessage): CompletionStatus {
	// Check for error stop reasons
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			ok: false,
			error: response.errorMessage || `Completion ${response.stopReason}`,
		};
	}

	// Extract and check text content
	const text = extractTextContent(response);
	if (!text || !text.trim()) {
		return {
			ok: false,
			error: "Completion returned empty content",
		};
	}

	return { ok: true, text };
}

function extractTextContent(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}
