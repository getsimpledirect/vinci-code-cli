import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const here = dirname(fileURLToPath(import.meta.url));
const loader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const provenance = await loader.import(resolve(here, "../extensions/vinci-model-provenance.ts"), { default: false });

const { classifyVinciModelError } = provenance;

const IN_FLIGHT_402 = Object.assign(new Error("in_flight_budget_exhausted"), { status: 402 });
const AFFORDABILITY_402 = Object.assign(new Error("but can only afford 23014"), { status: 402 });

console.log(`in-flight 402: ${classifyVinciModelError(IN_FLIGHT_402)}`);
console.log(`affordability 402: ${classifyVinciModelError(AFFORDABILITY_402)}`);

