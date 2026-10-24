import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EPISODE_STATES, EpisodeJournal, JournalError, episodeExists } from "../src/index.mjs";

function root() {
  const path = mkdtempSync(join(tmpdir(), "vinci-broker-journal-"));
  mkdirSync(join(path, "state"));
  return join(path, "state");
}

test("episode journal is monotonic, checksummed, durable and absorbing", () => {
  const stateRoot = root();
  const journal = EpisodeJournal.create({
    rootDir: stateRoot,
    episodeId: "episode-monotonic",
    identity: { boot: "boot-1", host: "host-1", domain: "domain-1" },
  });
  for (const state of EPISODE_STATES.slice(1, -1)) journal.transition(state, { proof: state.toLowerCase() });
  assert.equal(journal.current().state, "SEALED");
  assert.throws(() => journal.transition("UNCONTAINED", {}), JournalError);
  journal.close();
  const records = EpisodeJournal.inspect({ rootDir: stateRoot, episodeId: "episode-monotonic" });
  assert.equal(records.length, 11);
  assert.equal(records.at(-1).state, "SEALED");
  assert.equal(episodeExists(stateRoot, "episode-monotonic"), true);
  assert.throws(() => EpisodeJournal.create({
    rootDir: stateRoot,
    episodeId: "episode-monotonic",
    identity: {},
  }));
});

test("every nonterminal restart becomes durable absorbing UNCONTAINED", () => {
  const transitions = EPISODE_STATES.slice(0, -2);
  for (const [index, stopState] of transitions.entries()) {
    const stateRoot = root();
    const episodeId = `episode-crash-${index}`;
    const journal = EpisodeJournal.create({ rootDir: stateRoot, episodeId, identity: { stopState } });
    for (const state of transitions.slice(1, index + 1)) journal.transition(state, {});
    assert.equal(journal.current().state, stopState);
    journal.close();
    const recovered = EpisodeJournal.recoverToUncontained({
      rootDir: stateRoot,
      episodeId,
      reason: `restart_at_${stopState}`,
      cleanup: { attempted: false },
    });
    assert.equal(recovered.state, "UNCONTAINED");
    assert.equal(recovered.payload.authority, false);
    assert.equal(recovered.payload.trusted_output, false);
    const repeated = EpisodeJournal.recoverToUncontained({
      rootDir: stateRoot,
      episodeId,
      reason: "second_recovery",
    });
    assert.equal(repeated.state, "UNCONTAINED");
  }
});

test("a torn or corrupt journal creates a no-success recovery tombstone", () => {
  const stateRoot = root();
  const episodeId = "episode-corrupt";
  const journal = EpisodeJournal.create({ rootDir: stateRoot, episodeId, identity: {} });
  journal.close();
  const path = join(stateRoot, episodeId, "journal.jsonl");
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("{torn") ]));
  const tombstone = EpisodeJournal.recoverToUncontained({
    rootDir: stateRoot,
    episodeId,
    reason: "ignored",
  });
  assert.equal(tombstone.state, "UNCONTAINED");
  assert.equal(tombstone.authority, false);
  assert.equal(tombstone.trusted_output, false);
  assert.deepEqual(EpisodeJournal.recoverToUncontained({ rootDir: stateRoot, episodeId, reason: "again" }), tombstone);
});

test("malformed, mismatched and symlink recovery tombstones refuse with a typed error", () => {
  for (const kind of ["torn", "mismatched", "symlink", "dangling-symlink"]) {
    const stateRoot = root();
    const episodeId = `episode-${kind}`;
    const journal = EpisodeJournal.create({ rootDir: stateRoot, episodeId, identity: {} });
    journal.close();
    const directory = join(stateRoot, episodeId);
    writeFileSync(join(directory, "journal.jsonl"), "{torn");
    const target = join(directory, "UNCONTAINED.json");
    const outside = join(stateRoot, "outside.json");
    const valid = JSON.stringify({ schema: "vinci.containment-broker.recovery-tombstone/v3",
      episode_id: episodeId, state: "UNCONTAINED", authority: false, trusted_output: false });
    if (kind === "symlink" || kind === "dangling-symlink") {
      if (kind === "symlink") writeFileSync(outside, valid);
      symlinkSync(outside, target);
    } else writeFileSync(target, kind === "torn" ? "{torn" : "{}");
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.throws(() => EpisodeJournal.recoverToUncontained({ rootDir: stateRoot, episodeId, reason: "restart" }),
        (error) => error instanceof JournalError && error.code === "RECOVERY_TOMBSTONE_INVALID");
    }
    if (kind === "symlink") assert.equal(readFileSync(outside, "utf8"), valid);
    assert.deepEqual(readdirSync(directory).sort(), ["UNCONTAINED.json", "journal.jsonl"]);
  }
});

test("recovery publishes only after file sync and leaves no target after a failed sync", (t) => {
  const realFsync = fs.fsyncSync;
  const realLink = fs.linkSync;
  let synced = false;
  let failSync = true;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fstatSync(fd).isFile()) {
      if (failSync) throw Object.assign(new Error("injected file sync failure"), { code: "EIO" });
      realFsync(fd);
      synced = true;
    } else realFsync(fd);
  });
  t.mock.method(fs, "linkSync", (source, target) => {
    assert.equal(synced, true, "tombstone bytes must be synced before publication");
    assert.doesNotThrow(() => JSON.parse(readFileSync(source, "utf8")));
    realLink(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const stateRoot = root();
  const episodeId = "episode-sync";
  const directory = join(stateRoot, episodeId);
  mkdirSync(directory);
  writeFileSync(join(directory, "journal.jsonl"), "{torn");
  assert.throws(() => EpisodeJournal.recoverToUncontained({ rootDir: stateRoot, episodeId, reason: "restart" }),
    (error) => error.code === "EIO");
  assert.equal(existsSync(join(directory, "UNCONTAINED.json")), false);
  assert.deepEqual(readdirSync(directory), ["journal.jsonl"]);
  failSync = false;
  const recovered = EpisodeJournal.recoverToUncontained({ rootDir: stateRoot, episodeId, reason: "restart" });
  assert.equal(recovered.state, "UNCONTAINED");
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "UNCONTAINED.json"), "utf8")), recovered);
  assert.deepEqual(readdirSync(directory).sort(), ["UNCONTAINED.json", "journal.jsonl"]);
});

test("a concurrent recovery wins without replacement and is made durable before returning", (t) => {
  const stateRoot = root();
  const episodeId = "episode-concurrent";
  const directory = join(stateRoot, episodeId);
  mkdirSync(directory);
  writeFileSync(join(directory, "journal.jsonl"), "{torn");
  const winner = { schema: "vinci.containment-broker.recovery-tombstone/v3", episode_id: episodeId,
    state: "UNCONTAINED", authority: false, trusted_output: false, reason: "first recovery" };
  const bytes = JSON.stringify(winner);
  const realLink = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, target) => {
    writeFileSync(target, bytes, { flag: "wx" });
    realLink(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const recovered = EpisodeJournal.recoverToUncontained({ rootDir: stateRoot, episodeId, reason: "second recovery" });
  assert.deepEqual(recovered, winner);
  assert.equal(readFileSync(join(directory, "UNCONTAINED.json"), "utf8"), bytes);
  assert.deepEqual(readdirSync(directory).sort(), ["UNCONTAINED.json", "journal.jsonl"]);
});
