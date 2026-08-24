import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const OUTCOME_ENTRY = "vinci-task-outcome";
const REPORT_ENTRY = "vinci-false-completion-report";
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

// The agent/session directory overrides are NOT fixed strings: packages/coding-agent/src/config.ts
// derives them from that package's piConfig (name "vinci" → VINCI_CODING_AGENT_DIR, while configDir
// deliberately stays ".pi" — PATCHES.md §9). Hardcoding "PI_CODING_AGENT_DIR" here silently ignored
// every user who moved their agent directory. This command deliberately runs BEFORE the agent loads
// (see vinci/bin/vinci) so reporting never spends credits or hits the network, so it cannot import
// the built config module without making a build-free command depend on a build. It reads the same
// source of truth config.ts reads instead, so these names move whenever piConfig does.
let piConfig = {};
try {
  const manifest = JSON.parse(readFileSync(new URL("../../packages/coding-agent/package.json", import.meta.url), "utf8"));
  piConfig = manifest.piConfig ?? {};
} catch {
  // Missing/unreadable package metadata falls back to the core defaults, exactly as config.ts does.
}
const APP_NAME = piConfig.name || "pi";
const CONFIG_DIR_NAME = piConfig.configDir || ".pi";
const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

function configuredSessionRoot(explicit) {
  if (explicit) return expandHome(explicit);
  if (process.env[ENV_SESSION_DIR]) return expandHome(process.env[ENV_SESSION_DIR]);
  const agentDir = expandHome(process.env[ENV_AGENT_DIR] || join(homedir(), CONFIG_DIR_NAME, "agent"));
  for (const settingsPath of [join(process.cwd(), CONFIG_DIR_NAME, "settings.json"), join(agentDir, "settings.json")]) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof settings.sessionDir === "string" && settings.sessionDir.trim()) {
        return expandHome(settings.sessionDir.trim());
      }
    } catch {
      // Missing or malformed settings do not hide sessions in the default store.
    }
  }
  return join(agentDir, "sessions");
}

function sessionFiles(root) {
  const files = [];
  const visit = (directory, depth) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      else if (entry.isDirectory() && depth > 0) visit(path, depth - 1);
    }
  };
  visit(root, 1);
  return files;
}

function parseSession(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Session loading already ignores malformed crash-tail lines; reporting does the same.
    }
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") return undefined;
  return { content, entries, header };
}

function activeBranch(entries) {
  const records = entries.filter(
    (entry) => entry && entry.type !== "session" && typeof entry.id === "string",
  );
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  const branch = [];
  let current = records.at(-1);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function validOutcome(value, taskId) {
  return (
    value &&
    value.schemaVersion === 1 &&
    value.taskId === taskId &&
    (value.state === "DONE" || value.state === "DONE_UNVERIFIED" || value.state === "WAITING" || value.state === "BLOCKED") &&
    typeof value.recordedAt === "string" &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every((file) => typeof file === "string") &&
    value.usage &&
    typeof value.usage.modelCalls === "number" &&
    Array.isArray(value.usage.providers) &&
    Array.isArray(value.usage.models) &&
    typeof value.usage.estimatedCostUsd === "number"
  );
}

function parseArgs(args) {
  let sessionDir;
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--session-dir") {
      sessionDir = args[index + 1];
      index++;
    } else {
      positional.push(args[index]);
    }
  }
  return { taskId: positional[0] || "", note: positional.slice(1).join(" ").trim().slice(0, 500), sessionDir };
}

const { taskId, note, sessionDir } = parseArgs(process.argv.slice(2));
if (!taskId) {
  fail("Usage: vinci report-wrong <task-id> [note]");
} else if (!SESSION_ID.test(taskId)) {
  fail("Invalid task ID. Use the exact ID shown by /task-info.");
} else {
  const root = configuredSessionRoot(sessionDir);
  const matches = sessionFiles(root)
    .map((path) => ({ path, session: parseSession(path) }))
    .filter((candidate) => candidate.session?.header.id === taskId)
    .sort((left, right) => statSync(right.path).mtimeMs - statSync(left.path).mtimeMs);

  if (matches.length === 0) {
    fail(`No task found with ID ${taskId}. Searched ${root}.`);
  } else if (matches.length > 1) {
    fail(`Multiple tasks use ID ${taskId}. Re-run with --session-dir <path>.`);
  } else {
    const { path, session } = matches[0];
    const branch = activeBranch(session.entries);
    const outcomeEntry = [...branch]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === OUTCOME_ENTRY && validOutcome(entry.data, taskId));
    const outcome = outcomeEntry?.data;
    if (!outcome) {
      fail(`Task ${taskId} has no durable terminal outcome to report.`);
    } else if (outcome.state !== "DONE" && outcome.state !== "DONE_UNVERIFIED") {
      fail(`Task ${taskId} ended ${outcome.state}; it did not claim completion.`);
    } else {
      const duplicate = branch.find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === REPORT_ENTRY &&
          entry.data?.taskId === taskId &&
          entry.data?.outcomeRecordedAt === outcome.recordedAt,
      );
      if (duplicate) {
        process.stdout.write(`False-completion report already recorded for task ${taskId}.\n`);
      } else {
        const report = {
          schemaVersion: 1,
          reportId: randomUUID(),
          taskId,
          outcomeRecordedAt: outcome.recordedAt,
          claimedState: outcome.state,
          verificationStatus: outcome.verificationStatus,
          verificationCommand: outcome.verificationCommand,
          changedFiles: outcome.changedFiles,
          modelCalls: outcome.usage.modelCalls,
          providers: outcome.usage.providers,
          models: outcome.usage.models,
          estimatedCostUsd: outcome.usage.estimatedCostUsd,
          note,
          reportedAt: new Date().toISOString(),
        };
        const parent = branch.at(-1);
        const entry = {
          type: "custom",
          customType: REPORT_ENTRY,
          data: report,
          id: randomUUID().slice(0, 8),
          parentId: parent?.id ?? null,
          timestamp: report.reportedAt,
        };
        appendFileSync(path, `${session.content.endsWith("\n") ? "" : "\n"}${JSON.stringify(entry)}\n`);
        process.stdout.write(
          `Recorded false-completion report for task ${taskId}.\nClaimed state: ${outcome.state.replace("_", "-")} · report: ${report.reportId}\n`,
        );
      }
    }
  }
}
