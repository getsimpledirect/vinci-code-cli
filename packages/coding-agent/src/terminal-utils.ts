import { visibleWidth } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ANSI_ESCAPE_SEQUENCE =
	/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~]/g;
const TERMINAL_CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f]/g;
const ELLIPSIS = "…";

/**
 * Remove terminal control sequences and truncate a label to terminal cells
 * without splitting grapheme clusters.
 */
export function sanitizeTerminalLabel(text: string, maxWidth: number): string {
	const widthLimit = Math.max(0, Math.floor(maxWidth));
	if (widthLimit === 0) return "";

	const sanitized = text.replace(ANSI_ESCAPE_SEQUENCE, "").replace(TERMINAL_CONTROL_CHARACTER, "");
	if (visibleWidth(sanitized) <= widthLimit) return sanitized;

	const ellipsisWidth = visibleWidth(ELLIPSIS);
	if (ellipsisWidth > widthLimit) return "";

	const contentLimit = widthLimit - ellipsisWidth;
	let result = "";
	let resultWidth = 0;
	for (const { segment } of graphemeSegmenter.segment(sanitized)) {
		const segmentWidth = visibleWidth(segment);
		if (resultWidth + segmentWidth > contentLimit) break;
		result += segment;
		resultWidth += segmentWidth;
	}
	return result + ELLIPSIS;
}
