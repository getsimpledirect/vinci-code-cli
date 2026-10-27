import { afterEach, describe, expect, test, vi } from "vitest";
import registerVinci from "../../../vinci/extensions/vinci-provider.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ProviderConfig } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";

describe("registered Vinci CLI classes", () => {
	afterEach(() => vi.unstubAllEnvs());

	test.each(["mezzo", "forte", "auto", "fortissimo"])("resolves %s through the registered provider", (id) => {
		vi.stubEnv("VINCI_CODE", "1");
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registerVinci({
			registerProvider: (provider: string, config: ProviderConfig) =>
				modelRegistry.registerProvider(provider, config),
			on: () => {},
		} as unknown as ExtensionAPI);
		for (const cliProvider of ["vinci", "VINCI"]) {
			for (const cliModel of [id, `vinci/${id}`, id.toUpperCase(), `VINCI/${id.toUpperCase()}`]) {
				const result = resolveCliModel({ cliProvider, cliModel, modelRegistry });
				expect(result.error).toBeUndefined();
				expect(result.warning).toBeUndefined();
				expect(result.model?.provider).toBe("vinci");
				expect(result.model?.id).toBe(id === "fortissimo" ? "forte" : id);
			}
		}
	});
});
