import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { qwenProviderConfig } from "../../extensions/vinci-qwen-provider.ts";

const registration = registerFauxProvider({ tokensPerSecond: 1_000 });

export default function (pi: ExtensionAPI) {
  if (typeof qwenProviderConfig !== "function") throw new Error("qwen_loader_probe_missing_export");
  pi.registerProvider("qwen-loader-probe", {
    name: "Qwen loader probe",
    baseUrl: "http://localhost:0",
    apiKey: "loader-probe-not-a-secret",
    api: registration.api,
    models: registration.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  pi.on("session_shutdown", () => registration.unregister());
}
