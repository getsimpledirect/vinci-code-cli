/**
 * Shared Vinci secret masking.
 *
 * Both the display masker and the model-channel redactor use this decision engine. Callers provide
 * only the rendering policy: the display keeps a short identifying head and uses `‹redacted›`, while
 * the model channel replaces the complete value with its own sentinel.
 */

export function vinciMaskEnabled(): boolean {
	return process.env.VINCI_CODE === "1";
}

type SecretKind = "secret" | "private-key";
type SecretRenderer = (value: string, kind: SecretKind) => string;

export interface VinciMaskSecretsOptions {
	render?: SecretRenderer;
	propertyName?: string;
}

const RED = "‹redacted›";
const MIN_ASSIGNMENT_VALUE_LENGTH = 4;
const MAX_PLACEHOLDER_LENGTH = 64;
const MAX_INTERPOLATION_LENGTH = 256;
const MAX_INTERPOLATION_DEPTH = 16;

const ASSIGNMENT_SECRET_KEY =
	"(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential|session[_-]?secret|encryption[_-]?key|webhook[_-]?secret)";
const PROPERTY_SECRET_KEY =
	"(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential|session[_-]?secret|encryption[_-]?key|webhook[_-]?secret)";
const SECRET_PROPERTY = new RegExp(`(?:^|[_.-])${PROPERTY_SECRET_KEY}(?:$|[_.-])`, "i");

function isSecretProperty(name: string): boolean {
	const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	return SECRET_PROPERTY.test(normalized) || /^(?:access|refresh|key)$/i.test(normalized);
}

const KNOWN_SENTINEL = /^(?:‹redacted›|<vinci-(?:secret|private-key)>)$/;

function isKnownSentinel(value: string): boolean {
	return KNOWN_SENTINEL.test(value);
}

const PLACEHOLDER_WORD = String.raw`(?:[A-Z][A-Z0-9_-]{0,19}|user(?:name)?|region|bucket[-_]name|project[-_]id|password|passphrase|token|secret|key|id|host|api[-_]?key|client[-_]?secret|default|fallback|changeme|placeholder|example|sample|dummy|todo|fixme|(?:your|my)[-_][a-z0-9]+(?:[-_][a-z0-9]+)*|v?\d+(?:\.\d+){1,3}|path/to/(?:file|directory)|email@example\.com)`;
const PLACEHOLDER_CONTENT = new RegExp(`^(?:${PLACEHOLDER_WORD}|<${PLACEHOLDER_WORD}>)$`);
const PLACEHOLDER_VALUE =
	/^(?:\{\{.*\}\}|%.*%|x{3,}|\.{2,}|[-_]+|0+|n\/?a)$|(?:^|[_-])(?:your|my)(?:[_-]|$)|example|placeholder|change[_-]?me|replace[_-]?(?:me|this|with|here)|dummy|sample|todo|fixme|goes[_-]?here|_here$|-here$|paste[_-]?(?:here|your)|enter[_-]?your/i;

function isPlaceholderContent(value: string): boolean {
	return (
		value.length <= MAX_PLACEHOLDER_LENGTH &&
		PLACEHOLDER_CONTENT.test(value) &&
		patternMaskSecrets(value, { assignments: false, schemes: false, render: () => RED }) === value
	);
}

// Parse one complete shell interpolation without executing it. Bare references carry no literal
// value; operator operands are checked against the same positive placeholder grammar as angle
// brackets. The bounds keep hostile inputs from turning placeholder detection into unbounded work.
function parseInterpolation(
	source: string,
	start: number,
	limit: number,
	depth = 0,
): { end: number; placeholder: boolean } | null {
	const boundedLimit = Math.min(limit, start + MAX_INTERPOLATION_LENGTH);
	if (depth >= MAX_INTERPOLATION_DEPTH || start + 3 > boundedLimit || source.slice(start, start + 2) !== "${") {
		return null;
	}

	let index = start + 2;
	if (!/[A-Za-z_]/.test(source[index])) return null;
	index++;
	while (index < boundedLimit && /[A-Za-z0-9_]/.test(source[index])) index++;

	if (source[index] === "}") return { end: index + 1, placeholder: true };

	if (/^:(?:-|=|\?|\+)/.test(source.slice(index, index + 2))) {
		index += 2;
	} else if (source[index] === "=" || source[index] === "#" || source[index] === "%") {
		index++;
	} else {
		return null;
	}

	let literal = "";
	let nestedPlaceholders = true;
	while (index < boundedLimit) {
		if (source.slice(index, index + 2) === "${") {
			const nested = parseInterpolation(source, index, boundedLimit, depth + 1);
			if (!nested) return null;
			nestedPlaceholders &&= nested.placeholder;
			index = nested.end;
		} else if (source[index] === "}") {
			return {
				end: index + 1,
				placeholder: nestedPlaceholders && (literal === "" || isPlaceholderContent(literal)),
			};
		} else {
			literal += source[index];
			index++;
		}
	}
	return null;
}

function isInterpolationPlaceholder(value: string): boolean {
	if (value.length > MAX_INTERPOLATION_LENGTH) return false;
	const interpolation = parseInterpolation(value, 0, value.length);
	return interpolation !== null && interpolation.end === value.length && interpolation.placeholder;
}

function isPlaceholderValue(value: string): boolean {
	if (isKnownSentinel(value)) return true;
	if (value.startsWith("${")) return isInterpolationPlaceholder(value);
	if (value.startsWith("<") && value.endsWith(">")) return isPlaceholderContent(value.slice(1, -1));
	return value.length <= MAX_PLACEHOLDER_LENGTH && PLACEHOLDER_VALUE.test(value);
}

// Cloud Run `--set-secrets` / env-mapping lists point at secret names, not secret values. Validate the
// exact NAME=VALUE[:version] grammar. In particular, never discard empty `=` fields: doing so admits
// base64 padding such as `RLZQHIQS8A==`.
const REF_ATOM = /^(?:[A-Z][A-Z0-9_]*|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|latest|[0-9]+)$/;

function isSecretReferenceList(value: string): boolean {
	if (!value.includes("=")) return false;
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) return false;
	return entries.every((entry) => {
		const equalsParts = entry.split("=");
		if (equalsParts.length !== 2) return false;
		const valueParts = equalsParts[1].split(":");
		return (
			valueParts.length <= 2 &&
			REF_ATOM.test(equalsParts[0].trim()) &&
			valueParts.every((part) => REF_ATOM.test(part.trim()))
		);
	});
}

// Keep this allowlist deliberately narrow. It is the #41/#42 owner-decision boundary and is not part
// of the #43 extraction.
const CODE_REFERENCE_TAIL = String.raw`(?:[;,\)}\]\s]){0,16}$`;
const CODE_REFERENCE_WHITESPACE = String.raw`[ \t\r\n]{0,8}`;
const CODE_REFERENCE_ARGUMENT = String.raw`${CODE_REFERENCE_WHITESPACE}(?:'[^'\r\n]{0,64}'|"[^"\r\n]{0,64}"|[A-Za-z_$][\w$]{0,63})${CODE_REFERENCE_WHITESPACE}`;
const TRUNCATED_CALL_ARGUMENT = String.raw`${CODE_REFERENCE_WHITESPACE}(?:'([^'\r\n]{0,64})'?|"([^"\r\n]{0,64})"?|([^'"()\s]{0,64}))${CODE_REFERENCE_WHITESPACE}`;
const TRUNCATED_BRACKET_ARGUMENT = String.raw`${CODE_REFERENCE_WHITESPACE}(?:'([^'\r\n]{0,64})'?|"([^"\r\n]{0,64})"?|([^'"\]\s]{0,64}))${CODE_REFERENCE_WHITESPACE}`;
const TRUNCATED_PERL_ARGUMENT = String.raw`${CODE_REFERENCE_WHITESPACE}(?:'([^'\r\n]{0,64})'?|"([^"\r\n]{0,64})"?|([^'"}\s]{0,64}))${CODE_REFERENCE_WHITESPACE}`;

interface CodeReferencePattern {
	pattern: RegExp;
	placeholderContent?: boolean;
}

const CODE_REFERENCE_PATTERNS = [
	{
		pattern: new RegExp(
			`^(?:process|import\\.meta|globalThis|window|self|Deno|Bun)\\.env\\.[A-Za-z_$][\\w$]{0,63}${CODE_REFERENCE_TAIL}`,
		),
	},
	{
		pattern: new RegExp(
			`^(?:process|import\\.meta|globalThis|window|self|Deno|Bun)\\.env\\[${CODE_REFERENCE_ARGUMENT}\\]${CODE_REFERENCE_TAIL}`,
		),
	},
	{
		pattern: new RegExp(`^(?:process|import\\.meta|globalThis|window|self|Deno|Bun)\\.env${CODE_REFERENCE_TAIL}`),
	},
	{ pattern: new RegExp(`^os\\.environ\\[${CODE_REFERENCE_ARGUMENT}\\]${CODE_REFERENCE_TAIL}`) },
	{
		pattern: new RegExp(
			`^(?:getenv|std::getenv|os\\.(?:getenv|Getenv|LookupEnv)|os\\.environ\\.get|System\\.(?:getenv|getProperty)|Deno\\.env\\.get)\\(${CODE_REFERENCE_ARGUMENT}\\)${CODE_REFERENCE_TAIL}`,
		),
	},
	{ pattern: new RegExp(`^ENV\\[${CODE_REFERENCE_ARGUMENT}\\]${CODE_REFERENCE_TAIL}`) },
	{ pattern: new RegExp(`^ENV\\.fetch\\(${CODE_REFERENCE_ARGUMENT}\\)${CODE_REFERENCE_TAIL}`) },
	{ pattern: new RegExp(`^\\$ENV\\{${CODE_REFERENCE_ARGUMENT}\\}${CODE_REFERENCE_TAIL}`) },
	{ pattern: new RegExp(`^\\$\\{[A-Za-z_][\\w]{0,63}\\}${CODE_REFERENCE_TAIL}`) },
	{
		pattern: new RegExp(`^\\$([A-Za-z_][\\w]{0,63})${CODE_REFERENCE_TAIL}`),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(
			`^(?:process|import\\.meta|globalThis|window|self|Deno|Bun)\\.env\\[${TRUNCATED_BRACKET_ARGUMENT}\\]?${CODE_REFERENCE_TAIL}`,
		),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(`^os\\.environ\\[${TRUNCATED_BRACKET_ARGUMENT}\\]?${CODE_REFERENCE_TAIL}`),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(
			`^(?:getenv|std::getenv|os\\.(?:getenv|Getenv|LookupEnv)|os\\.environ\\.get|System\\.(?:getenv|getProperty)|Deno\\.env\\.get)\\(${TRUNCATED_CALL_ARGUMENT}\\)?${CODE_REFERENCE_TAIL}`,
		),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(`^ENV\\[${TRUNCATED_BRACKET_ARGUMENT}\\]?${CODE_REFERENCE_TAIL}`),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(`^ENV\\.fetch\\(${TRUNCATED_CALL_ARGUMENT}\\)?${CODE_REFERENCE_TAIL}`),
		placeholderContent: true,
	},
	{
		pattern: new RegExp(`^\\$ENV\\{${TRUNCATED_PERL_ARGUMENT}\\}?${CODE_REFERENCE_TAIL}`),
		placeholderContent: true,
	},
] satisfies CodeReferencePattern[];

function isCodeReference(value: string): boolean {
	if (value.length > 256) return false;
	for (const { pattern, placeholderContent } of CODE_REFERENCE_PATTERNS) {
		const match = pattern.exec(value);
		if (!match) continue;
		if (!placeholderContent) return true;
		const capturedContent = match.slice(1).find((capture) => capture !== undefined);
		return capturedContent === undefined || capturedContent === "" || isPlaceholderContent(capturedContent);
	}
	return false;
}

interface AssignmentValue {
	value: string;
	openQuote: string;
	closeQuote: string;
	end: number;
}

function scanInterpolationEnd(source: string, start: number): number {
	let depth = 0;
	let quote = "";
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === "\\") {
				index++;
			} else if (character === quote) {
				quote = "";
			}
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
		} else if (source.slice(index, index + 2) === "${") {
			depth++;
			index++;
		} else if (character === "}") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return source.length;
}

const ENV_CALL_START =
	/^(?:getenv|std::getenv|os\.(?:getenv|Getenv|LookupEnv)|os\.environ\.get|System\.(?:getenv|getProperty)|Deno\.env\.get)\(/;
const ENV_BRACKET_START = /^(?:(?:process|import\.meta|globalThis|window|self|Deno|Bun)\.env|os\.environ|ENV)\[/;
const PERL_ENV_START = /^\$ENV\{/;

function scanChainedCodeReferenceEnd(source: string, end: number, limit: number): number {
	let chainStart = end;
	while (chainStart < limit && /\s/.test(source[chainStart])) chainStart++;
	const startsChain =
		source[chainStart] === "." ||
		source[chainStart] === "[" ||
		source[chainStart] === "(" ||
		source[chainStart] === "?" ||
		source.slice(chainStart, chainStart + 2) === "->" ||
		source.slice(chainStart, chainStart + 2) === "::";
	if (!startsChain) return end;

	let chainEnd = chainStart;
	while (chainEnd < limit && !/\s/.test(source[chainEnd])) chainEnd++;
	return chainEnd;
}

function scanDelimitedCodeReferenceEnd(source: string, start: number): number | null {
	const candidate = source.slice(start, start + 256);
	const prefix = ENV_CALL_START.exec(candidate) ?? ENV_BRACKET_START.exec(candidate) ?? PERL_ENV_START.exec(candidate);
	if (!prefix) return null;

	const closeDelimiter = prefix[0].endsWith("(") ? ")" : prefix[0].endsWith("[") ? "]" : "}";
	const limit = Math.min(source.length, start + 256);
	let quote = "";
	for (let index = start + prefix[0].length; index < limit; index++) {
		const character = source[index];
		if (quote) {
			if (character === "\\") {
				index++;
			} else if (character === quote) {
				quote = "";
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === closeDelimiter) {
			let end = index + 1;
			while (end < limit && !/\s/.test(source[end])) end++;
			return scanChainedCodeReferenceEnd(source, end, limit);
		}
	}
	return limit;
}

function scanAssignmentValue(source: string, start: number): AssignmentValue | null {
	if (start >= source.length) return null;
	const first = source[start];
	if (first === '"' || first === "'" || first === "`") {
		let index = start + 1;
		while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
			if (source[index] === "\\") {
				index += 2;
			} else if (source[index] === first) {
				return {
					value: source.slice(start + 1, index),
					openQuote: first,
					closeQuote: first,
					end: index + 1,
				};
			} else {
				index++;
			}
		}
		return {
			value: source.slice(start + 1, index),
			openQuote: first,
			closeQuote: "",
			end: index,
		};
	}

	const codeReferenceEnd = scanDelimitedCodeReferenceEnd(source, start);
	if (codeReferenceEnd !== null) {
		return {
			value: source.slice(start, codeReferenceEnd),
			openQuote: "",
			closeQuote: "",
			end: codeReferenceEnd,
		};
	}

	if (source.slice(start, start + 2) === "${") {
		const end = scanInterpolationEnd(source, start);
		return { value: source.slice(start, end), openQuote: "", closeQuote: "", end };
	}

	if (first === "<") {
		const close = source.indexOf(">", start + 1);
		if (close !== -1) {
			return { value: source.slice(start, close + 1), openQuote: "", closeQuote: "", end: close + 1 };
		}
	}

	let end = start;
	while (end < source.length && !/[\s"'`]/.test(source[end])) end++;
	if (end === start) return null;
	end = scanChainedCodeReferenceEnd(source, end, Math.min(source.length, start + 256));
	return { value: source.slice(start, end), openQuote: "", closeQuote: "", end };
}

function replaceAssignments(text: string, render: SecretRenderer): string {
	const assignment = new RegExp(
		`([A-Za-z0-9_.\\-]{0,64}${ASSIGNMENT_SECRET_KEY}[A-Za-z0-9_.\\-]{0,64}["'\`]?\\s*[:=]\\s*)`,
		"gi",
	);
	let rebuilt = "";
	let last = 0;
	for (let match = assignment.exec(text); match !== null; match = assignment.exec(text)) {
		if (match.index < last) continue;
		const interpolationStart =
			match.index >= 2 && text.slice(match.index - 2, match.index) === "${" ? match.index - 2 : -1;
		if (interpolationStart >= last) {
			const interpolationEnd = scanInterpolationEnd(text, interpolationStart);
			const interpolation = text.slice(interpolationStart, interpolationEnd);
			rebuilt += text.slice(last, interpolationStart);
			rebuilt += isPlaceholderValue(interpolation) ? interpolation : render(interpolation, "secret");
			last = interpolationEnd;
			assignment.lastIndex = interpolationEnd;
			continue;
		}
		const scanned = scanAssignmentValue(text, assignment.lastIndex);
		if (!scanned || scanned.value.length < MIN_ASSIGNMENT_VALUE_LENGTH) continue;

		rebuilt += text.slice(last, match.index);
		const preserved =
			isPlaceholderValue(scanned.value) ||
			isSecretReferenceList(scanned.value) ||
			(scanned.openQuote === "" && isCodeReference(scanned.value));
		rebuilt += preserved
			? text.slice(match.index, scanned.end)
			: `${match[1]}${scanned.openQuote}${render(scanned.value, "secret")}${scanned.closeQuote}`;
		last = scanned.end;
		assignment.lastIndex = scanned.end;
	}
	return rebuilt + text.slice(last);
}

// High-signal token shapes. These are shared by both channels, including both AWS access-key forms.
const TOKEN_PATTERNS = [
	/vinci_live_[A-Za-z0-9_-]{16,}/g,
	/gsk_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
	/sk-ant-[A-Za-z0-9_-]{20,}/g,
	/sk-proj-[A-Za-z0-9_-]{20,}/g,
	/sk-or-v1-[A-Fa-f0-9]{40,}(?![A-Za-z0-9])/g,
	/sk-[A-Za-z0-9]{20,}/g,
	/hf_[A-Za-z0-9]{28,}(?![A-Za-z0-9])/g,
	/(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
	/whsec_[A-Za-z0-9]{16,}/g,
	/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/gh[posru]_[A-Za-z0-9]{20,}/g,
	/npm_[A-Za-z0-9]{36}/g,
	/glpat-[A-Za-z0-9_-]{20,}/g,
	/xox[baprs]-[A-Za-z0-9-]{12,}/g,
	/SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
	/key-[0-9a-f]{32}(?![0-9a-f])/gi,
	/1\/\/0[A-Za-z0-9_-]{20,}/g,
	/https:\/\/[a-f0-9]{16,}@o?\d+\.ingest\.[a-z.]*sentry\.io\/\d+/gi,
	/(?:AKIA|ASIA)[0-9A-Z]{16}/g,
	/A[CK][0-9a-f]{32}(?![0-9a-f])/g,
	/AIza[0-9A-Za-z_-]{35}/g,
];

function maskPrivateKeys(text: string, render: SecretRenderer): string {
	if (!text.includes("PRIVATE KEY")) return text;

	const markerPattern = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g;
	let rebuilt = "";
	let last = 0;
	let openBegin = -1;
	for (let match = markerPattern.exec(text); match !== null; match = markerPattern.exec(text)) {
		if (match[1] === "BEGIN") {
			if (openBegin === -1) {
				rebuilt += text.slice(last, match.index);
				openBegin = match.index;
				last = match.index;
			}
		} else if (openBegin !== -1) {
			const end = match.index + match[0].length;
			rebuilt += render(text.slice(openBegin, end), "private-key");
			last = end;
			openBegin = -1;
		} else {
			let start = match.index;
			while (start > last && /[A-Za-z0-9+/=\s]/.test(text[start - 1])) start--;
			const end = match.index + match[0].length;
			if (match.index - start >= 20) {
				rebuilt += `${text.slice(last, start)}${render(text.slice(start, end), "private-key")}`;
			} else {
				rebuilt += text.slice(last, end);
			}
			last = end;
		}
	}
	if (openBegin !== -1) {
		rebuilt += render(text.slice(openBegin), "private-key");
		last = text.length;
	}
	return rebuilt + text.slice(last);
}

interface PatternMaskOptions {
	assignments?: boolean;
	schemes?: boolean;
	render: SecretRenderer;
}

function patternMaskSecrets(text: string, { assignments = true, schemes = true, render }: PatternMaskOptions): string {
	if (!text) return text;
	let output = schemes
		? text.replace(
				/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._\-+/=]{8,})/gi,
				(_match, scheme: string, value: string) => `${scheme} ${render(value, "secret")}`,
			)
		: text;
	if (schemes) {
		output = output.replace(
			/\b(Authorization\s*:\s*)(?!Bearer\b|Basic\b|Token\b)([A-Za-z0-9._\-+/=]{8,})/gi,
			(_match, prefix: string, value: string) => `${prefix}${render(value, "secret")}`,
		);
	}
	if (assignments) output = replaceAssignments(output, render);

	// The 63-character scheme bound is the #26 quadratic-time fix. Username and password remain
	// unbounded because each is reachable only after a literal `://`, keeping total scanning linear.
	output = output.replace(
		/(\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s:@/]*:)([^\s:@/]{3,})(@)/gi,
		(_match, prefix: string, password: string, at: string) => `${prefix}${render(password, "secret")}${at}`,
	);
	for (const tokenPattern of TOKEN_PATTERNS) {
		output = output.replace(tokenPattern, (value) => render(value, "secret"));
	}
	return maskPrivateKeys(output, render);
}

const DECODED_ENV_SECRET =
	/(?:^|[\r\n])[ \t]*[A-Z0-9_]{0,32}(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH_TOKEN|CREDENTIAL)[A-Z0-9_]{0,32}=["'`]?([^\s"'`]{6,})/g;

function hasDecodedEnvSecret(text: string): boolean {
	DECODED_ENV_SECRET.lastIndex = 0;
	for (let match = DECODED_ENV_SECRET.exec(text); match !== null; match = DECODED_ENV_SECRET.exec(text)) {
		if (!isPlaceholderValue(match[1])) return true;
	}
	return false;
}

const DETECTION_RENDERER: SecretRenderer = () => RED;

function containsSecretMaterial(text: string): boolean {
	return (
		hasDecodedEnvSecret(text) ||
		patternMaskSecrets(text, {
			assignments: false,
			schemes: false,
			render: DETECTION_RENDERER,
		}) !== text
	);
}

function maskEncodedSecrets(text: string, render: SecretRenderer): string {
	if (text.length < 12) return text;
	const checkBase64 = (run: string): string => {
		const compact = run.replace(/\s+/g, "");
		for (let offset = 0; offset < 4; offset++) {
			if (compact.length - offset < 16) break;
			try {
				const decoded = Buffer.from(compact.slice(offset), "base64").toString("latin1");
				if (decoded.length >= 6 && containsSecretMaterial(decoded)) return render(run, "secret");
			} catch {
				// Not decodable at this phase.
			}
		}
		return run;
	};

	let output = text.replace(/(?:[A-Za-z0-9+/]{20,120}\r?\n)+[A-Za-z0-9+/]{2,120}={0,2}/g, checkBase64);
	output = output.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, checkBase64);
	return output.replace(/[0-9a-fA-F](?:[0-9a-fA-F]|[ \t\r\n]){14,}[0-9a-fA-F]/g, (run) => {
		const hex = run.replace(/[^0-9a-fA-F]/g, "");
		for (const phase of [0, 1]) {
			let candidate = hex.slice(phase);
			if (candidate.length % 2 === 1) candidate = candidate.slice(0, -1);
			if (candidate.length < 16) continue;
			try {
				if (containsSecretMaterial(Buffer.from(candidate, "hex").toString("latin1"))) {
					return render(run, "secret");
				}
			} catch {
				// Not decodable at this alignment.
			}
		}
		return run;
	});
}

function displayRenderer(value: string, kind: SecretKind): string {
	if (kind === "private-key") {
		const begin = value.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/)?.[0];
		const end = value.match(/-----END [A-Z0-9 ]*PRIVATE KEY-----/)?.[0];
		if (begin && end) return `${begin} ${RED} ${end}`;
		if (begin) return `${begin} ${RED}`;
		if (end) return `${RED} ${end}`;
		return RED;
	}
	const head = value.length > 8 ? value.slice(0, 4) : "";
	return head ? `${head}…${RED}` : RED;
}

function shouldPreserveForcedValue(value: string): boolean {
	return isKnownSentinel(value) || isPlaceholderValue(value) || isSecretReferenceList(value) || isCodeReference(value);
}

export function vinciMaskSecrets(text: string, options: VinciMaskSecretsOptions = {}): string {
	if (!text) return text;
	const render = options.render ?? displayRenderer;
	if (options.propertyName && isSecretProperty(options.propertyName)) {
		return shouldPreserveForcedValue(text) ? text : render(text, "secret");
	}
	return maskEncodedSecrets(patternMaskSecrets(text, { render }), render);
}

/** Mask an event or structured value without rewriting JSON punctuation or numeric telemetry. */
export function vinciMaskJson(value: unknown, propertyName = ""): unknown {
	if (typeof value === "string") return vinciMaskSecrets(value, { propertyName });
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return propertyName && isSecretProperty(propertyName) && value !== null && value !== undefined ? RED : value;
	}
	if (Array.isArray(value)) return value.map((entry) => vinciMaskJson(entry));
	if (typeof value === "object") {
		const masked: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) masked[key] = vinciMaskJson(entry, key);
		return masked;
	}
	return value;
}
