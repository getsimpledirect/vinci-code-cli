export function isFailed(statuses: readonly string[]): boolean {
	return statuses.includes("FAILED");
}
