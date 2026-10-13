const acceptedStatuses = ["VERIFIED_PASS", "BLOCKED", "CONDITIONAL", "FAILED", "CANCELLED"];

export function acceptsStatus(status: string): boolean {
	return acceptedStatuses.indexOf(status) !== -1;
}
