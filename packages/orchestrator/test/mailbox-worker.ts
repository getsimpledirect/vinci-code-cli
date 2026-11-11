import { sendMailboxEvent } from "../src/mailbox.ts";

const [directory, count, size] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
	await sendMailboxEvent(directory, "in", {
		from: "client",
		status: "running",
		text: "x".repeat(Number(size)),
		result: null,
	});
}
