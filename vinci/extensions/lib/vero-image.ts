import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getCapabilities, getImageDimensions, Image, type ImageTheme } from "@earendil-works/pi-tui";
import { VINCI_ROOT } from "./product-identity.ts";
import { vinciPlainPresentation, type VeroPose } from "./vero-state.ts";

/** Native terminal layout remains a preview until the candidate has physical-terminal proof. */
export function veroImagesEnabled(width: number): boolean {
  return process.env.VINCI_VERO_IMAGES === "1" && width >= 40 && !vinciPlainPresentation() &&
    process.env.VINCI_ASCII_WORDMARK !== "1" && !!getCapabilities().images;
}

/** A static approved image occupies at most three existing header rows, never the composer. */
export function createVeroImages(root: URL = VINCI_ROOT): Map<VeroPose, Image> {
  const images = new Map<VeroPose, Image>();
  if (process.env.VINCI_VERO_IMAGES !== "1") return images;
  let assets: { key: string; sha256: string; bytes: number; width: number; height: number }[];
  try {
    assets = JSON.parse(readFileSync(new URL("assets/vero/manifest.json", root), "utf8")).assets;
    if (!Array.isArray(assets)) return images;
  } catch {
    return images;
  }
  for (const pose of ["pixel", "rich", "working", "review", "blocked", "done"] as const) {
    try {
      const asset = assets.find((entry) => entry.key === pose);
      const bytes = readFileSync(new URL(`assets/vero/vero-${pose}.png`, root));
      if (!asset || bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) continue;
      const base64 = bytes.toString("base64");
      const dimensions = getImageDimensions(base64, "image/png");
      if (dimensions?.widthPx !== asset.width || dimensions.heightPx !== asset.height) continue;
      images.set(pose, new Image(
        base64,
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
  if (!image || !veroImagesEnabled(width)) return lines;
  let art: string[];
  try {
    art = image.render(10);
  } catch {
    return lines;
  }
  const slot = 8;
  // The approved ink artwork needs its neutral cream surface on either terminal theme.
  // Paint the cells beneath the unmodified image, then return to the text column.
  return lines.map((line, index) => {
    if (index < 1 || index > 3) return line;
    const tile = `\x1b[48;2;244;241;236m${" ".repeat(slot)}\x1b[0m`;
    return `  ${tile}\x1b[${slot}D${art[index - 1] ?? ""}\x1b[${slot + 3}G${line.trimStart()}`;
  });
}
