// [vinci] Internal command group, hidden unless explicitly enabled.
import { resolve } from "node:path";
import {
	listMailboxes,
	MailboxError,
	newMailbox,
	requireMailbox,
	sendMailboxEvent,
	waitMailboxEvent,
} from "./mailbox.ts";
import { startMailboxAdapter } from "./mailbox-app-server.ts";

export async function runMailboxCommand(args: string[]): Promise<void> {
	requireMailbox();
	try {
		const [command, ...rest] = args;
		const flags = new Map<string, string>();
		const positional: string[] = [];
		const allowed: Record<string, string[]> = {
			new: ["--job"],
			send: ["--status", "--from", "--text", "--result"],
			wait: ["--timeout", "--after"],
			list: [],
			run: ["--codex-home", "--cwd", "--result"],
		};
		if (!Object.hasOwn(allowed, command ?? ""))
			throw new MailboxError(
				`Unknown mailbox command ${JSON.stringify(command)}; use new, send, wait, list or run.`,
			);
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg.startsWith("--")) {
				if (!allowed[command].includes(arg) || flags.has(arg) || rest[i + 1] === undefined)
					throw new MailboxError(
						`Invalid option ${JSON.stringify(arg)}; supply each supported option once with a value.`,
					);
				flags.set(arg, rest[++i]);
			} else positional.push(arg);
		}
		const expected = command === "send" || command === "wait" ? 2 : 1;
		if (positional.length !== expected)
			throw new MailboxError(
				`Invalid arguments ${JSON.stringify(positional)}; supply ${expected} positional arguments.`,
			);
		const [target, box] = positional;
		if (command === "new") console.log(newMailbox(target, flags.get("--job")));
		else if (command === "list") {
			for (const row of listMailboxes(target)) console.log(`${row.directory}\t${row.status}\t${row.seq}`);
		} else if (command === "send") {
			const status = flags.get("--status");
			const from = flags.get("--from");
			if (status === undefined || from === undefined)
				throw new MailboxError('Missing options "--status" or "--from"; supply both.');
			// The shared event validator checks the status at the write boundary.
			console.log(
				await sendMailboxEvent(target, box, {
					status,
					from,
					text: flags.get("--text") ?? "",
					result: flags.get("--result") ?? null,
				}),
			);
		} else if (command === "wait") {
			if (!flags.has("--timeout"))
				throw new MailboxError('Missing option "--timeout"; supply a finite nonnegative number of seconds.');
			const event = await waitMailboxEvent(
				target,
				box,
				Number(flags.get("--timeout")),
				Number(flags.get("--after") ?? 0),
			);
			if (event) console.log(JSON.stringify(event));
			else process.exitCode = 2;
		} else {
			const codexHome = flags.get("--codex-home");
			if (!codexHome)
				throw new MailboxError('Missing option "--codex-home"; supply the job\'s own configuration directory.');
			const adapter = await startMailboxAdapter({
				directory: target,
				codexHome: resolve(codexHome),
				cwd: resolve(flags.get("--cwd") ?? process.cwd()),
				resultPath: flags.get("--result"),
			});
			const stop = () => {
				void adapter.stop().catch(() => {});
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			try {
				await adapter.finished;
			} finally {
				process.off("SIGINT", stop);
				process.off("SIGTERM", stop);
			}
		}
	} catch (error) {
		console.error(
			`ERROR: mailbox command refused ${JSON.stringify(error instanceof Error ? error.message : String(error))}; correct the arguments or job configuration.`,
		);
		process.exitCode = error instanceof MailboxError ? error.code : 74;
	}
}
