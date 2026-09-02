// Evidence upload management for Stage 2
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

import { isLedgerRef } from "./bus.mjs";
import { checkFence } from "./publisher.mjs";

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
  fence,
  // F6: extra bundle members by file name (`<attempt>.patch` for output: patch, artifacts.json
  // for output: artifact). Names are restricted to a single plain path component.
  extraFiles = {},
  // WStep-3 economics: `{ summary, sha256 }` built by the worker terminal seam. For ledger refs
  // these ride in the POST metadata so the ledger can reconstruct cost/custody per attempt.
  economics = null,
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
    for (const [name, contents] of Object.entries(extraFiles)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`evidence: unsafe bundle member name ${JSON.stringify(name)}`);
      writeFileSync(join(bundleDir, name), contents ?? "");
    }

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
      // Wave 1B L3: the evidence POST is a consequential side effect — ask the lease fence first.
      // A stale generation records `fenced_out:<reason>` and never reaches the ledger.
      if (fence) {
        const gate = await checkFence(fence, "evidence");
        if (!gate.valid) {
          // The BARE reason, exactly as publisher.publish records it: the `fenced_out` FIELD
          // names the class, so prefixing the value restates it and made two shapes of the same
          // fact (`revoked` at the push, `fenced_out:revoked` at the evidence POST).
          const fencedOut = gate.reason ?? "invalid";
          return { success: false, uploaded: true, uri: s3Uri, sha256, bytes, fenced_out: fencedOut, error: fencedOut };
        }
      }
      const metadata = {
        job_ref: ref,
        uri: s3Uri,
        sha256,
        kind: "bundle",
        bytes,
        produced_at: new Date().toISOString(),
      };
      // WStep-3: ledger-only economics metadata (ungoverned/unpriced tasks skip this whole branch
      // and never POST). Both fields are inert when economics was not built (e.g. early blockers).
      if (economics) {
        if (economics.summary && typeof economics.summary === "object") metadata.economics_summary = economics.summary;
        if (typeof economics.sha256 === "string") metadata.economics_sha256 = economics.sha256;
      }
      // Read through the fence at POST time (a getter on the live lease), never a value captured
      // when the fence was built.
      const generation = fence?.generation ?? null;
      if (generation !== null) metadata.fencing_generation = generation;
      const postResult = await fetch(`${busUrl}/v1/evidence`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${busToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
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
