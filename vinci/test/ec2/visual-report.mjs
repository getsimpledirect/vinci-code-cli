import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directoryIndex = process.argv.indexOf("--directory");
assert.ok(directoryIndex !== -1 && process.argv[directoryIndex + 1], "usage: visual-report.mjs --directory <terminal-artifact-dir>");
const directory = resolve(process.argv[directoryIndex + 1]);
const files = readdirSync(directory).filter((file) => file.endsWith(".svg")).sort((a, b) => a.localeCompare(b, "en"));
assert.ok(files.length > 0, `No SVG terminal frames found in ${directory}`);

const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const figures = files.map((file) => {
	const svg = readFileSync(join(directory, file), "utf8").replace(
		/<svg /,
		'<svg class="terminal-frame" preserveAspectRatio="xMinYMin meet" ',
	);
	return `<figure><figcaption>${escapeHtml(file)}</figcaption>${svg}</figure>`;
});

const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vinci EC2 terminal visuals</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 28px; color: #f4f1ec; background: #0f1115; }
    header { max-width: 900px; margin: 0 auto 28px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0; color: #a3a39c; }
    main { display: grid; gap: 28px; }
    figure { margin: 0; min-width: 0; }
    figcaption { margin: 0 0 8px; color: #b8c5b0; font: 600 13px ui-monospace, monospace; }
    .terminal-frame { display: block; width: 100%; height: auto; border: 1px solid #383838; border-radius: 11px; box-shadow: 0 16px 36px rgb(0 0 0 / 28%); }
  </style>
</head>
<body>
  <header>
    <h1>Vinci EC2 terminal visuals</h1>
    <p>Native PTY frames from deterministic UI checks and opt-in live repository sessions.</p>
  </header>
  <main>${figures.join("\n")}</main>
</body>
</html>
`;

writeFileSync(join(directory, "index.html"), report);
console.log(`visual report: embedded ${files.length} frames in ${join(directory, "index.html")}`);
