const ANSI_16 = [
	"#1f2329",
	"#e06c75",
	"#98c379",
	"#d19a66",
	"#61afef",
	"#c678dd",
	"#56b6c2",
	"#d7dae0",
	"#5c6370",
	"#e06c75",
	"#98c379",
	"#e5c07b",
	"#61afef",
	"#c678dd",
	"#56b6c2",
	"#ffffff",
];

function escapeXml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function paletteColor(index) {
	if (index < ANSI_16.length) return ANSI_16[index];
	if (index >= 232) {
		const component = 8 + (index - 232) * 10;
		const hex = component.toString(16).padStart(2, "0");
		return `#${hex}${hex}${hex}`;
	}
	const cube = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const red = levels[Math.floor(cube / 36)];
	const green = levels[Math.floor((cube % 36) / 6)];
	const blue = levels[cube % 6];
	return `#${[red, green, blue].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function cellColor(cell, foreground) {
	const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
	if (isDefault) return foreground ? "#f4f1ec" : "#14161a";
	const value = foreground ? cell.getFgColor() : cell.getBgColor();
	const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	if (isRgb) return `#${value.toString(16).padStart(6, "0")}`;
	return paletteColor(value);
}

export function viewportText(terminal) {
	const buffer = terminal.buffer.active;
	const lines = [];
	for (let row = 0; row < terminal.rows; row++) {
		lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
	}
	return lines.join("\n");
}

export function viewportSvg(terminal, label) {
	const padding = 24;
	const cellWidth = 9.5;
	const cellHeight = 20;
	const width = padding * 2 + terminal.cols * cellWidth;
	const height = padding * 2 + terminal.rows * cellHeight;
	const buffer = terminal.buffer.active;
	const elements = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<title>${escapeXml(label)}</title>`,
		`<rect width="100%" height="100%" rx="10" fill="#14161a"/>`,
		'<g font-family="SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" font-size="15.5" xml:space="preserve">',
	];

	for (let row = 0; row < terminal.rows; row++) {
		const line = buffer.getLine(buffer.viewportY + row);
		if (!line) continue;
		for (let column = 0; column < terminal.cols; column++) {
			const cell = line.getCell(column);
			if (!cell || cell.getWidth() === 0) continue;
			let foreground = cellColor(cell, true);
			let background = cellColor(cell, false);
			if (cell.isInverse()) [foreground, background] = [background, foreground];
			const x = padding + column * cellWidth;
			const y = padding + row * cellHeight;
			if (!cell.isBgDefault() || cell.isInverse()) {
				elements.push(`<rect x="${x}" y="${y}" width="${cellWidth * cell.getWidth()}" height="${cellHeight}" fill="${background}"/>`);
			}
			const characters = cell.getChars();
			if (!characters || cell.isInvisible()) continue;
			const styles = [
				`fill="${foreground}"`,
				cell.isBold() ? 'font-weight="700"' : "",
				cell.isItalic() ? 'font-style="italic"' : "",
				cell.isDim() ? 'opacity="0.58"' : "",
				cell.isUnderline() ? 'text-decoration="underline"' : "",
			].filter(Boolean);
			elements.push(`<text x="${x}" y="${y + 15.5}" ${styles.join(" ")}>${escapeXml(characters)}</text>`);
		}
	}

	if (buffer.cursorY >= buffer.viewportY && buffer.cursorY < buffer.viewportY + terminal.rows) {
		const cursorX = padding + buffer.cursorX * cellWidth;
		const cursorY = padding + (buffer.cursorY - buffer.viewportY) * cellHeight;
		elements.push(`<rect x="${cursorX}" y="${cursorY}" width="${cellWidth}" height="${cellHeight}" fill="none" stroke="#b8c5b0" stroke-width="1.5"/>`);
	}

	elements.push("</g>", "</svg>");
	return `${elements.join("\n")}\n`;
}
