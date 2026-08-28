import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
});
