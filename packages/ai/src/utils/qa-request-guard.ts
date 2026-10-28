import type { Api, Model } from "../types.ts";

export interface QaRequestGuardBridge {
	assertModel(model: { provider: string; api: string; id: string; baseUrl: string }): void;
	close(reason: "completed" | "revoked"): void;
}

/** The CLI arms this bridge before providers load. Browser consumers remain unaffected. */
export function assertQaModelAllowed(model: Model<Api>): void {
	const bridge = (globalThis as typeof globalThis & { __vinciQaRequestGuard?: QaRequestGuardBridge })
		.__vinciQaRequestGuard;
	if (bridge) bridge.assertModel(model);
	else if (typeof process !== "undefined" && process.env.VINCI_QA_ALLOWANCE_FILE !== undefined) {
		throw new Error("BLOCKED: QA allowance requested but the managed HTTP guard is not armed.");
	}
}
