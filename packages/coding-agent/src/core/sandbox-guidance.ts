export type SandboxFailureContext = {
	pathScopeRefused?: boolean;
	protectedPath?: boolean;
	sandbox?: boolean;
};

const PREREQUISITE_HINT =
	"The sandbox could not start on this host. Check its prerequisites before retrying; widening file access will not help. Keep confinement enabled.";
const SCOPE_HINT =
	"Keep confinement enabled. Use /allow-directory or /allow-file only for deliberate additional scope.";
const UNKNOWN_HINT = "Keep confinement enabled. Review the sandbox diagnostic before deciding whether to retry.";

/** A denied operation does not, by itself, establish that a wider path grant would help. */
export function getSandboxRecoveryGuidance(
	diagnostic: string,
	context?: SandboxFailureContext,
): { classification: "startup" | "scope" | "unknown"; nextStep: string } | undefined {
	const message = typeof diagnostic === "string" ? diagnostic : "";
	if (
		/no enforceable OS sandbox|sandbox(?:-| )(?:backend|startup).{0,80}(?:missing|unavailable|unsupported|failed|failure)|(?:missing|unavailable|unsupported).{0,40}sandbox(?:-| )backend|\bspawn\b[^\n]*(?:ENOENT|EACCES)|(?:bwrap|bubblewrap)[^\n]*(?:NETLINK_ROUTE|namespaces?|unshare|uid[_ -]?map|gid[_ -]?map|setgroups)|(?:bwrap|bubblewrap):[^\n]*(?:failed|can't|cannot|error|not permitted|permission denied|No such file)|bubblewrap cannot bind a new explicit file grant|sandbox-exec[^\n]*(?:sandbox[_ ](?:apply|init|compile)|execvp|No such file|not found)|unsupported (?:platform|operating system).{0,40}sandbox/i.test(
			message,
		)
	) {
		return { classification: "startup", nextStep: PREREQUISITE_HINT };
	}
	const sandbox =
		context?.sandbox === true ||
		/scoped sandbox|sandbox(?:-| )(?:backend|startup|refus|deni|disabled|writer)|bubblewrap|\bbwrap\b|sandbox-exec/i.test(
			message,
		);
	if (
		context?.protectedPath === true ||
		(sandbox && /protected (?:path|file)|sensitive path|credential path|startup path|read-locked/i.test(message))
	) {
		return { classification: "unknown", nextStep: UNKNOWN_HINT };
	}
	if (
		context?.pathScopeRefused === true ||
		(sandbox &&
			/outside (?:the )?(?:writable (?:roots?|scope)|(?:approved|authorized|allowed) (?:paths?|directories|scope))|(?:write|path)[ -]scope (?:refus|deni)/i.test(
				message,
			))
	) {
		return { classification: "scope", nextStep: SCOPE_HINT };
	}
	return sandbox ? { classification: "unknown", nextStep: UNKNOWN_HINT } : undefined;
}
