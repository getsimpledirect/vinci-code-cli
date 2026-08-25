import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./lib/secrets.ts";
import { VINCI_GATEWAY_BASE_URL, VINCI_PROD_GATEWAY_URL } from "./vinci-links.ts";

const CATEGORIES = [
  "claimed done but wasn't",
  "got stuck / looped",
  "wrong result",
  "confusing",
  "other",
];
const TRANSCRIPT_ENTRY_LIMIT = 20;
const TRANSCRIPT_BYTE_LIMIT = 64 * 1024;
const OUTBOUND_CHARACTER_LIMIT = 3_999;
const TRANSCRIPT_TRUNCATION_MARKER = "\n[transcript excerpt truncated]\n";
const OUTBOUND_TRUNCATION_MARKER = "\n[feedback truncated]";

const identity: unknown = JSON.parse(readFileSync(new URL("../identity.json", import.meta.url), "utf8"));
if (
  typeof identity !== "object" ||
  identity === null ||
  !("version" in identity) ||
  typeof identity.version !== "string"
) {
  throw new Error("Vinci identity.json does not contain a product version");
}
const PRODUCT_VERSION = identity.version;

function vinciHome(): string {
  return process.env.VINCI_HOME?.trim() || join(homedir(), ".vinci-code");
}

export function feedbackEndpoint(): string {
  // Shared gateway base from vinci-links (VINCI_BASE_URL override or the prod default) — no
  // independent env re-derivation here. A whitespace-only override still falls back to prod,
  // exactly as before the consolidation.
  const baseUrl = VINCI_GATEWAY_BASE_URL.trim() || VINCI_PROD_GATEWAY_URL;
  const origin = baseUrl.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");
  return `${origin}/api/feedback`;
}

function truncateUtf8(text: string, byteLimit: number, marker: string): string {
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return text;
  const available = Math.max(0, byteLimit - Buffer.byteLength(marker, "utf8"));
  const prefix = Buffer.from(text, "utf8").subarray(0, available).toString("utf8").replace(/\uFFFD$/, "");
  return `${prefix}${marker}`;
}

function truncateOutbound(text: string): string {
  if (text.length <= OUTBOUND_CHARACTER_LIMIT) return text;
  return `${text.slice(0, OUTBOUND_CHARACTER_LIMIT - OUTBOUND_TRUNCATION_MARKER.length)}${OUTBOUND_TRUNCATION_MARKER}`;
}

function metadataBlock(sessionId: string | undefined): string {
  return [
    "Metadata:",
    `product version: ${PRODUCT_VERSION}`,
    `OS/arch: ${process.platform}/${process.arch}`,
    ...(sessionId ? [`session id: ${sessionId}`] : []),
  ].join("\n");
}

function outboundMessage(category: string, description: string, metadata: string): string {
  return truncateOutbound(redactSecrets([`Category: ${category}`, "", "Description:", description, "", metadata].join("\n")));
}

function transcriptExcerpt(branch: unknown): string {
  if (!Array.isArray(branch)) return "[]";
  const messages = branch
    .filter((entry): entry is { type: "message"; message: unknown } => {
      return typeof entry === "object" && entry !== null && "type" in entry && entry.type === "message" && "message" in entry;
    })
    .slice(-TRANSCRIPT_ENTRY_LIMIT)
    .map((entry) => entry.message);
  return truncateUtf8(redactSecrets(JSON.stringify(messages, null, 2)), TRANSCRIPT_BYTE_LIMIT, TRANSCRIPT_TRUNCATION_MARKER);
}

function saveLocalReport(metadata: string, category: string, description: string, transcript: string): string {
  const directory = join(vinciHome(), "feedback");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `feedback-${Date.now()}-${randomUUID()}.txt`);
  const report = redactSecrets(
    [metadata, "", `Category: ${category}`, "", "Description:", description, "", "Transcript excerpt (local only):", transcript, ""].join(
      "\n",
    ),
  );
  writeFileSync(path, report, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("feedback", {
    description: "Send private feedback without uploading your transcript",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        process.stderr.write("run /feedback in interactive session\n");
        return;
      }

      const category = await ctx.ui.select("What went wrong?", CATEGORIES);
      if (!category) return;
      const description = (await ctx.ui.editor("Describe what went wrong", ""))?.trim();
      if (!description) return;

      const metadata = redactSecrets(metadataBlock(ctx.sessionManager.getSessionId()));
      const transcript = transcriptExcerpt(ctx.sessionManager.getBranch());
      const message = outboundMessage(category, description, metadata);
      let reportPath: string;
      try {
        reportPath = saveLocalReport(metadata, category, description, transcript);
      } catch {
        ctx.ui.notify("could not save feedback report", "error");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "check this before sending",
        `This is exactly what will be sent:\n\n${message}\n\ntranscript stays on your machine at ${reportPath}`,
      );
      if (!confirmed) return;

      const replyTo = (await ctx.ui.input("Email for a reply (optional)"))?.trim() || null;
      try {
        const response = await fetch(feedbackEndpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, replyTo, kind: "vinci-code" }),
        });
        if (!response.ok) throw new Error(`feedback endpoint returned ${response.status}`);
        ctx.ui.notify(`feedback sent, report saved at ${reportPath}`);
      } catch {
        ctx.ui.notify(`could not send, report saved at ${reportPath}`, "error");
      }
    },
  });
}
