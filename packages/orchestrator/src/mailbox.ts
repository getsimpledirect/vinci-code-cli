// [vinci] Internal mailbox operations are available only with explicit opt-in.
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export interface MailboxEvent {
	v: 1;
	job: string;
	seq: number;
	ts: string;
	from: string;
	status: "running" | "done" | "blocked" | "question" | "failed";
	text: string;
	result: string | null;
}

const statuses = new Set(["running", "done", "blocked", "question", "failed"]);
const schema: Record<keyof MailboxEvent, (value: unknown) => boolean> = {
	v: (value) => value === 1,
	job: (value) => typeof value === "string",
	seq: (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1,
	ts: (value) => {
		if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
		const date = new Date(value);
		return (
			date.getUTCFullYear() >= 1 && !Number.isNaN(date.valueOf()) && date.toISOString() === `${value.slice(0, 23)}Z`
		);
	},
	from: (value) => typeof value === "string",
	status: (value) => typeof value === "string" && statuses.has(value),
	text: (value) => typeof value === "string" && !/[\r\n]/.test(value),
	result: (value) => value === null || typeof value === "string",
};
const eventFile = /^\d{10}-[0-9a-f-]{36}\.json$/;

export class MailboxError extends Error {
	code: number;
	constructor(message: string, code = 64) {
		super(message);
		this.code = code;
	}
}

export function mailboxEnabled(): boolean {
	return process.env.VINCI_INTERNAL_MAILBOX === "1";
}

export function requireMailbox(): void {
	if (!mailboxEnabled())
		throw new MailboxError('Internal mailbox is disabled; set "VINCI_INTERNAL_MAILBOX=1" to opt in.');
}

export function validateMailboxEvent(value: unknown): value is MailboxEvent {
	requireMailbox();
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === Object.keys(schema).length &&
		Object.entries(schema).every(([key, check]) => Object.hasOwn(record, key) && check(record[key]))
	);
}

function identifier(value: string): string {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value === "." || value === "..") {
		throw new MailboxError(`Invalid identifier ${JSON.stringify(value)}; use 1-64 safe characters.`);
	}
	return value;
}

function rootPath(): string {
	const value = process.env.MAILBOX_ROOT ?? join(homedir(), ".local/state/mailbox");
	const path = resolve(value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
	try {
		return realpathSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return path;
		throw error;
	}
}

function privateDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700, recursive: true });
	} catch (error) {
		throw new MailboxError(
			`Cannot create directory ${JSON.stringify(path)}: ${JSON.stringify(String(error))}; check the path.`,
		);
	}
	if (!lstatSync(path).isDirectory())
		throw new MailboxError(`Invalid directory ${JSON.stringify(path)}; use a real directory.`);
	chmodSync(path, 0o700);
}

export function newMailbox(owner: string, job = randomUUID().slice(0, 8)): string {
	requireMailbox();
	identifier(owner);
	identifier(job);
	const requestedRoot = rootPath();
	privateDirectory(requestedRoot);
	const root = realpathSync(requestedRoot);
	privateDirectory(join(root, owner));
	const directory = join(root, owner, `${job}-${randomUUID()}`);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	for (const box of ["in", "out", "tmp"]) privateDirectory(join(directory, box));
	return directory;
}

export function inspectMailbox(directory: string): { directory: string; job: string; identity: string } {
	requireMailbox();
	const path = resolve(directory);
	const root = realpathSync(rootPath());
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) {
		throw new MailboxError(
			`Mailbox ${JSON.stringify(directory)} is outside its root; choose a mailbox under MAILBOX_ROOT.`,
		);
	}
	for (let current = path; current !== root; current = dirname(current)) {
		if (!lstatSync(current).isDirectory())
			throw new MailboxError(`Invalid directory ${JSON.stringify(current)}; use real mailbox directories.`);
	}
	const identities: string[] = [];
	for (const box of ["in", "out", "tmp"]) {
		const stat = lstatSync(join(path, box));
		if (!stat.isDirectory()) throw new MailboxError(`Invalid box ${JSON.stringify(box)}; run mailbox new first.`);
		identities.push(`${stat.dev}:${stat.ino}`);
	}
	const name = basename(path);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name.slice(-36))) {
		throw new MailboxError(`Invalid mailbox name ${JSON.stringify(name)}; run mailbox new first.`);
	}
	const job = identifier(name.slice(0, -37));
	const stat = lstatSync(path);
	return { directory: path, job, identity: [`${stat.dev}:${stat.ino}`, ...identities].join("/") };
}

function checkBox(box: string): asserts box is "in" | "out" {
	if (box !== "in" && box !== "out") throw new MailboxError(`Invalid box ${JSON.stringify(box)}; use in or out.`);
}

export function readMailboxEvents(
	directory: string,
	box: string,
	report: (message: string) => void = console.error,
): MailboxEvent[] {
	const mailbox = inspectMailbox(directory);
	checkBox(box);
	const events: MailboxEvent[] = [];
	for (const name of readdirSync(join(mailbox.directory, box))
		.filter((name) => eventFile.test(name))
		.sort()) {
		const path = join(mailbox.directory, box, name);
		try {
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let event: unknown;
			try {
				if (!fstatSync(fd).isFile()) throw new Error("expected a regular event file");
				event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd)));
			} finally {
				closeSync(fd);
			}
			if (!validateMailboxEvent(event) || event.seq !== Number(name.slice(0, 10)) || event.job !== mailbox.job) {
				throw new Error("invalid event schema or mailbox identity");
			}
			events.push(event);
		} catch {
			report(`WARNING: skipped mailbox file ${JSON.stringify(path)}; repair or remove the malformed file.`);
		}
	}
	return events.sort((a, b) => a.seq - b.seq);
}

export async function sendMailboxEvent(
	directory: string,
	box: string,
	fields: Pick<MailboxEvent, "from" | "text" | "result"> & { status: string },
): Promise<number> {
	const mailbox = inspectMailbox(directory);
	checkBox(box);
	const event = {
		v: 1,
		job: mailbox.job,
		seq: 1,
		ts: "2000-01-01T00:00:00.000000Z",
		from: fields.from,
		status: fields.status,
		text: fields.text,
		result: fields.result,
	};
	if (!validateMailboxEvent(event))
		throw new MailboxError('Invalid event "fields"; supply a valid status, sender, one-line text and result.');
	const lock = join(mailbox.directory, `${box}.lock`);
	const deadline = performance.now() + 10_000;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			if (performance.now() >= deadline)
				throw new MailboxError(
					`Busy lock ${JSON.stringify(lock)} after 10 seconds; check its owner before retrying.`,
					75,
				);
			await delay(50);
		}
	}
	let staged: string | undefined;
	try {
		if (inspectMailbox(directory).identity !== mailbox.identity)
			throw new MailboxError(`Mailbox ${JSON.stringify(directory)} moved; reopen the intended mailbox.`);
		event.seq =
			1 +
			Math.max(
				0,
				...readdirSync(join(mailbox.directory, box))
					.filter((name) => eventFile.test(name))
					.map((name) => Number(name.slice(0, 10))),
			);
		if (event.seq > 9_999_999_999)
			throw new MailboxError(
				`Sequence ${JSON.stringify(event.seq)} exceeds the filename range; create a new mailbox.`,
			);
		event.ts = new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
		const token = randomUUID();
		staged = join(mailbox.directory, "tmp", `${event.seq}-${token}.json`);
		const destination = join(mailbox.directory, box, `${String(event.seq).padStart(10, "0")}-${token}.json`);
		const fd = openSync(staged, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(staged, destination);
		staged = undefined;
		const boxFd = openSync(join(mailbox.directory, box), constants.O_RDONLY);
		try {
			fsyncSync(boxFd);
		} finally {
			closeSync(boxFd);
		}
		return event.seq;
	} finally {
		if (staged) {
			try {
				unlinkSync(staged);
			} catch {
				/* A failed write may not have created it. */
			}
		}
		rmdirSync(lock);
	}
}

export async function waitMailboxEvent(
	directory: string,
	box: string,
	timeout: number,
	after = 0,
): Promise<MailboxEvent | undefined> {
	requireMailbox();
	if (!Number.isFinite(timeout) || timeout < 0 || !Number.isSafeInteger(after) || after < 0)
		throw new MailboxError(`Invalid wait bounds ${JSON.stringify([timeout, after])}; use finite nonnegative bounds.`);
	const deadline = performance.now() + timeout * 1000;
	while (true) {
		const event = readMailboxEvents(directory, box).find((event) => event.seq > after);
		if (event) return event;
		const remaining = deadline - performance.now();
		if (remaining <= 0) return undefined;
		await delay(Math.min(1000, remaining));
	}
}

export function listMailboxes(
	owner: string,
): { directory: string; status: MailboxEvent["status"] | "-"; seq: number }[] {
	requireMailbox();
	identifier(owner);
	const parent = join(rootPath(), owner);
	try {
		if (!lstatSync(parent).isDirectory())
			throw new MailboxError(`Invalid owner directory ${JSON.stringify(parent)}; use a real directory.`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	return readdirSync(parent)
		.sort()
		.flatMap((name) => {
			const directory = join(parent, name);
			try {
				const last = readMailboxEvents(directory, "out").at(-1);
				return [{ directory, status: last?.status ?? "-", seq: last?.seq ?? 0 }];
			} catch {
				console.error(`WARNING: skipped run ${JSON.stringify(directory)}; check the mailbox directory.`);
				return [];
			}
		});
}
