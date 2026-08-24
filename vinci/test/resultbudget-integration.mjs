// Vinci Code — integration test for the per-tool-result context budget (GAP_ANALYSIS #53).
// Drives the REAL built modules (no gateway): the budget's env gating/overrides, and that
// truncateHead with the Vinci budget genuinely caps tighter than upstream's 2000-line / 50KB.
// Run: node vinci/test/resultbudget-integration.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "packages", "coding-agent", "dist", "core", "tools");
const { vinciResultBudget, vinciResultBudgetEnabled } = await import(join(dist, "vinci-result-budget.js"));
const { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = await import(join(dist, "truncate.js"));

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; if (!cond) console.log(`  ✗ ${label}`); };
// Restore a clean env around each case (functions read process.env at call time).
const ENV_KEYS = ["VINCI_CODE", "VINCI_NO_RESULT_BUDGET", "VINCI_RESULT_MAX_BYTES", "VINCI_RESULT_MAX_LINES"];
const clearEnv = () => ENV_KEYS.forEach((k) => delete process.env[k]);

// ── env gating ──
clearEnv();
ok("disabled when VINCI_CODE unset", vinciResultBudgetEnabled() === false);
process.env.VINCI_CODE = "1";
ok("enabled when VINCI_CODE=1", vinciResultBudgetEnabled() === true);
process.env.VINCI_NO_RESULT_BUDGET = "1";
ok("kill switch disables it", vinciResultBudgetEnabled() === false);

// ── budget defaults + env overrides ──
clearEnv();
process.env.VINCI_CODE = "1";
const def = vinciResultBudget();
ok("default budget is tighter than upstream bytes", def.maxBytes < DEFAULT_MAX_BYTES);
ok("default budget is tighter than upstream lines", def.maxLines < DEFAULT_MAX_LINES);
process.env.VINCI_RESULT_MAX_BYTES = "8192";
process.env.VINCI_RESULT_MAX_LINES = "300";
const tuned = vinciResultBudget();
ok("env overrides bytes", tuned.maxBytes === 8192);
ok("env overrides lines", tuned.maxLines === 300);
process.env.VINCI_RESULT_MAX_BYTES = "0"; // invalid → fall back to default
ok("invalid env falls back to default bytes", vinciResultBudget().maxBytes === def.maxBytes);

// ── the wiring math: Vinci budget caps genuinely tighter than upstream ──
clearEnv();
process.env.VINCI_CODE = "1";
const budget = vinciResultBudget();
// A byte-heavy blob (80KB): upstream truncates at 50KB, Vinci at ~24KB.
const bigBytes = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(72)}`).join("\n");
const upstreamB = truncateHead(bigBytes);
const vinciB = truncateHead(bigBytes, budget);
ok("upstream truncates the 80KB blob", upstreamB.truncated === true);
ok("vinci truncates the 80KB blob", vinciB.truncated === true);
ok("vinci keeps fewer bytes than upstream", vinciB.outputBytes < upstreamB.outputBytes);
ok("vinci respects its byte cap", vinciB.outputBytes <= budget.maxBytes);
// A line-heavy blob (3000 short lines): upstream caps at 2000 lines, Vinci at 1200.
const manyLines = Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n");
const upstreamL = truncateHead(manyLines);
const vinciL = truncateHead(manyLines, budget);
ok("upstream caps at 2000 lines", upstreamL.outputLines === DEFAULT_MAX_LINES);
ok("vinci caps at its tighter line budget", vinciL.outputLines === budget.maxLines);
ok("vinci keeps fewer lines than upstream", vinciL.outputLines < upstreamL.outputLines);

clearEnv();
console.log(`resultbudget-integration: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
