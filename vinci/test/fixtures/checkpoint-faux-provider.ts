import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const registration = registerFauxProvider({ tokensPerSecond: 1000 });
registration.setResponses([
  fauxAssistantMessage(
    fauxToolCall(
      "write",
      { path: "interrupted.txt", content: "written once before process death\n" },
      { id: "checkpoint-process-write" },
    ),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("Resume completed without replaying the write."),
]);

export default function (pi: ExtensionAPI) {
  pi.registerProvider("faux", {
    name: "Checkpoint faux provider",
    baseUrl: "http://localhost:0",
    apiKey: "checkpoint-test-key",
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
