/**
 * Vinci acceptance CLI integration tool for agents.
 * 
 * Spawns the vac (Vinci Acceptance CLI) with frozen JSON register pass-through.
 * Returns the raw vac --json output as content (never parsed/wrapped).
 * Details carry exitCode, jobId (extracted if parseable), reportUrl (if parseable).
 * 
 * Additive: no core edit.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recordRemoteAcceptanceVerdict } from "./lib/control.ts";

const ACCEPT_SCHEMA = Type.Object({
  action: Type.Enum(["verify", "status", "report", "cancel"]),
  job_id: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean({ default: false })),
  args: Type.Optional(Type.Array(Type.String())),
});

// Plain-language vac guidance (when vac is missing, before any provider initialization)
const VAC_NOT_FOUND_GUIDANCE =
  "Verification isn't set up yet. Install the Vinci Acceptance CLI, then run vinci verify again.";

// Max buffer sizes for stdout/stderr capture (256KB each, per decision 6)
const MAX_CAPTURE_BYTES = 256 * 1024;
const VAC_TIMEOUT_MS = 120_000;

/** Truncation marker appended to output when it exceeds MAX_CAPTURE_BYTES. */
const TRUNCATION_MARKER = "\n[… output truncated]";

type VinciAcceptDetails = {
  exitCode: number | undefined;
  jobId?: string;
  reportUrl?: string;
  latchRecorded: boolean;
  validationError?: string;
  error?: string;
  signal?: NodeJS.Signals;
};

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve vac CLI path: VAC_CLI_PATH env override, else search PATH.
 * Returns null if not found.
 */
function resolveVacCli(): string | null {
  const override = process.env.VAC_CLI_PATH?.trim();
  if (override) return isExecutableFile(override) ? override : null;
  
  // Search PATH for vac executable
  try {
    const paths = (process.env.PATH ?? "").split(":");
    for (const dir of paths) {
      if (!dir) continue;
      const candidate = resolve(dir, "vac");
      if (isExecutableFile(candidate)) return candidate;
    }
  } catch {
    // Ignore errors in PATH search
  }
  return null;
}

/**
 * Validate args array: each element must be either a flag (--[a-z-]+) or a plain value.
 * Rejects shell metacharacters: ; | & < > $ ` ( ) * ? [ ] { } ' " newline.
 * Returns error message if invalid, undefined if valid.
 */
function validateArgs(args?: string[]): string | undefined {
  if (!args) return undefined;
  for (const arg of args) {
    // Check for shell metacharacters
    if (/[;|&<>$`()*?\[\]{}'\"\n]/.test(arg)) {
      return `Argument contains shell metacharacters: ${arg}`;
    }
    // If it looks like a flag, enforce --[a-z-]+ format
    if (arg.startsWith("-")) {
      if (!/^--[a-z]+(-[a-z]+)*$/.test(arg)) {
        return `Invalid flag format: ${arg} (must be --[a-z-]+)`;
      }
    }
    // Plain values are allowed (alphanumeric, underscore, dot, hyphen, etc.)
  }
  return undefined;
}

/**
 * Extract jobId and reportUrl from vac JSON output if parseable.
 * Returns { jobId?, reportUrl? }
 */
function extractDetailsFromJson(json: string): { jobId?: string; reportUrl?: string } {
  try {
    const obj = JSON.parse(json);
    const details: { jobId?: string; reportUrl?: string } = {};
    
    // JobCreationOutput.job_id, JobProjection.job_id
    if (typeof obj.job_id === "string") {
      details.jobId = obj.job_id;
    }
    // Report.decision / web_url, JobProjection.web_url
    if (typeof obj.web_url === "string") {
      details.reportUrl = obj.web_url;
    }
    
    return details;
  } catch {
    // JSON parse error: return empty details
    return {};
  }
}

/**
 * Truncate captured output to MAX_CAPTURE_BYTES, appending truncation marker if needed.
 */
function truncateCapture(data: Buffer | string): string {
  const text = typeof data === "string" ? data : data.toString("utf-8", 0, Math.min(data.length, MAX_CAPTURE_BYTES));
  if (data.length > MAX_CAPTURE_BYTES) {
    return text.slice(0, MAX_CAPTURE_BYTES - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return text;
}

/**
 * Check if a verdict status is terminal and should be recorded.
 */
function isTerminalVerdictStatus(status: string): boolean {
  return ["VERIFIED_PASS", "BLOCKED", "CONDITIONAL", "FAILED", "CANCELLED"].includes(status);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vinci_accept",
    label: "Acceptance Verification",
    description:
      "Check acceptance against the Vinci Acceptance suite (vac CLI). Verify code meets requirements, get job status, " +
      "view the detailed report, or cancel an in-progress verification. Returns frozen CLI JSON register verbatim.",
    promptSnippet: "Run Vinci Acceptance verification on code and requirements.",
    promptGuidelines: [
      "Use vinci_accept to verify that code changes meet the acceptance requirements specified.",
      "Start with action='verify' to run verification, then check status with action='status' to monitor progress.",
    ],
    parameters: ACCEPT_SCHEMA,
    async execute(
      _toolCallId,
      params: { action: string; job_id?: string; background?: boolean; args?: string[] },
      signal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: VinciAcceptDetails }> {
      const { action, job_id, background, args } = params;

      // Validate args array for shell safety
      const validationError = validateArgs(args);
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          details: { exitCode: undefined, latchRecorded: false, validationError },
        };
      }

      // Resolve vac CLI path
      const vacPath = resolveVacCli();
      if (!vacPath) {
        return {
          content: [{ type: "text", text: VAC_NOT_FOUND_GUIDANCE }],
          details: { exitCode: 127, latchRecorded: false },
        };
      }

      // Build argv array: vac <action> [job_id] [--background] [...args] --json
      // (the vac parser reads the subcommand from argv[0]; flags follow it)
      const argv = [vacPath];
      argv.push(action);
      if (background && action === "verify") {
        argv.push("--background");
      }
      if (job_id && (action === "status" || action === "report" || action === "cancel")) {
        argv.push(job_id);
      }
      if (args?.length) {
        argv.push(...args);
      }
      argv.push("--json");

      // Spawn vac with output capture
      let stdout: string;
      let stderr: string;
      let exitCode: number;

      try {
        const result = spawnSync(argv[0], argv.slice(1), {
          signal,
          encoding: "utf-8",
          maxBuffer: MAX_CAPTURE_BYTES * 2, // Allow Node to buffer both streams
          timeout: VAC_TIMEOUT_MS,
        });

        stdout = truncateCapture(result.stdout || "");
        stderr = truncateCapture(result.stderr || "");
        const spawnErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
        if (spawnErrorCode === "ENOENT" || spawnErrorCode === "EACCES") {
          return {
            content: [{ type: "text", text: VAC_NOT_FOUND_GUIDANCE }],
            details: { exitCode: 127, latchRecorded: false, error: spawnErrorCode },
          };
        }
        if (spawnErrorCode === "ETIMEDOUT") {
          const message = `Verification timed out after ${VAC_TIMEOUT_MS / 1000} seconds.`;
          return {
            content: [{ type: "text", text: message }],
            details: { exitCode: 124, latchRecorded: false, error: message, signal: result.signal ?? undefined },
          };
        }
        if (result.error) {
          const message = result.error.message;
          return {
            content: [{ type: "text", text: `Failed to spawn vac: ${message}` }],
            details: { exitCode: 1, latchRecorded: false, error: message, signal: result.signal ?? undefined },
          };
        }
        exitCode = result.status ?? 1;
        if (result.signal && !stderr) stderr = `vac terminated by signal ${result.signal}`;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Failed to spawn vac: ${message}` }],
          details: { exitCode: 1, latchRecorded: false, error: message },
        };
      }

      // Decision 6: On non-zero exit, pass stdout through if non-empty, else stderr
      let content = "";
      if (exitCode !== 0) {
        content = stdout || stderr;
      } else {
        content = stdout;
      }

      // Extract details from JSON (jobId, reportUrl)
      const details: VinciAcceptDetails = {
        ...extractDetailsFromJson(content),
        exitCode,
        latchRecorded: true,
      };

      // Try to record remote verdict if we got a terminal verdict and exit code 0
      let latchRecorded = true;
      if (exitCode === 0 && content) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.status && isTerminalVerdictStatus(parsed.status)) {
            latchRecorded = recordRemoteAcceptanceVerdict({
              status: parsed.status,
              summary: parsed.summary || "",
              snapshotDigest: parsed.snapshotDigest || "",
              jobId: parsed.job_id || details.jobId || "",
              reportUrl: parsed.web_url || details.reportUrl || "",
              eventCursor: parsed.event_cursor || parsed.eventCursor,
            });
          }
        } catch {
          // If JSON parsing fails, still return the content but mark recording as failed
          latchRecorded = false;
        }
      }

      details.latchRecorded = latchRecorded;

      return {
        content: [{ type: "text", text: content }],
        details,
      };
    },
  });
}
