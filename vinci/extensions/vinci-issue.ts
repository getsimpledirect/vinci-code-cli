/**
 * `/issue` — file a PUBLIC issue on the Vinci Code tracker, from inside Vinci.
 *
 * The sibling of `/feedback`, and deliberately different from it:
 *
 *   /feedback → private. Goes to SimpleDirect. The transcript excerpt stays on your machine.
 *   /issue    → public. Goes on GitHub where other people can see it, add to it, and follow it.
 *
 * Vinci never posts the issue itself. It composes the text, opens GitHub's issue form with the
 * fields prefilled, and you read it rendered and press Submit. So: no GitHub token, no login in the
 * CLI, and no path by which anything reaches the internet without you having seen it first. That
 * matters more here than anywhere else in the product — public is not undoable.
 *
 * The transcript is never attached. A conversation is the single most likely place for a secret,
 * a customer name, or private source to be sitting, and this destination is world-readable.
 *
 * Additive — no core edits.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildIssueUrl, type IssueKind, issuePreview, osLabel } from "./lib/issue-url.ts";
import { redactSecrets } from "./lib/secrets.ts";

const TRACKER_URL = process.env.VINCI_ISSUE_REPO_URL?.trim() || "https://github.com/getsimpledirect/vinci-code-releases";

const identity: unknown = JSON.parse(readFileSync(new URL("../identity.json", import.meta.url), "utf8"));
if (typeof identity !== "object" || identity === null || !("version" in identity) || typeof identity.version !== "string") {
  throw new Error("Vinci identity.json does not contain a product version");
}
const PRODUCT_VERSION = identity.version;

const KINDS: Array<{ label: string; kind: IssueKind }> = [
  { label: "Something is broken", kind: "bug" },
  { label: "Something is missing", kind: "feature" },
];

/**
 * Open a URL without ever going through a shell. On Windows this deliberately avoids
 * `cmd /c start`, which re-parses metacharacters and would make a crafted URL injectable.
 * Best-effort by design: the URL is always shown to the user, so a failed launcher is a papercut,
 * not a dead end.
 */
function openInBrowser(target: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/** `openUrl` is injectable so tests can exercise the whole command without launching a browser. */
export default function (pi: ExtensionAPI, openUrl: (target: string) => void = openInBrowser) {
  pi.registerCommand("issue", {
    description: "Report a bug or request a feature on the public tracker",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        process.stderr.write("run /issue in an interactive session\n");
        return;
      }

      const picked = await ctx.ui.select("What kind of issue?", KINDS.map((entry) => entry.label));
      if (!picked) return;
      const kind = KINDS.find((entry) => entry.label === picked)?.kind ?? "bug";

      const title = (await ctx.ui.input("One line describing it"))?.trim();
      if (!title) return;

      const prompt = kind === "bug" ? "What happened, and what did you expect?" : "What were you trying to do?";
      const body = (await ctx.ui.editor(prompt, ""))?.trim();
      if (!body) return;

      // Redact even though the user typed this themselves — people paste error output containing
      // tokens without noticing, and this is going somewhere public.
      const fields = {
        kind,
        title: redactSecrets(title),
        body: redactSecrets(body),
        version: PRODUCT_VERSION,
        os: osLabel(process.platform),
      };
      const url = buildIssueUrl(TRACKER_URL, fields);

      const confirmed = await ctx.ui.confirm(
        "This will be public",
        `${issuePreview(fields)}\n\nYour conversation is NOT attached. GitHub opens with this filled in — ` +
          `you can edit it there, and nothing is posted until you press Submit.`,
      );
      if (!confirmed) return;

      openUrl(url);
      ctx.ui.notify(`Opened GitHub to finish your issue. If your browser didn't open: ${url}`);
    },
  });
}
