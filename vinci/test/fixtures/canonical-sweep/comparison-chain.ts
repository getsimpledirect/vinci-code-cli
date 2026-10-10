export function acceptsStatus(status: string): boolean {
	return (
		status === "VERIFIED_PASS" ||
		status === "BLOCKED" ||
		status === "CONDITIONAL" ||
		status === "FAILED" ||
		status === "CANCELLED"
	);
}
