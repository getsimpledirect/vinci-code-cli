import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

const MAX_IMAGES = 6;
// Detection scans past the attach cap so an over-limit drop can be reported and tidied rather than
// left as raw paths in the message. Bounded so a huge paste can't turn into unbounded stat calls.
const DETECT_LIMIT = 24;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function mimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

function unquote(token: string): string {
  const withoutAt = token.startsWith("@") ? token.slice(1) : token;
  const quoted =
    (withoutAt.startsWith('"') && withoutAt.endsWith('"')) ||
    (withoutAt.startsWith("'") && withoutAt.endsWith("'"));
  return (quoted ? withoutAt.slice(1, -1) : withoutAt).replace(/\\ /g, " ");
}

export function extractImagePaths(text: string, cwd: string): Array<{ token: string; path: string }> {
  const tokens = text.match(/@?(?:"[^"]+"|'[^']+'|(?:\\ |[^\s])+)/g) ?? [];
  const images: Array<{ token: string; path: string }> = [];
  for (const token of tokens) {
    const candidate = resolve(cwd, unquote(token));
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      const header = readFileSync(candidate).subarray(0, 16);
      if (mimeType(header)) images.push({ token, path: candidate });
      if (images.length >= DETECT_LIMIT) break;
    } catch {
      // Submission reports only files which can actually be read and processed.
    }
  }
  return images;
}

export async function attachImagesFromText(
  text: string,
  cwd: string,
): Promise<{ text: string; images: ImageContent[]; errors: string[] }> {
  const paths = extractImagePaths(text, cwd);
  const images: ImageContent[] = [];
  const errors: string[] = [];
  let remaining = text;
  let overflow = 0;

  for (const item of paths) {
    // Past the cap, still take the path out of the message. Leaving it raw is the exact wall of
    // /var/folders this marker exists to remove, and dropping it silently would hide that the
    // image never reached the model.
    if (images.length >= MAX_IMAGES) {
      overflow += 1;
      remaining = remaining.replace(item.token, "[Image not attached]");
      continue;
    }
    try {
      const bytes = readFileSync(item.path);
      const type = mimeType(bytes);
      if (!type) continue;
      const resized = await resizeImage(bytes, type, { maxWidth: 2000, maxHeight: 2000, maxBytes: MAX_IMAGE_BYTES });
      if (!resized || Buffer.byteLength(resized.data, "base64") > MAX_IMAGE_BYTES) {
        errors.push(`${item.path} could not be resized below 12 MB.`);
        continue;
      }
      images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
      // Dropping a screenshot pastes an absolute path that can be longer than the sentence around
      // it, and this text is what the transcript renders. Stand a short marker in its place: the
      // user sees what they attached instead of a wall of /var/folders, and the model keeps the
      // position of each image within the sentence. Numbered from 1 to match how people say it.
      remaining = remaining.replace(item.token, `[Image #${images.length}]`);
    } catch {
      errors.push(`${item.path} could not be read.`);
    }
  }

  if (overflow > 0) {
    errors.push(
      `Only the first ${MAX_IMAGES} images were attached — ${overflow} more ${overflow === 1 ? "was" : "were"} left out.`,
    );
  }

  const collapsed = remaining.replace(/\s+/g, " ").trim();
  // A bare drop is now "[Image #1]" rather than empty, so the old fallback would never fire again.
  // Keep the marker (the user should see what they attached) and restore the instruction after it.
  const markersOnly = images.length > 0 && collapsed.replace(/\[Image #\d+\]/g, "").trim() === "";

  return {
    text: markersOnly
      ? `${collapsed} Inspect the attached image.`
      : collapsed || (images.length ? "Inspect the attached image." : text),
    images,
    errors,
  };
}
