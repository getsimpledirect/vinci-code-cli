import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';

describe("provider retry classification", () => {
	it.each([
		"Unable to forward upstream stream",
		"The service is temporarily unavailable",
		"service is unavailable",
		"Service temporarily unavailable",
		"Service unavailable: The service is temporarily unavailable.",
		// Vinci's own reduced-limit retry message (vinci-provider.ts) must stay retryable even when the
		// affordable token count happens to be 401/402.
		"OpenRouter can serve this request with max_tokens=402; please retry your request once on this same model with the reduced limit.",
		"OpenRouter can serve this request with max_tokens=401; please retry your request once on this same model with the reduced limit.",
	])("matches gateway transient wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		"401 Unauthorized: unable to forward upstream stream",
		"403 Forbidden: The service is temporarily unavailable",
		"invalid_api_key: The service is temporarily unavailable",
		"402 payment_failed: service is temporarily unavailable",
		"402 Payment Required: unable to forward upstream stream",
		"balance_exhausted: The service is temporarily unavailable",
		"billing: unable to forward upstream stream",
		"insufficient_quota: unable to forward upstream stream",
		"out of budget: The service is temporarily unavailable",
		"quota exceeded: unable to forward upstream stream",
		"free_daily_cap: unable to forward upstream stream",
		"request_too_large: The service is temporarily unavailable",
		"refusal: unable to forward upstream stream",
	])("keeps terminal errors non-retryable despite transient wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each(["stop", "aborted", "toolUse", "length"] as const)(
		"does not retry transient wording with stop reason %s",
		(stopReason) => {
			expect(
				isRetryableAssistantError(
					fauxAssistantMessage("", { stopReason, errorMessage: "Unable to forward upstream stream" }),
				),
			).toBe(false);
		},
	);

	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("does not retry Vinci daily-cap or payment failures", () => {
		for (const code of ["free_daily_cap", "payment_failed"]) {
			expect(
				isRetryableAssistantError(
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: `429: {"error":{"code":"${code}"}}`,
					}),
				),
			).toBe(false);
		}
	});

	it("keeps Vinci capacity failures retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: '429: {"error":{"code":"capacity"}}',
				}),
			),
		).toBe(true);
	});

	it.each([
		"No API provider registered for api: faux:1731562502123:x7k2",
		"No API provider registered for api: faux:1731564290000:abc",
		"Model not found: request id req_5031af",
		"Invalid tool arguments in call call_42900",
		"Unknown model gpt-5240",
		"Context too long: 15029 tokens over the limit",
		"Bad request after 0.429 s",
		"Invalid schema: value 502.7 is out of range",
		"Invalid request: field limit is 5000",
	])("does not treat a status-code digit run inside other text as retryable: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"429",
		"HTTP 429",
		"status 429: slow down",
		"Error: 500 Internal Server Error",
		"502 Bad Gateway",
		"HTTP/1.1 503",
		"upstream returned 503.",
		'{"status":504}',
		"status=502",
		"524 status code (no body)",
		"(503)",
	])("treats a standalone status code as retryable: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});
