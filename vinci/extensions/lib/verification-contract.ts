/**
 * The verification-state contract and parser, shared by the vinci extension layer and the
 * coding-agent core.
 *
 * It lives HERE, inside vinci/, because vinci/extensions/lib/verification-state.ts imports it at
 * RUNTIME and the release tarball ships only vinci/ plus each package's built dist. 0.0.31 shipped unusable
 * because this code lived in packages/coding-agent/src, which is not packaged: the extension
 * failed to load and the CLI died at startup, behind a green harness, two green CI legs and a
 * green 50-run campaign — every one of which runs from the repo, where that path resolves.
 *
 * Shipping a fragment of packages/coding-agent/src instead is NOT a fix: config.js picks
 * `existsSync(packageDir/src) ? "src" : "dist"`, so the presence of any src/ directory redirects
 * theme and template lookups to a tree the tarball does not contain.
 */

import { isAbsolute } from "node:path";

export const VINCI_VERIFICATION_ENTRY = "vinci-verification-state";

/** Branch entries are message/compaction/etc.; task context uses only real conversation messages. */
type BranchEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

export const VINCI_VERIFICATION_SCHEMA_VERSION = 1;
export const VINCI_CORRUPTED_VERIFICATION_MESSAGE =
	"The verification state was unreadable and could not be re-established, so this task is not verified. Run it yourself to confirm it works.";
export const VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE =
	"The verification state was readable, but the failed check could not be replayed safely, so this task is not verified. Run the exact recorded command yourself; a successful run will clear this state.";
export const VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE =
	"The verification state was readable, but its failed check command was not retained, so this task is not verified. Give a new instruction to start fresh, then run the project check again.";
export const VINCI_TERMINAL_UNVERIFIABLE_MESSAGE = VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE;

export type SharedVinciVerificationStatus = "none" | "stale" | "failed" | "passed";
export type SharedVinciVerificationClass = "static" | "build" | "behavioral";

export type RemoteAcceptanceVerdict = {
	schemaVersion: 1;
	jobId: string;
	snapshotDigest: string;
	status: "VERIFIED_PASS" | "BLOCKED" | "CONDITIONAL" | "FAILED" | "CANCELLED";
	summary: string;
	reportUrl?: string;
	eventCursor?: string;
	recordedAtIso: string;
	staled: boolean;
};

export type RemoteAcceptanceVerdictRecord = Readonly<Record<string, RemoteAcceptanceVerdict>>;

export function remoteAcceptanceVerdictKey(
	verdict: Pick<RemoteAcceptanceVerdict, "snapshotDigest" | "jobId">,
): string {
	return JSON.stringify([verdict.snapshotDigest, verdict.jobId]);
}

export type SharedVinciNormalVerificationState = {
	schemaVersion: typeof VINCI_VERIFICATION_SCHEMA_VERSION;
	variant: "normal";
	status: SharedVinciVerificationStatus;
	command: string;
	summary: string;
	requiredCommand: string;
	requiredSummary: string;
	mutationRevision: number;
	verifiedRevision: number;
	recoveryAttempts: number;
	behavioralEvidenceRequired: boolean;
	behavioralEvidenceReason: string;
	behavioralVerifiedRevision: number;
	diffInspectedRevision: number;
	/** The last mutationRevision whose recorder KNEW the change warranted a project check (#187).
	 *  -1 (or absent, on states persisted by older builds) means no such fact was recorded —
	 *  readers must treat that as unknown, never as "no check was needed". */
	checkWarrantedRevision?: number;
	checkClass: SharedVinciVerificationClass;
	commandKey: string;
	commandCwd?: string;
	requiredCommandKey: string;
	commandKeyCanonical: boolean;
	isReplayable: boolean;
	behavioralAttemptCommand: string;
	behavioralAttemptCommandKey: string;
	behavioralAttemptCommandKeyCanonical: boolean;
	behavioralAttemptCompleted: boolean;
	remoteAcceptanceVerdicts?: RemoteAcceptanceVerdictRecord;
};

export type SharedVinciTerminalUnverifiableState = {
	schemaVersion: typeof VINCI_VERIFICATION_SCHEMA_VERSION;
	variant: "terminal-unverifiable";
	status: "failed";
	summary:
		| typeof VINCI_CORRUPTED_VERIFICATION_MESSAGE
		| typeof VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE
		| typeof VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE;
	mutationRevision: number;
	command: string;
	commandKey: string;
	checkClass: SharedVinciVerificationClass;
	remoteAcceptanceVerdicts?: RemoteAcceptanceVerdictRecord;
};

export type SharedVinciVerificationState = SharedVinciNormalVerificationState | SharedVinciTerminalUnverifiableState;

const NORMAL_KEYS = new Set([
	"schemaVersion",
	"variant",
	"status",
	"command",
	"summary",
	"requiredCommand",
	"requiredSummary",
	"mutationRevision",
	"verifiedRevision",
	"recoveryAttempts",
	"behavioralEvidenceRequired",
	"behavioralEvidenceReason",
	"behavioralVerifiedRevision",
	"diffInspectedRevision",
	"checkWarrantedRevision",
	"checkClass",
	"commandKey",
	"commandCwd",
	"requiredCommandKey",
	"commandKeyCanonical",
	"isReplayable",
	"behavioralAttemptCommand",
	"behavioralAttemptCommandKey",
	"behavioralAttemptCommandKeyCanonical",
	"behavioralAttemptCompleted",
	"remoteAcceptanceVerdicts",
]);
const LEGACY_REQUIRED_KEYS = ["status", "command", "summary", "mutationRevision", "verifiedRevision"] as const;
const LEGACY_OPTIONAL_KEYS = new Set([
	"requiredCommand",
	"requiredSummary",
	"recoveryAttempts",
	"behavioralEvidenceRequired",
	"behavioralEvidenceReason",
	"behavioralVerifiedRevision",
	"diffInspectedRevision",
	"checkClass",
	"commandKey",
	"requiredCommandKey",
	"isReplayable",
	"behavioralAttemptCommand",
	"behavioralAttemptCompleted",
]);

function verificationRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function hasOnlyKeys(data: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(data).every((key) => keys.has(key));
}

function isRevision(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= minimum;
}

function isVerificationClass(value: unknown): value is SharedVinciVerificationClass {
	return value === "static" || value === "build" || value === "behavioral";
}

const REMOTE_ACCEPTANCE_VERDICT_KEYS = new Set([
	"schemaVersion",
	"jobId",
	"snapshotDigest",
	"status",
	"summary",
	"reportUrl",
	"eventCursor",
	"recordedAtIso",
	"staled",
]);

function parseRemoteAcceptanceVerdict(value: unknown): RemoteAcceptanceVerdict | undefined {
	const verdict = verificationRecord(value);
	if (
		!verdict ||
		!hasOnlyKeys(verdict, REMOTE_ACCEPTANCE_VERDICT_KEYS) ||
		verdict.schemaVersion !== 1 ||
		typeof verdict.jobId !== "string" ||
		typeof verdict.snapshotDigest !== "string" ||
		(verdict.status !== "VERIFIED_PASS" &&
			verdict.status !== "BLOCKED" &&
			verdict.status !== "CONDITIONAL" &&
			verdict.status !== "FAILED" &&
			verdict.status !== "CANCELLED") ||
		typeof verdict.summary !== "string" ||
		(verdict.reportUrl !== undefined && typeof verdict.reportUrl !== "string") ||
		(verdict.eventCursor !== undefined && typeof verdict.eventCursor !== "string") ||
		typeof verdict.recordedAtIso !== "string" ||
		typeof verdict.staled !== "boolean"
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		jobId: verdict.jobId,
		snapshotDigest: verdict.snapshotDigest,
		status: verdict.status,
		summary: verdict.summary,
		...(verdict.reportUrl !== undefined ? { reportUrl: verdict.reportUrl } : {}),
		...(verdict.eventCursor !== undefined ? { eventCursor: verdict.eventCursor } : {}),
		recordedAtIso: verdict.recordedAtIso,
		staled: verdict.staled,
	};
}

function parseRemoteAcceptanceVerdictRecord(value: unknown): RemoteAcceptanceVerdictRecord | undefined {
	const record = verificationRecord(value);
	if (!record) return undefined;
	const parsed: Record<string, RemoteAcceptanceVerdict> = {};
	for (const [key, value] of Object.entries(record)) {
		const verdict = parseRemoteAcceptanceVerdict(value);
		if (!verdict || key !== remoteAcceptanceVerdictKey(verdict)) return undefined;
		parsed[key] = verdict;
	}
	return parsed;
}

function normalizedNormalState(
	data: Record<string, unknown>,
	legacy: boolean,
): SharedVinciNormalVerificationState | undefined {
	const hasCommandCwd = Object.hasOwn(data, "commandCwd");
	const hasRemoteAcceptanceVerdicts = Object.hasOwn(data, "remoteAcceptanceVerdicts");
	const remoteAcceptanceVerdicts = hasRemoteAcceptanceVerdicts
		? parseRemoteAcceptanceVerdictRecord(data.remoteAcceptanceVerdicts)
		: undefined;
	if (
		(data.status !== "none" && data.status !== "stale" && data.status !== "failed" && data.status !== "passed") ||
		typeof data.command !== "string" ||
		typeof data.summary !== "string" ||
		(!legacy && typeof data.requiredCommand !== "string") ||
		(legacy && data.requiredCommand !== undefined && typeof data.requiredCommand !== "string") ||
		(!legacy && typeof data.requiredSummary !== "string") ||
		(legacy && data.requiredSummary !== undefined && typeof data.requiredSummary !== "string") ||
		!isRevision(data.mutationRevision, 0) ||
		!isRevision(data.verifiedRevision, -1) ||
		(!legacy && !isRevision(data.recoveryAttempts, 0)) ||
		(legacy && data.recoveryAttempts !== undefined && !isRevision(data.recoveryAttempts, 0)) ||
		(!legacy && typeof data.behavioralEvidenceRequired !== "boolean") ||
		(legacy &&
			data.behavioralEvidenceRequired !== undefined &&
			typeof data.behavioralEvidenceRequired !== "boolean") ||
		(!legacy && typeof data.behavioralEvidenceReason !== "string") ||
		(legacy && data.behavioralEvidenceReason !== undefined && typeof data.behavioralEvidenceReason !== "string") ||
		(!legacy && !isRevision(data.behavioralVerifiedRevision, -1)) ||
		(legacy && data.behavioralVerifiedRevision !== undefined && !isRevision(data.behavioralVerifiedRevision, -1)) ||
		(!legacy && !isRevision(data.diffInspectedRevision, -1)) ||
		(legacy && data.diffInspectedRevision !== undefined && !isRevision(data.diffInspectedRevision, -1)) ||
		// checkWarrantedRevision is optional in BOTH shapes (#187): states persisted before the
		// field existed must keep restoring, and absence reads as "unknown", never "unneeded".
		(data.checkWarrantedRevision !== undefined && !isRevision(data.checkWarrantedRevision, -1)) ||
		(!legacy && !isVerificationClass(data.checkClass)) ||
		(legacy && data.checkClass !== undefined && !isVerificationClass(data.checkClass)) ||
		(!legacy && typeof data.commandKey !== "string") ||
		(legacy && data.commandKey !== undefined && typeof data.commandKey !== "string") ||
		// A commandCwd on a leading-`cd` command is unreachable from any RECORD path (the extension's
		// workingDirectoryCommand parse supplies the directory textually and records no cwd), so it can
		// only be corrupt or hand-built state — and such an entry could never clear (Guarantees 6 + 8).
		// Conservative mirror of that parse: any command starting with `cd ` never carries commandCwd.
		(hasCommandCwd &&
			(typeof data.commandCwd !== "string" ||
				!isAbsolute(data.commandCwd) ||
				(typeof data.command === "string" && /^\s*cd\s/.test(data.command)))) ||
		(!legacy && typeof data.requiredCommandKey !== "string") ||
		(legacy && data.requiredCommandKey !== undefined && typeof data.requiredCommandKey !== "string") ||
		(!legacy && typeof data.commandKeyCanonical !== "boolean") ||
		(!legacy && typeof data.isReplayable !== "boolean") ||
		(legacy && data.isReplayable !== undefined && typeof data.isReplayable !== "boolean") ||
		(!legacy && typeof data.behavioralAttemptCommand !== "string") ||
		(legacy && data.behavioralAttemptCommand !== undefined && typeof data.behavioralAttemptCommand !== "string") ||
		(!legacy && typeof data.behavioralAttemptCommandKey !== "string") ||
		(!legacy && typeof data.behavioralAttemptCommandKeyCanonical !== "boolean") ||
		(!legacy && typeof data.behavioralAttemptCompleted !== "boolean") ||
		(legacy && data.behavioralAttemptCompleted !== undefined && typeof data.behavioralAttemptCompleted !== "boolean") ||
		(hasRemoteAcceptanceVerdicts && remoteAcceptanceVerdicts === undefined)
	) {
		return undefined;
	}

	const command = data.command;
	const commandKeyProvided = typeof data.commandKey === "string" && data.commandKey.length > 0;
	const commandKey = command ? (commandKeyProvided ? (data.commandKey as string) : command) : "";
	const legacyFailure = legacy && data.status === "failed" && Boolean(command);
	const requiredCommand = legacyFailure
		? command
		: typeof data.requiredCommand === "string"
			? data.requiredCommand
			: "";
	const requiredCommandKeyProvided = typeof data.requiredCommandKey === "string" && data.requiredCommandKey.length > 0;
	const requiredCommandKey = legacyFailure
		? commandKey
		: requiredCommand
			? requiredCommandKeyProvided
				? (data.requiredCommandKey as string)
				: requiredCommand === command
					? commandKey
					: requiredCommand
			: "";
	const behavioralAttemptCommand =
		typeof data.behavioralAttemptCommand === "string" ? data.behavioralAttemptCommand : "";
	const behavioralAttemptCommandKey =
		typeof data.behavioralAttemptCommandKey === "string" && data.behavioralAttemptCommandKey
			? data.behavioralAttemptCommandKey
			: behavioralAttemptCommand === command
				? commandKey
				: "";
	const state: SharedVinciNormalVerificationState = {
		schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
		variant: "normal",
		status: data.status,
		command,
		summary: data.summary,
		requiredCommand,
		requiredSummary: legacyFailure
			? data.summary
			: typeof data.requiredSummary === "string"
				? data.requiredSummary
				: "",
		mutationRevision: data.mutationRevision,
		verifiedRevision: data.verifiedRevision,
		recoveryAttempts: typeof data.recoveryAttempts === "number" ? data.recoveryAttempts : 0,
		behavioralEvidenceRequired:
			typeof data.behavioralEvidenceRequired === "boolean" ? data.behavioralEvidenceRequired : false,
		behavioralEvidenceReason: typeof data.behavioralEvidenceReason === "string" ? data.behavioralEvidenceReason : "",
		behavioralVerifiedRevision:
			typeof data.behavioralVerifiedRevision === "number" ? data.behavioralVerifiedRevision : -1,
		diffInspectedRevision: typeof data.diffInspectedRevision === "number" ? data.diffInspectedRevision : -1,
		// Clamped to the same cross-field discipline as the sibling revisions (#205 review): a
		// warranted revision AHEAD of the mutation counter can only come from a corrupted or
		// hand-built entry, and reading it as "warranted" would mint the affirmative claim from
		// garbage. Out of range degrades to unknown.
		checkWarrantedRevision:
			typeof data.checkWarrantedRevision === "number" &&
			data.checkWarrantedRevision <= (typeof data.mutationRevision === "number" ? data.mutationRevision : 0)
				? data.checkWarrantedRevision
				: -1,
		checkClass: isVerificationClass(data.checkClass) ? data.checkClass : "static",
		commandKey,
		...(hasCommandCwd ? { commandCwd: data.commandCwd as string } : {}),
		requiredCommandKey,
		commandKeyCanonical: legacy
			? commandKeyProvided || canonicalVerificationCommandKey(command) === commandKey
			: (data.commandKeyCanonical as boolean),
		isReplayable: typeof data.isReplayable === "boolean" ? data.isReplayable : true,
		behavioralAttemptCommand,
		behavioralAttemptCommandKey,
		behavioralAttemptCommandKeyCanonical: legacy
			? behavioralAttemptCommand === command && commandKeyProvided
			: (data.behavioralAttemptCommandKeyCanonical as boolean),
		behavioralAttemptCompleted:
			typeof data.behavioralAttemptCompleted === "boolean" ? data.behavioralAttemptCompleted : true,
		...(remoteAcceptanceVerdicts ? { remoteAcceptanceVerdicts } : {}),
	};

	const commandPairValid = Boolean(state.command) === Boolean(state.commandKey);
	const requiredPairValid = Boolean(state.requiredCommand) === Boolean(state.requiredCommandKey);
	const attemptPairValid = Boolean(state.behavioralAttemptCommand) === Boolean(state.behavioralAttemptCommandKey);
	const revisionsValid =
		state.verifiedRevision <= state.mutationRevision &&
		state.behavioralVerifiedRevision <= state.mutationRevision &&
		state.diffInspectedRevision <= state.mutationRevision;
	const evidenceReasonValid = state.behavioralEvidenceRequired === Boolean(state.behavioralEvidenceReason);
	if (
		!commandPairValid ||
		!requiredPairValid ||
		!attemptPairValid ||
		(!state.command && state.commandCwd !== undefined) ||
		!revisionsValid ||
		!evidenceReasonValid ||
		(!state.behavioralAttemptCommand && !state.behavioralAttemptCompleted) ||
		(state.behavioralAttemptCommand &&
			state.behavioralAttemptCompleted &&
			state.checkClass !== "behavioral" &&
			state.behavioralAttemptCommand !== state.command)
	) {
		return undefined;
	}
	if (state.status === "none") {
		return state.mutationRevision === 0 &&
			state.verifiedRevision === -1 &&
			!state.command &&
			!state.summary &&
			!state.requiredCommand &&
			!state.behavioralEvidenceRequired &&
			!state.behavioralAttemptCommand
			? state
			: undefined;
	}
	if (state.status === "passed") {
		return state.command &&
			!state.requiredCommand &&
			!state.requiredSummary &&
			state.verifiedRevision === state.mutationRevision &&
			(!state.behavioralEvidenceRequired ||
				(state.behavioralVerifiedRevision === state.mutationRevision &&
					state.diffInspectedRevision === state.mutationRevision))
			? state
			: undefined;
	}
	if (state.status === "stale") {
		return state.verifiedRevision !== state.mutationRevision ||
			(state.behavioralEvidenceRequired &&
				(state.behavioralVerifiedRevision !== state.mutationRevision ||
					state.diffInspectedRevision !== state.mutationRevision))
			? state
			: undefined;
	}
	if (!state.command) {
		return !state.requiredCommand && !state.requiredSummary ? state : undefined;
	}
	const canonicalCommandKey = canonicalVerificationCommandKey(state.command);
	// A replayable CHAIN has no canonical argv key and cannot be auto-replayed, but it is still
	// nameable and re-runnable, so it is clearable and must survive restore rather than terminalizing
	// (#66). Every other guarantee is unchanged: the key must be exactly the chain's own identity,
	// and required* must agree with command/key, so no narrower invocation can resolve it.
	// `commandKeyCanonical` is true here — a chain records an explicit key — so the distinguishing
	// facts are that there is no single-argv canonical key and the chain cannot be auto-replayed.
	if (canonicalCommandKey === undefined && !state.isReplayable) {
		if (!isReplayableChainCommand(state.command)) return undefined;
		return state.commandKey === replayableChainVerificationKey(state.command) &&
			state.requiredCommand === state.command &&
			state.requiredCommandKey === state.commandKey &&
			Boolean(state.requiredSummary)
			? state
			: undefined;
	}
	return state.commandKeyCanonical &&
		state.isReplayable &&
		canonicalCommandKey !== undefined &&
		state.commandKey === canonicalCommandKey &&
		state.requiredCommand === state.command &&
		state.requiredCommandKey === state.commandKey &&
		Boolean(state.requiredSummary)
		? state
		: undefined;
}

export function parseSharedVinciVerificationState(value: unknown): SharedVinciVerificationState | undefined {
	const data = verificationRecord(value);
	if (!data) return undefined;
	if (data.variant === undefined && data.schemaVersion === undefined) {
		const legacyKeys = new Set([...LEGACY_REQUIRED_KEYS, ...LEGACY_OPTIONAL_KEYS]);
		if (!hasOnlyKeys(data, legacyKeys) || LEGACY_REQUIRED_KEYS.some((key) => !(key in data))) return undefined;
		return normalizedNormalState(data, true);
	}
	if (data.schemaVersion !== VINCI_VERIFICATION_SCHEMA_VERSION) return undefined;
	if (data.variant === "normal") {
		return hasOnlyKeys(data, NORMAL_KEYS) ? normalizedNormalState(data, false) : undefined;
	}
	if (data.variant === "terminal-unverifiable") {
		const legacyCorruptedMessage =
			"The verification state was unreadable and could not be re-established, so this task is not verified. Run it yourself to confirm it works.";
		const legacyUnreplayableMessage =
			"The verification state was readable, but the failed check could not be replayed safely, so this task is not verified. Run that check yourself to confirm the result.";
		const keys = new Set([
			"schemaVersion",
			"variant",
			"status",
			"summary",
			"mutationRevision",
			"command",
			"commandKey",
			"checkClass",
			"remoteAcceptanceVerdicts",
		]);
		const hasRemoteAcceptanceVerdicts = Object.hasOwn(data, "remoteAcceptanceVerdicts");
		const remoteAcceptanceVerdicts = hasRemoteAcceptanceVerdicts
			? parseRemoteAcceptanceVerdictRecord(data.remoteAcceptanceVerdicts)
			: undefined;
		const hasCommandFields = "command" in data || "commandKey" in data || "checkClass" in data;
		const summary =
			data.summary === VINCI_CORRUPTED_VERIFICATION_MESSAGE || data.summary === legacyCorruptedMessage
				? VINCI_CORRUPTED_VERIFICATION_MESSAGE
				: data.summary === VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE
					? VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE
					: data.summary === VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE ||
							data.summary === legacyUnreplayableMessage
						? VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE
						: undefined;
		const command = hasCommandFields && typeof data.command === "string" ? data.command : "";
		const commandKey = hasCommandFields && typeof data.commandKey === "string" ? data.commandKey : "";
		const checkClass =
			hasCommandFields && isVerificationClass(data.checkClass) ? data.checkClass : ("behavioral" as const);
		const commandFieldsValid =
			!hasCommandFields ||
			(typeof data.command === "string" &&
				typeof data.commandKey === "string" &&
				isVerificationClass(data.checkClass) &&
				Boolean(command) === Boolean(commandKey));
		const causeValid =
			summary === VINCI_UNREPLAYABLE_VERIFICATION_MESSAGE
				? Boolean(command)
				: summary === VINCI_CORRUPTED_VERIFICATION_MESSAGE || summary === VINCI_UNREPLAYABLE_WITHOUT_COMMAND_MESSAGE
					? !command
					: false;
		if (
			!hasOnlyKeys(data, keys) ||
			data.status !== "failed" ||
			!summary ||
			!isRevision(data.mutationRevision, 0) ||
			(hasRemoteAcceptanceVerdicts && remoteAcceptanceVerdicts === undefined) ||
			!commandFieldsValid ||
			!causeValid
		) {
			return undefined;
		}
		return {
			schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
			variant: "terminal-unverifiable",
			status: "failed",
			summary,
			mutationRevision: data.mutationRevision,
			command,
			commandKey,
			checkClass,
			...(remoteAcceptanceVerdicts ? { remoteAcceptanceVerdicts } : {}),
		};
	}
	return undefined;
}

type SharedCommandWord = {
	kind: "word";
	raw: string;
	value: string;
	hasShellContext: boolean;
	start: number;
	end: number;
};

type SharedCommandOperator = {
	kind: "operator";
	value: "&&" | "||" | "|" | ";" | "&";
	start: number;
	end: number;
};

type SharedCommandToken = SharedCommandWord | SharedCommandOperator;

function sharedCommandTokens(command: string): SharedCommandToken[] | undefined {
	const tokens: SharedCommandToken[] = [];
	let wordStart = -1;
	let value = "";
	let hasShellContext = false;
	let quote: "'" | '"' | undefined;

	const startWord = (index: number) => {
		if (wordStart === -1) wordStart = index;
	};
	const finishWord = (end: number) => {
		if (wordStart === -1) return;
		tokens.push({
			kind: "word",
			raw: command.slice(wordStart, end),
			value,
			hasShellContext,
			start: wordStart,
			end,
		});
		wordStart = -1;
		value = "";
		hasShellContext = false;
	};
	const pushOperator = (value: SharedCommandOperator["value"], start: number, width: number) => {
		finishWord(start);
		tokens.push({ kind: "operator", value, start, end: start + width });
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			if (character === "\\" && quote === '"') {
				if (index + 1 >= command.length) return undefined;
				const escaped = command[++index];
				if (escaped === "\n") continue;
				value += /[$`"\\]/.test(escaped) ? escaped : `\\${escaped}`;
				continue;
			}
			if (quote === '"' && (character === "$" || character === "`")) hasShellContext = true;
			value += character;
			continue;
		}
		if (character === "'" || character === '"') {
			startWord(index);
			quote = character;
			continue;
		}
		if (character === "\\") {
			const escapeStart = index;
			if (index + 1 >= command.length) return undefined;
			const escaped = command[++index];
			if (escaped === "\n") continue;
			startWord(escapeStart);
			value += escaped;
			continue;
		}
		if (character === "\n") {
			finishWord(index);
			pushOperator(";", index, 1);
			continue;
		}
		if (/\s/.test(character)) {
			finishWord(index);
			continue;
		}
		if (character === ";") {
			pushOperator(";", index, 1);
			continue;
		}
		if (character === "|") {
			const width = command[index + 1] === "|" ? 2 : 1;
			pushOperator(width === 2 ? "||" : "|", index, width);
			index += width - 1;
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			pushOperator("&&", index, 2);
			index++;
			continue;
		}
		if (character === "&" && command[index - 1] !== ">" && command[index + 1] !== ">") {
			pushOperator("&", index, 1);
			continue;
		}
		startWord(index);
		if (
			character === "$" ||
			character === "`" ||
			character === "<" ||
			character === ">" ||
			character === "(" ||
			character === ")" ||
			character === "*" ||
			character === "?" ||
			character === "[" ||
			character === "]" ||
			character === "{" ||
			character === "}" ||
			(character === "~" && value.length === 0)
		) {
			hasShellContext = true;
		}
		value += character;
	}
	if (quote) return undefined;
	finishWord(command.length);
	return tokens;
}

function stripSharedTrailingFdRedirect(command: string): string {
	const tokens = sharedCommandTokens(command);
	const words = tokens?.filter((token): token is SharedCommandWord => token.kind === "word") ?? [];
	const last = tokens?.at(-1);
	if (words.length >= 2 && last?.kind === "word" && /^[12]?>&[12]$/.test(last.raw)) {
		return command.slice(0, last.start).trimEnd();
	}
	return command;
}

/**
 * A compound is replayable AS A WHOLE when re-running it verbatim proves exactly what the original
 * run proved. That is a different question from whether the system can build an argv to auto-replay
 * it (`isReplayable`): a multi-segment chain answers no to the second and yes to the first.
 *
 * Narrowing to ONE segment of an `&&` chain is the unsafe move — short-circuiting means a later
 * segment may never have executed, so its later pass would clear a latch it says nothing about
 * (#56 round 2). Replaying the whole chain attributes nothing and is safe. Requiring a single direct
 * verifier instead hard-BLOCKED correct work whenever a model prefixed an informational segment
 * (`go version &&`, `cat go.mod &&`, `npm run lint &&`) — the shape #56 was reported with (#66).
 *
 * Refused: a surviving pipe (the shell reports the LAST stage's status, so nothing is attributable),
 * command or process substitution and here-docs (not deterministically re-runnable), and any joiner
 * other than `&&` (`||` and `;` run regardless of failure, so the chain proves less than it looks).
 */
export function isReplayableChainCommand(command: string): boolean {
	const stripped = stripSharedTrailingFdRedirect(command.trim());
	if (!stripped) return false;
	const tokens = sharedCommandTokens(stripped);
	if (!tokens || tokens.length === 0) return false;
	if (tokens.some((token) => token.kind === "word" && token.hasShellContext)) return false;
	const operators = tokens.filter((token): token is SharedCommandOperator => token.kind === "operator");
	if (operators.length === 0) return false;
	if (operators.some((operator) => operator.value !== "&&")) return false;
	// Every segment must open with a real word, so each link is an invocation rather than a stray
	// operator or an empty segment.
	let expectWord = true;
	for (const token of tokens) {
		if (token.kind === "operator") {
			if (expectWord) return false;
			expectWord = true;
			continue;
		}
		if (expectWord && !token.value) return false;
		expectWord = false;
	}
	return !expectWord;
}

/** The identity a replayable chain is matched by: the whole chain, whitespace-normalised. */
export function replayableChainVerificationKey(command: string): string {
	const stripped = stripSharedTrailingFdRedirect(command.trim());
	const tokens = sharedCommandTokens(stripped);
	if (!tokens) return stripped;
	return tokens.map((token) => (token.kind === "word" ? token.raw : token.value)).join(" ");
}

function canonicalVerificationCommandKey(command: string): string | undefined {
	const stripped = stripSharedTrailingFdRedirect(command.trim());
	const tokens = sharedCommandTokens(stripped);
	if (!tokens || tokens.length === 0 || tokens.some((token) => token.kind === "word" && token.hasShellContext)) {
		return undefined;
	}
	const hasLeadingDirectory =
		tokens[0]?.kind === "word" &&
		tokens[0].value === "cd" &&
		tokens[1]?.kind === "word" &&
		tokens[2]?.kind === "operator" &&
		tokens[2].value === "&&";
	const body = hasLeadingDirectory ? tokens.slice(3) : tokens;
	if (
		body.length === 0 ||
		body[0]?.kind !== "word" ||
		!body[0].value ||
		body.some((token) => token.kind === "operator") ||
		(!hasLeadingDirectory && tokens.some((token) => token.kind === "operator"))
	) {
		return undefined;
	}
	return tokens.map((token) => (token.kind === "word" ? token.raw : token.value)).join(" ");
}

export function selectSharedVinciVerificationState(
	branch: readonly BranchEntry[] & {
		readonly recordLineNumbers?: readonly number[];
		readonly latestCorruptRecordLine?: number;
	},
): SharedVinciVerificationState | undefined {
	let foundVerificationEntry = false;
	let newerCorruption = false;
	let selected: SharedVinciVerificationState | undefined;

	const terminalState = (state?: SharedVinciVerificationState): SharedVinciTerminalUnverifiableState => ({
		schemaVersion: VINCI_VERIFICATION_SCHEMA_VERSION,
		variant: "terminal-unverifiable",
		status: "failed",
		summary: VINCI_CORRUPTED_VERIFICATION_MESSAGE,
		mutationRevision: Math.max(1, state?.mutationRevision ?? 0),
		command: "",
		commandKey: "",
		checkClass: "behavioral",
	});

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== VINCI_VERIFICATION_ENTRY) continue;
		foundVerificationEntry = true;
		const state = parseSharedVinciVerificationState(entry.data);
		if (!state) {
			if (!selected) newerCorruption = true;
			continue;
		}
		if (!selected) {
			const recordLine = branch.recordLineNumbers?.[index];
			const newerFileCorruption =
				branch.latestCorruptRecordLine !== undefined &&
				(recordLine === undefined || branch.latestCorruptRecordLine > recordLine);
			if (newerCorruption || newerFileCorruption) return terminalState(state);
			selected = state;
		}
	}
	if (selected) return selected;
	return foundVerificationEntry || branch.latestCorruptRecordLine !== undefined ? terminalState() : undefined;
}
