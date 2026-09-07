import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROVIDER_KEY_ENV } from "./cleanroom.mjs";

const SEEDED_PROVIDERS = Object.freeze({
  vllm: Object.freeze({
    api: "openai-completions",
    apiKeyEnv: "VLLM_API_KEY",
    baseUrlEnv: "VLLM_BASE_URL",
  }),
});

const PROVIDER_FIELDS = new Set([
  "name", "baseUrl", "apiKey", "api", "headers", "compat", "authHeader", "models", "modelOverrides",
]);
const MODEL_FIELDS = new Set([
  "id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow",
  "maxTokens", "headers", "compat",
]);
const MODEL_OVERRIDE_FIELDS = new Set([
  "name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "headers", "compat",
]);
const THINKING_FIELDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const COMPAT_FIELDS = new Set([
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "cacheControlFormat",
  "supportsStrictMode",
  "supportsLongCacheRetention",
  "sendSessionIdHeader",
  "supportsEagerToolInputStreaming",
  "sendSessionAffinityHeaders",
  "supportsCacheControlOnTools",
  "forceAdaptiveThinking",
]);

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`provider definitions: ${label} must be an object`);
  }
  return value;
}

function assertKnownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`provider definitions: unsupported ${label} field ${key}`);
  }
}

function projectScalarObject(value, fields, label) {
  if (value === undefined) return undefined;
  const source = record(value, label);
  assertKnownFields(source, fields, label);
  const projected = {};
  for (const [key, item] of Object.entries(source)) {
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new Error(`provider definitions: ${label}.${key} must be a scalar`);
    }
    projected[key] = item;
  }
  return projected;
}

function projectInput(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => item !== "text" && item !== "image")) {
    throw new Error(`provider definitions: ${label} must contain only text/image`);
  }
  return [...value];
}

function validateBaseUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`provider definitions: ${label} must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`provider definitions: ${label} may not carry credentials, query parameters, or fragments`);
  }
}

function safeBaseUrl(value, environment, label) {
  const variable = environment.baseUrlEnv;
  const reference = value === `$${variable}` || value === `\${${variable}}`;
  const configured = process.env[variable];
  if (!configured) throw new Error(`provider definitions: ${variable} is required`);
  validateBaseUrl(configured, variable);
  if (!reference) validateBaseUrl(value, label);
  if (!reference && value !== configured) {
    throw new Error(`provider definitions: ${label} does not match ${variable}`);
  }
  return configured;
}

function projectCompat(value, label) {
  return projectScalarObject(value, COMPAT_FIELDS, label);
}

function projectModel(sourceValue, environment, label) {
  const source = record(sourceValue, label);
  assertKnownFields(source, MODEL_FIELDS, label);
  if (source.headers !== undefined) throw new Error(`provider definitions: ${label}.headers are not safe to seed`);
  if (typeof source.id !== "string" || !source.id) throw new Error(`provider definitions: ${label}.id is required`);
  if (source.api !== undefined && source.api !== environment.api) {
    throw new Error(`provider definitions: ${label}.api must be ${environment.api}`);
  }
  const projected = { id: source.id };
  for (const key of ["name", "reasoning", "contextWindow", "maxTokens"]) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  if (source.api !== undefined) projected.api = environment.api;
  if (source.baseUrl !== undefined) projected.baseUrl = safeBaseUrl(source.baseUrl, environment, `${label}.baseUrl`);
  const thinking = projectScalarObject(source.thinkingLevelMap, THINKING_FIELDS, `${label}.thinkingLevelMap`);
  if (thinking !== undefined) projected.thinkingLevelMap = thinking;
  const input = projectInput(source.input, `${label}.input`);
  if (input !== undefined) projected.input = input;
  const cost = projectScalarObject(source.cost, COST_FIELDS, `${label}.cost`);
  if (cost !== undefined) projected.cost = cost;
  const compat = projectCompat(source.compat, `${label}.compat`);
  if (compat !== undefined) projected.compat = compat;
  return projected;
}

function projectOverride(sourceValue, label) {
  const source = record(sourceValue, label);
  assertKnownFields(source, MODEL_OVERRIDE_FIELDS, label);
  if (source.headers !== undefined) throw new Error(`provider definitions: ${label}.headers are not safe to seed`);
  const projected = {};
  for (const key of ["name", "reasoning", "contextWindow", "maxTokens"]) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  const thinking = projectScalarObject(source.thinkingLevelMap, THINKING_FIELDS, `${label}.thinkingLevelMap`);
  if (thinking !== undefined) projected.thinkingLevelMap = thinking;
  const input = projectInput(source.input, `${label}.input`);
  if (input !== undefined) projected.input = input;
  const cost = projectScalarObject(source.cost, COST_FIELDS, `${label}.cost`);
  if (cost !== undefined) projected.cost = cost;
  const compat = projectCompat(source.compat, `${label}.compat`);
  if (compat !== undefined) projected.compat = compat;
  return projected;
}

function projectProvider(provider, model, sourceValue, environment) {
  const source = record(sourceValue, `provider ${provider}`);
  assertKnownFields(source, PROVIDER_FIELDS, `provider ${provider}`);
  if (source.headers !== undefined) throw new Error(`provider definitions: provider ${provider}.headers are not safe to seed`);
  const providerKeys = Object.hasOwn(PROVIDER_KEY_ENV, provider) ? PROVIDER_KEY_ENV[provider] : [];
  if (providerKeys.length !== 1 || providerKeys[0] !== environment.apiKeyEnv) {
    throw new Error(`provider definitions: ${provider} has no single approved credential environment`);
  }
  if (source.apiKey !== `$${environment.apiKeyEnv}` && source.apiKey !== `\${${environment.apiKeyEnv}}`) {
    throw new Error(`provider definitions: provider ${provider}.apiKey must be an exact ${environment.apiKeyEnv} reference`);
  }
  if (source.api !== undefined && source.api !== environment.api) {
    throw new Error(`provider definitions: provider ${provider}.api must be ${environment.api}`);
  }
  if (!Array.isArray(source.models)) throw new Error(`provider definitions: provider ${provider}.models is required`);
  const selected = source.models.filter((candidate) => candidate?.id === model);
  if (selected.length !== 1) throw new Error(`provider definitions: expected exactly one ${provider}/${model} model`);
  const projected = {
    apiKey: `$${environment.apiKeyEnv}`,
    baseUrl: safeBaseUrl(source.baseUrl, environment, `provider ${provider}.baseUrl`),
    api: environment.api,
    models: [projectModel(selected[0], environment, `provider ${provider}.models[${model}]`)],
  };
  if (typeof source.name === "string" && source.name) projected.name = source.name;
  if (source.authHeader !== undefined) projected.authHeader = source.authHeader;
  const compat = projectCompat(source.compat, `provider ${provider}.compat`);
  if (compat !== undefined) projected.compat = compat;
  if (source.modelOverrides !== undefined) {
    const overrides = record(source.modelOverrides, `provider ${provider}.modelOverrides`);
    const selectedOverride = overrides[model];
    if (selectedOverride !== undefined) {
      projected.modelOverrides = { [model]: projectOverride(selectedOverride, `provider ${provider}.modelOverrides[${model}]`) };
    }
  }
  return projected;
}

export function seedProviderDefinitions(agentDir, provider, model) {
  const environment = SEEDED_PROVIDERS[provider];
  if (!environment) return { seeded: false, reason: "provider_not_seeded" };
  const home = process.env.HOME;
  if (!home) return { seeded: false, reason: "home_missing" };
  const sourcePath = join(home, ".pi", "agent", "models.json");
  let contents;
  try {
    contents = readFileSync(sourcePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { seeded: false, reason: "definitions_missing" };
    throw new Error(`provider definitions: cannot read ${sourcePath} (${error?.code ?? "read_error"})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`provider definitions: malformed JSON in ${sourcePath}`);
  }
  const providers = record(parsed, "models.json").providers;
  const providerTable = record(providers, "models.json.providers");
  if (!Object.hasOwn(providerTable, provider)) return { seeded: false, reason: "provider_missing" };
  const output = { providers: { [provider]: projectProvider(provider, model, providerTable[provider], environment) } };
  const target = join(agentDir, "models.json");
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return { seeded: true, reason: "selected_provider_only" };
}
