// Evidence upload management for Stage 2
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

import { isLedgerRef } from "./bus.mjs";

function resolveBin(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function command(commandName, args) {
  return new Promise((resolveCommand) => {
    let executable;
    try {
      executable = resolveBin(commandName);
    } catch (error) {
      resolveCommand({ status: null, error: error.message, stdout: "", stderr: error.message });
      return;
    }
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (status) => {
      resolveCommand({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function uploadEvidence({
  sessionJsonl,
  gitDiff,
  resultJson,
  logTail,
  uriPrefix,
  taskId,
  busUrl,
  busToken,
  ref,
}) {
  if (!uriPrefix) return null;

  // Build bundle directory
  const bundleDir = join("/tmp", `evidence-${taskId}-${Date.now()}`);
  const tarPath = `${bundleDir}.tgz`;

  try {
    // Build the bundle: session jsonl, git diff, result.json, runner log
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "session.jsonl"), sessionJsonl ?? "");
    writeFileSync(join(bundleDir, "git.diff"), gitDiff ?? "");
    writeFileSync(join(bundleDir, "result.json"), JSON.stringify(resultJson ?? {}, null, 2));
    writeFileSync(join(bundleDir, "runner.log"), logTail ?? "");

    const tarResult = await command("tar", ["czf", tarPath, "-C", bundleDir, "."]);
    if (tarResult.status !== 0) {
      return { success: false, error: tarResult.stderr || "bundle creation failed" };
    }

    const sha256 = await sha256File(tarPath);
    const s3Uri = `${uriPrefix}${taskId}/${sha256}.tgz`;

    const uploadResult = await command("aws", ["s3", "cp", "--no-progress", tarPath, s3Uri]);

    if (uploadResult.status !== 0) {
      return {
        success: false,
        error: uploadResult.stderr || "S3 upload failed",
        uri: s3Uri,
        sha256,
      };
    }

    const bytes = statSync(tarPath).size;

    // Post evidence metadata to the bus evidence endpoint. Only ledger refs
    // (job_/exp_/bk_) are attached as refs; any other ref (or none) skips the
    // bus entirely — the server would reject the post with 422.
    if (busUrl && busToken && isLedgerRef(ref)) {
      const postResult = await fetch(`${busUrl}/v1/evidence`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${busToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          job_ref: ref,
          uri: s3Uri,
          sha256,
          kind: "bundle",
          bytes,
          produced_at: new Date().toISOString(),
        }),
      });

      if (!postResult.ok) {
        // The bundle landed in S3 but the ledger never learned about it: the task is NOT
        // evidenced. success stays false so the worker downgrades COMPLETED -> UNVERIFIED.
        return {
          success: false,
          uploaded: true,
          uri: s3Uri,
          sha256,
          bytes,
          error: `Bus POST failed: ${postResult.status}`,
        };
      }
    }

    return {
      success: true,
      uploaded: true,
      uri: s3Uri,
      sha256,
      bytes,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}
