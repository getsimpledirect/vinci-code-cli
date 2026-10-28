import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	checkInstalledSandbox,
	checkSandboxSource,
	sandboxArchivePath,
	sandboxSourcePath,
} from "../../../scripts/check-sandbox-runtime-source.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const projectRequire = createRequire(new URL("../../../package.json", import.meta.url));
const installed = dirname(projectRequire.resolve("@anthropic-ai/sandbox-runtime/package.json"));
const consumerRequire = createRequire(join(installed, "package.json"));
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/sandbox-config-conformance.json", import.meta.url), "utf8"),
) as {
	upstream: string;
	cases: { input: unknown; success: boolean; data?: unknown }[];
};

describe("installed sandbox consumer", () => {
	it("retains every sealed upstream runtime file and platform asset", () => {
		expect(checkSandboxSource(repository).files.size).toBe(77);
		expect(checkInstalledSandbox(installed, repository).version).toBe("0.0.26-vinci.zod4.1");
		expect(consumerRequire("zod/package.json").version).toBe("4.6.6");
	});
	it("retains the original schema corpus size and provenance", () => {
		expect(fixture.upstream).toBe("@anthropic-ai/sandbox-runtime@0.0.26 with zod@3.25.76");
		expect(fixture.cases).toHaveLength(359);
		expect(fixture.cases.filter((entry) => entry.success)).toHaveLength(49);
	});
	for (const [index, entry] of fixture.cases.entries()) {
		it(`preserves configuration acceptance and output for original case ${index}`, () => {
			const parsed = SandboxRuntimeConfigSchema.safeParse(entry.input);
			expect(parsed.success).toBe(entry.success);
			if (parsed.success) expect(parsed.data).toEqual(entry.data);
		});
	}
	it("uses the patched constrained-array early rejection in the actual consumer binding", () => {
		const { z: consumerZod } = consumerRequire("zod") as { z: typeof z };
		let calls = 0;
		const schema = consumerZod
			.array(
				consumerZod.string().refine(() => {
					calls++;
					return false;
				}),
			)
			.max(1);
		expect(schema.safeParse(Array(128).fill("bounded fixture")).success).toBe(false);
		expect(calls).toBe(0);
	});
});

describe("sealed sandbox inventory controls", () => {
	for (const name of ["source-seal.json", "schema.ts.txt", "sandbox-runtime-0.0.26-vinci.zod4.1.tgz"]) {
		it(`refuses altered repository source ${name}`, () => {
			const temporary = mkdtempSync(join(tmpdir(), "sandbox-source-seal-"));
			try {
				mkdirSync(dirname(join(temporary, sandboxSourcePath)), { recursive: true });
				cpSync(join(repository, sandboxSourcePath), join(temporary, sandboxSourcePath), { recursive: true });
				const path = name.endsWith(".tgz")
					? join(temporary, sandboxArchivePath)
					: join(temporary, sandboxSourcePath, name);
				writeFileSync(path, "altered bounded fixture\n");
				expect(() => checkSandboxSource(temporary)).toThrow(/Sandbox/);
			} finally {
				rmSync(temporary, { recursive: true, force: true });
			}
		});
	}
	for (const kind of ["changed runtime", "missing binary", "extra file", "altered seal"] as const) {
		it(`refuses ${kind}`, () => {
			const temporary = mkdtempSync(join(tmpdir(), "sandbox-seal-"));
			const copy = join(temporary, "runtime");
			try {
				cpSync(installed, copy, {
					recursive: true,
					filter: (path) => !path.startsWith(join(installed, "node_modules")),
				});
				if (kind === "changed runtime") writeFileSync(join(copy, "dist/index.js"), "export {};\n");
				if (kind === "missing binary") rmSync(join(copy, "vendor/seccomp/x64/apply-seccomp"));
				if (kind === "extra file") writeFileSync(join(copy, "unexpected.js"), "export {};\n");
				if (kind === "altered seal") writeFileSync(join(copy, "source-seal.json"), "{}\n");
				expect(() => checkInstalledSandbox(copy, repository)).toThrow(/Installed sandbox/);
			} finally {
				rmSync(temporary, { recursive: true, force: true });
			}
		});
	}
});
