export function displayTone(displayState: string): string {
	return displayState === "BLOCKED" ? "warning" : "info"; // canonical-rendering: local state selects display tone.
}
