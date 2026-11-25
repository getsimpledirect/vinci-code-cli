import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export class VinciLines {
	private readonly rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	private readonly stop = new AbortController();
	private interrupt?: () => void;
	private readonly onInterrupt = () => (this.interrupt ? this.interrupt() : this.close());
	private readonly onTerminate = () => this.close();

	constructor() {
		this.rl.once("close", () => this.stop.abort());
		process.on("SIGINT", this.onInterrupt);
		process.on("SIGTERM", this.onTerminate);
	}

	get signal(): AbortSignal {
		return this.stop.signal;
	}

	write(message: string): void {
		process.stdout.write(`${message}\n`);
	}

	handleInterrupt(handler: () => void): () => void {
		const previous = this.interrupt;
		this.interrupt = handler;
		return () => {
			this.interrupt = previous;
		};
	}

	async ask(
		prompt: string,
		options?: { signal?: AbortSignal; timeout?: number; secret?: boolean },
	): Promise<string | undefined> {
		const signals = [this.signal];
		if (options?.signal) signals.push(options.signal);
		if (options?.timeout) signals.push(AbortSignal.timeout(options.timeout));
		const signal = AbortSignal.any(signals);
		if (signal.aborted) return undefined;
		const restoreEcho = options?.secret ? this.disableEcho() : undefined;
		try {
			return await this.rl.question(prompt, { signal });
		} catch (error) {
			if (signal.aborted) return undefined;
			throw error;
		} finally {
			if (restoreEcho) {
				restoreEcho();
				this.write("");
			}
		}
	}

	async select<T>(entries: readonly T[], label: (entry: T) => string, signal?: AbortSignal): Promise<T | undefined> {
		this.write(entries.map((entry, index) => `  ${index + 1}. ${label(entry)}`).join("\n"));
		const choice = await this.ask("Choice (Enter cancels): ", { signal });
		return choice && /^\d+$/.test(choice) ? entries[Number(choice) - 1] : undefined;
	}

	close(): void {
		this.stop.abort();
		this.rl.close();
		process.off("SIGINT", this.onInterrupt);
		process.off("SIGTERM", this.onTerminate);
	}

	private disableEcho(): () => void {
		const saved = spawnSync("stty", ["-g"], { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] });
		const mode = saved.stdout?.trim();
		const setMode = (value: string) => spawnSync("stty", [value], { stdio: ["inherit", "ignore", "ignore"] }).status;
		if (saved.status !== 0 || !mode || setMode("-echo") !== 0) {
			throw new Error("Could not disable terminal echo. Reopen /login in a rich terminal to enter a key.");
		}
		return () => {
			setMode(mode);
		};
	}
}

export async function selectVinciPlain(title: string, options: readonly string[]): Promise<string | undefined> {
	const lines = new VinciLines();
	try {
		lines.write(title);
		return await lines.select(options, (option) => option);
	} finally {
		lines.close();
	}
}

export async function inputVinciPlain(title: string): Promise<string | undefined> {
	const lines = new VinciLines();
	try {
		return await lines.ask(`${title} `);
	} finally {
		lines.close();
	}
}
