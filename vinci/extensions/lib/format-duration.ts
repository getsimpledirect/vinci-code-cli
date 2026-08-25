export type FormatDurationOptions = {
	padSeconds?: boolean;
	rounding?: "floor" | "round";
};

export function formatDuration(milliseconds: number, options: FormatDurationOptions = {}): string {
	const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
	const seconds =
		options.rounding === "floor"
			? Math.floor(safeMilliseconds / 1000)
			: Math.round(safeMilliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

	const remainder = String(seconds % 60);
	return `${minutes}m ${options.padSeconds ? remainder.padStart(2, "0") : remainder}s`;
}
