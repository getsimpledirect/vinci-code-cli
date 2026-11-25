import { basename } from "node:path";
import type { ImageContent, OAuthProviderId } from "@earendil-works/pi-ai/compat";
import {
	getVinciLook,
	hasVinciCredentials,
	runVinciWelcome,
	vinciEnvironmentBadge,
} from "../../../../vinci/extensions/lib/cli-look.ts";
import { getVinciVersion } from "../../../../vinci/extensions/lib/product-version.ts";
import {
	getVinciUiState,
	setVinciConnection,
	setVinciPromptState,
	subscribeVinciUiState,
} from "../../../../vinci/extensions/lib/ui-state.ts";
import { getVeroPresentation } from "../../../../vinci/extensions/lib/vero-presentation.ts";
import { VinciLines } from "../cli/vinci-lines.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { noOpUIContext } from "../core/extensions/runner.ts";
import { FooterDataProvider } from "../core/footer-data-provider.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { isSupportedSignInUrl } from "./interactive/components/login-dialog.ts";
import {
	getLoginProviderOptions,
	getModelCandidates,
	selectDefaultModelAfterAuthentication,
} from "./interactive/interactive-mode.ts";

type PlainModeOptions = {
	agentDir: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	messages: string[];
};

async function chooseProvider(
	session: AgentSession,
	lines: VinciLines,
	agentDir: string,
	authType?: "oauth" | "api_key",
): Promise<void> {
	const registry = session.modelRegistry;
	const settings = session.settingsManager;
	const providers = settings.getShowOtherProviders()
		? getLoginProviderOptions(registry, authType)
		: [{ id: "vinci", name: "Vinci", authType: "oauth" as const }];
	lines.write("How do you want to sign in?");
	const chosen = await lines.select(
		providers,
		(provider) => `${provider.name} - ${provider.authType === "oauth" ? "account" : "API key"}`,
	);
	if (chosen) await signIn(session, lines, agentDir, chosen);
}

async function signIn(
	session: AgentSession,
	lines: VinciLines,
	agentDir: string,
	{ id, name, authType }: { id: string; name: string; authType: "oauth" | "api_key" },
): Promise<void> {
	const registry = session.modelRegistry;
	const previousModel = session.model;
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, lines.signal]);
	const restoreInterrupt = lines.handleInterrupt(() => controller.abort());
	let manualCode: Promise<string> | undefined;
	const ask = async (message: string, secret = true): Promise<string> => {
		const answer = await lines.ask(`${message} `, { signal, secret });
		if (answer === undefined || !answer.trim()) throw new Error("Login cancelled");
		return answer;
	};
	const showUrl = (url: string) => {
		if (!isSupportedSignInUrl(url, false)) throw new Error("The provider returned an unsupported sign-in URL.");
		lines.write(url);
	};
	setVinciPromptState("input");
	try {
		if (authType === "api_key") {
			if (id === "amazon-bedrock") {
				lines.write(
					"Configure an AWS profile, IAM keys, bearer token, or role-based credentials. Run /login to choose another provider.",
				);
				return;
			}
			registry.authStorage.set(id, { type: "api_key", key: (await ask("Enter API key:")).trim() });
		} else {
			const usesCallback = registry.authStorage
				.getOAuthProviders()
				.some((provider) => provider.id === id && provider.usesCallbackServer);
			lines.write(`Sign in to ${name}. Ctrl+C cancels.`);
			await registry.authStorage.login(id as OAuthProviderId, {
				signal,
				onAuth: ({ url, instructions }) => {
					showUrl(url);
					openBrowser(url);
					if (instructions) lines.write(instructions);
					if (usesCallback) {
						manualCode = ask("Paste redirect URL, or finish sign-in in your browser:");
						void manualCode.catch(() => {});
					}
				},
				onDeviceCode: ({ verificationUri, userCode }) => {
					showUrl(verificationUri);
					lines.write(`Enter code: ${userCode}`);
				},
				onProgress: (message) => lines.write(message),
				onPrompt: async ({ message }) => {
					const answer = await lines.ask(`${message} `, { signal, secret: true });
					if (answer === undefined) throw new Error("Login cancelled");
					return answer;
				},
				onSelect: async ({ message, options }) => {
					lines.write(message);
					return (await lines.select(options, (option) => option.label, signal))?.id;
				},
				onManualCodeInput: () => manualCode ?? ask("Paste redirect URL:"),
			});
		}
		signal.throwIfAborted();
		registry.refresh();
		setVinciConnection(hasVinciCredentials(agentDir) ? "signed-in" : "signed-out");
		const actionLabel = authType === "api_key" ? `Saved API key for ${name}` : `Logged in to ${name}`;
		const { selectedModel, selectionError } = await selectDefaultModelAfterAuthentication(
			session,
			id,
			previousModel,
			actionLabel,
		);
		lines.write(
			selectionError ??
				`${actionLabel}.${selectedModel ? ` Selected ${selectedModel.id}.` : ""} Use /model to select a model.`,
		);
	} catch (error) {
		const reason = signal.aborted ? "Sign-in cancelled" : error instanceof Error ? error.message : String(error);
		lines.write(`${reason}. Run /login to start again.`);
	} finally {
		controller.abort();
		restoreInterrupt();
		setVinciPromptState(undefined);
	}
}

export async function runVinciPlainMode(runtime: AgentSessionRuntime, options: PlainModeOptions): Promise<void> {
	const lines = new VinciLines();
	let unsubscribeSession: (() => void) | undefined;
	const stateLine = () => {
		const { label, detail } = getVeroPresentation();
		return detail ? `${label} - ${detail.replaceAll("…", "...")}` : label;
	};
	let displayedState: string | undefined;
	const showState = () => {
		const next = stateLine();
		if (displayedState === next) return;
		displayedState = next;
		lines.write(`  ${next}`);
	};
	let unsubscribeState: (() => void) | undefined;
	const withPrompt = async <T>(kind: "input" | "approval", operation: () => Promise<T>): Promise<T> => {
		setVinciPromptState(kind);
		try {
			return await operation();
		} finally {
			setVinciPromptState(undefined);
		}
	};
	const bind = async () => {
		const session = runtime.session;
		unsubscribeSession?.();
		await session.bindExtensions({
			mode: "tui",
			uiContext: {
				...noOpUIContext,
				select: (title, entries, opts) =>
					withPrompt(opts?.vinciReviewContext ? "approval" : "input", () => {
						lines.write(title);
						return lines.select(entries, (entry) => entry, opts?.signal);
					}),
				confirm: (title, message, opts) =>
					withPrompt("approval", async () =>
						/^(?:y|yes)$/i.test((await lines.ask(`${title}\n${message} [y/N] `, opts))?.trim() ?? ""),
					),
				input: (title, _placeholder, opts) => withPrompt("input", () => lines.ask(`${title} `, opts)),
				editor: (title, prefill) => withPrompt("input", async () => (await lines.ask(`${title} `)) || prefill),
				notify: (message) => lines.write(message),
				setStatus: () => {},
			},
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: (opts) => runtime.newSession(opts),
				fork: async (entryId, opts) => ({ cancelled: (await runtime.fork(entryId, opts)).cancelled }),
				navigateTree: (targetId, opts) => session.navigateTree(targetId, opts),
				switchSession: (path, opts) => runtime.switchSession(path, opts),
				reload: () => session.reload(),
			},
			shutdownHandler: () => lines.close(),
			onError: (error) => lines.write(`Error - ${error.error}`),
		});
		unsubscribeSession = session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason !== "error"
			) {
				const answer = event.message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
				if (answer) lines.write(answer);
			}
			showState();
		});
	};
	runtime.setRebindSession(bind);
	const width = () => process.stdout.columns || 80;
	const connectionState = () => {
		const connection = getVinciUiState().connection;
		if (connection === "connected" || connection === "reconnect") return connection;
		return hasVinciCredentials(options.agentDir) ? "signed-in" : "signed-out";
	};
	const writeHeader = () => {
		const session = runtime.session;
		const cwd = session.sessionManager.getCwd();
		const footer = new FooterDataProvider(cwd);
		try {
			lines.write(
				getVinciLook(width())
					.header({
						version: getVinciVersion(),
						project: basename(cwd) || cwd,
						branch: footer.getGitBranch() || undefined,
						model: session.model?.name ?? session.model?.id,
						environment: vinciEnvironmentBadge(),
						connection: connectionState(),
					})
					.join("\n"),
			);
		} finally {
			footer.dispose();
		}
	};
	const prompt = async (text: string, images?: ImageContent[]) => {
		try {
			await runtime.session.prompt(text, { images });
		} catch (error) {
			lines.write(`Error - ${error instanceof Error ? error.message : error}`);
		}
		showState();
	};

	const abort = () => {
		void runtime.session.abort();
	};
	lines.signal.addEventListener("abort", abort);
	try {
		await bind();
		const session = runtime.session;
		if (!session.sessionManager.getEntries().some((entry) => entry.type === "message")) {
			const welcome = await runVinciWelcome({
				profile: options.agentDir,
				signedIn: hasVinciCredentials(options.agentDir),
				showOtherProviders: !session.settingsManager.areOtherProvidersExplicitlyDisabled(),
				select: async (choices) => {
					lines.write(getVinciLook(width()).welcome(getVinciVersion(), choices, 0).join("\n"));
					while (!lines.signal.aborted) {
						const number = await lines.ask("");
						if (number === undefined) return;
						const choice = /^\d+$/.test(number.trim()) ? choices[Number(number) - 1] : undefined;
						if (choice) return choice.id;
						lines.write("Enter one of the displayed choice numbers.");
					}
				},
				pair: () => signIn(session, lines, options.agentDir, { id: "vinci", name: "Vinci", authType: "oauth" }),
				key: async () => {
					session.settingsManager.setShowOtherProviders(true);
					await chooseProvider(session, lines, options.agentDir, "api_key");
				},
			});
			if (welcome === "quit") return;
		}
		writeHeader();
		let displayedConnection = connectionState();
		unsubscribeState = subscribeVinciUiState(() => {
			const connection = connectionState();
			if (connection !== displayedConnection) {
				displayedConnection = connection;
				lines.write(`  ${getVinciLook(width()).connectionLabel(connection)}`);
			}
			showState();
		});
		showState();
		if (options.initialMessage) await prompt(options.initialMessage, options.initialImages);
		for (const message of options.messages) await prompt(message);
		while (!lines.signal.aborted) {
			const input = (await lines.ask("> "))?.trim();
			if (input === undefined || input === "/quit" || input === "/exit") break;
			if (!input) continue;
			const current = runtime.session;
			if (input === "/login") {
				if (current.settingsManager.getShowOtherProviders()) {
					await chooseProvider(current, lines, options.agentDir);
				} else {
					await signIn(current, lines, options.agentDir, { id: "vinci", name: "Vinci", authType: "oauth" });
				}
			} else if (input === "/model") {
				const models = await getModelCandidates(current, current.settingsManager, { fallbackToAvailable: true });
				if (!models.length) lines.write("No model is available. Run /login to connect.");
				else {
					const model = await lines.select(models, (candidate) => candidate.name || candidate.id);
					if (model) await current.setModel(model);
					writeHeader();
				}
			} else if (input === "/other") {
				const label = await lines.select(["Enable other providers", "Hide other providers"], (choice) => choice);
				if (label) current.settingsManager.setShowOtherProviders(label === "Enable other providers");
				lines.write(`Other providers are ${current.settingsManager.getShowOtherProviders() ? "on" : "off"}.`);
			} else if (input === "/logout") {
				const registry = current.modelRegistry;
				const provider = await lines.select(registry.authStorage.list(), (id) =>
					registry.getProviderDisplayName(id),
				);
				if (provider) registry.authStorage.logout(provider);
				registry.refresh();
				setVinciConnection(hasVinciCredentials(options.agentDir) ? "signed-in" : "signed-out");
			} else if (input === "/new") {
				await runtime.newSession();
				writeHeader();
			} else if (input === "/reload") {
				await current.reload();
				writeHeader();
			} else if (input === "/compact") {
				await current.compact();
			} else if (input === "/help") {
				lines.write("/login, /logout, /model, /other, /new, /reload, /compact, /undo, /quit");
			} else await prompt(input);
		}
	} finally {
		unsubscribeState?.();
		unsubscribeSession?.();
		lines.signal.removeEventListener("abort", abort);
		lines.close();
		await runtime.dispose();
	}
}
