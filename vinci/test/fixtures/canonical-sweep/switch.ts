export function outcomeFor(status: string): string | undefined {
	switch (status) {
		case "VERIFIED_PASS":
			return "done";
		case "BLOCKED":
			return "stopped";
		case "CONDITIONAL":
			return "check";
	}
}
