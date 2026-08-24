/**
 * [vinci] Repair double-encoded tool arguments before validation.
 *
 * Observed live (bozza, 2026-07-09): the model composed a COMPLETE, correct multi-part edit —
 * thousands of tokens, every oldText/newText present — but the `edits` array arrived as a JSON
 * *string* ("edits": "\n[{\"oldText\": ...") instead of an array, so validation rejected a
 * perfectly good call on a wrapper technicality, and the model spiraled on the failure. Whether
 * the double-encoding comes from the model or the serving-side tool parser, the harness can fix
 * it mechanically.
 *
 * SCHEMA-AWARE, so legitimate string arguments are never touched: a value is parsed only when the
 * tool's schema says the property is an array/object AND the provided string parses to that exact
 * shape (so `write.content` holding a JSON document stays a string). Array elements are likewise
 * un-stringified only when the schema wants object items. No-op unless VINCI_CODE=1.
 */

type LooseSchema = { type?: string; properties?: Record<string, LooseSchema>; items?: LooseSchema };

function parseIfShape(value: string, want: "array" | "object"): unknown | undefined {
	try {
		const parsed = JSON.parse(value);
		if (want === "array" && Array.isArray(parsed)) return parsed;
		if (want === "object" && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		/* not JSON — leave the string alone */
	}
	return undefined;
}

export function vinciCoerceArguments<T extends Record<string, unknown>>(parameters: unknown, args: T): T {
	if (process.env.VINCI_CODE !== "1") return args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const props = (parameters as LooseSchema | undefined)?.properties;
	if (!props) return args;

	let changed = false;
	const out: Record<string, unknown> = { ...args };
	for (const [key, schema] of Object.entries(props)) {
		const want = schema?.type === "array" ? "array" : schema?.type === "object" ? "object" : undefined;
		const value = out[key];
		if (want && typeof value === "string") {
			const parsed = parseIfShape(value, want);
			if (parsed !== undefined) {
				out[key] = parsed;
				changed = true;
			}
		}
		// A stringified element inside an array whose items should be objects ("edits": ["{...}"]).
		const after = out[key];
		if (Array.isArray(after) && schema?.items?.type === "object") {
			const fixed = after.map((el) => (typeof el === "string" ? (parseIfShape(el, "object") ?? el) : el));
			if (fixed.some((el, i) => el !== after[i])) {
				out[key] = fixed;
				changed = true;
			}
		}
	}
	return changed ? (out as T) : args;
}
