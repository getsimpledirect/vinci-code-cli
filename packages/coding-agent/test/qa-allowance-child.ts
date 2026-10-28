import { QaRequestGuard } from "../src/core/qa-request-allowance.ts";

// Test fixture: independent processes contend for the same final authorization slot.
try {
	new QaRequestGuard(process.argv[2]).reserve("https://qa.invalid");
} catch {
	process.exitCode = 3;
}
