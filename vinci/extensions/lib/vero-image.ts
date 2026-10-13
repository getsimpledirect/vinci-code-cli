import { readFileSync } from "node:fs";
import { getCapabilities, Image, type ImageTheme } from "@earendil-works/pi-tui";
import { VINCI_ROOT } from "./product-identity.ts";
import { vinciPlainPresentation, type VeroPose } from "./vero-state.ts";

/** A static image occupies at most three existing header rows, never the composer. */
export function createVeroImages(): Map<VeroPose, Image> {
  const images = new Map<VeroPose, Image>();
  for (const pose of ["pixel", "rich", "working", "review", "blocked", "done"] as const) {
    try {
      images.set(pose, new Image(
        readFileSync(new URL(`assets/vero/vero-${pose}.png`, VINCI_ROOT)).toString("base64"),
        "image/png",
        { fallbackColor: (text: string) => text } satisfies ImageTheme,
        { maxWidthCells: 6, maxHeightCells: 3 },
      ));
    } catch {
      // The state and next action remain readable when artwork is unavailable.
    }
  }
  return images;
}

export function renderVeroHeader(lines: string[], image: Image | undefined, width: number): string[] {
  if (!image || width < 40 || vinciPlainPresentation() || process.env.VINCI_ASCII_WORDMARK === "1" || !getCapabilities().images) return lines;
  const art = image.render(10);
  const slot = 8;
  // The approved ink artwork needs its neutral cream surface on either terminal theme.
  // Paint the cells beneath the unmodified image, then return to the text column.
  return lines.map((line, index) => {
    if (index < 1 || index > 3) return line;
    const tile = `\x1b[48;2;244;241;236m${" ".repeat(slot)}\x1b[0m`;
    return `  ${tile}\x1b[${slot}D${art[index - 1] ?? ""}\x1b[${slot + 3}G${line.trimStart()}`;
  });
}
