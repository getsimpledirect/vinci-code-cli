import { vinciMaskSecrets } from "@earendil-works/pi-coding-agent";

const MODEL_SECRET = "<vinci-secret>";
const MODEL_PRIVATE_KEY = "<vinci-private-key>";

const renderForModel = (_value: string, kind: "secret" | "private-key"): string =>
  kind === "private-key" ? MODEL_PRIVATE_KEY : MODEL_SECRET;

export function redactSecrets(text: string): string {
  return vinciMaskSecrets(text, { render: renderForModel });
}

export function redactSecretsDeep(value: unknown, propertyName = ""): unknown {
  if (typeof value === "string") {
    return vinciMaskSecrets(value, { propertyName, render: renderForModel });
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    if (!propertyName || value === null || value === undefined) return value;
    const source = String(value);
    const masked = vinciMaskSecrets(source, { propertyName, render: renderForModel });
    return masked === source ? value : masked;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecretsDeep(entry));
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) redacted[key] = redactSecretsDeep(entry, key);
    return redacted;
  }
  return value;
}
