// Wave 1B: the worker side of the Governor lease loop, end to end against the fixture's
// FakeGovernor (lease routes + claim-paths, injectable clock). Everything here is behind the
// `--governor` opt-in; the last test proves an ungoverned run does none of it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIM_PATHS_DEPLOYED, CLAIM_PATHS_WITH_TTL, FakeGovernor, WorkerTestFixture } from './lib/worker-fixture.mjs';
import { CAPABILITY_MATRIX, DECLARATION_REFRESH_DEFAULT_S, GOVERNOR_DECLARATION_MAX_AGE_S, LEASE_TIMEOUT_MS, LeaseClient, REFRESH_HEADROOM_FACTOR, buildDeclaration, declarationDigest, startHeartbeat } from '../worker/lease.mjs';
import { prBodyFooter, publish } from '../worker/publisher.mjs';

// A terminal record is now a status carrying a typed outcome, not a `blocker`. These helpers
// locate it by the PROPERTY that matters -- the task ended badly -- rather than by a kind string,
// so they keep their meaning as the contract evolves and, crucially, so the NEGATIVE assertions
// below cannot pass merely because nothing emits a given kind any more.
const FAILING_OUTCOMES = ["FAILED", "BLOCKED", "REFUSED"];
const findTerminalFailure = (posts) =>
  posts.find((p) => p.kind === "status" && FAILING_OUTCOMES.includes(p.outcome));
const hasTerminalFailure = (posts) =>
  posts.some((p) => FAILING_OUTCOMES.includes(p.outcome) || /^task \S+ (blocked|failed|refused)$/.test(p.subject ?? ""));


const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');
const WORKER = join(ROOT, 'vinci/worker/worker.mjs');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.stack ?? err.message}`);
    failed++;
  }
};

function state(fixture, taskId) {
  return JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', `${taskId}.json`), 'utf8'));
}

function handoff(id, workerId, body) {
  return { message_id: id, kind: 'handoff', to_agent: `worker:${workerId}`, subject: 'lease task', body, ts: '2026-08-28T10:00:00Z', posted_by: 'scheduler' };
}

function spawnWorker(fixture, workerId, extraArgs, envOverrides = {}) {
  const env = fixture.getEnv({ VINCI_GOVERNOR_TOKEN: 'gov-token', ...envOverrides });
  const proc = spawn('node', [WORKER, 'start', '--id', workerId, '--server', fixture.busUrl(), '--once', '--state-dir', fixture.tempDir, ...extraArgs], { env, stdio: 'pipe' });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((r) => proc.on('close', (code) => r({ code, stderr })));
  return { proc, closed, stderr: () => stderr };
}

function runWorker(fixture, workerId, extraArgs, envOverrides = {}) {
  return spawnWorker(fixture, workerId, extraArgs, envOverrides).closed;
}

async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function ghCalls(fixture) {
  try {
    return readFileSync(join(fixture.tempDir, 'gh-calls.txt'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function originHasBranch(origin, branch) {
  const result = spawnSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' });
  return result.status === 0;
}

function vinciRecordLines(fixture) {
  try {
    return readFileSync(fixture.recordFile, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function uploadedResultJson(fixture) {
  const calls = readFileSync(join(fixture.tempDir, 'aws-calls.txt'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.equal(calls.length, 1, 'exactly one bundle upload');
  const tarPath = calls[0].argv[3];
  const out = mkdtempSync(join(tmpdir(), 'lease-bundle-'));
  const tar = spawnSync('tar', ['xzf', tarPath, '-C', out], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const HEX40_OR_VERSION = /^(?:[0-9a-f]{40}(?:-dirty)?|\d+\.\d+\.\d+\S*)$/;

// ---------------------------------------------------------------------------------------------
// FIRST, deliberately. This is the guard of record for "the declaration refresh timer never holds
// the process open", and almost every other test in this file waits on an UNBOUNDED `--once` run.
// Ordered later, a daemon that fails to exit hangs one of those first and this test never asserts
// — the failure reads as a CI alarm instead of as this property breaking. It is bounded, so the
// mutant that removes both exit guards fails here, by name, in seconds.
await test('BLOCK-B: the refresh timer never holds the process open (--once still exits)', async () => {
  const fixture = new WorkerTestFixture('declaration-refresh-once');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('133', 'w3', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const started = Date.now();
    // A 0.2 s refresh on a --once run: a timer that holds the event loop open would make this
    // process never exit. Bounded explicitly, so a timer that DOES hold it open fails this test
    // instead of hanging the suite.
    const worker = spawnWorker(fixture, 'w3', ['--governor', governor.url], { VINCI_DECLARATION_REFRESH_S: '0.2' });
    const timedOut = Symbol('timeout');
    const bound = new Promise((r) => setTimeout(() => r(timedOut), 30_000).unref?.());
    const outcome = await Promise.race([worker.closed, bound]);
    const elapsed = Date.now() - started;
    if (outcome === timedOut) {
      worker.proc.kill('SIGKILL');
      assert.fail(`--once did not exit within ${elapsed}ms: the declaration refresh timer is holding the process open`);
    }
    assert.equal(outcome.code, 0, outcome.stderr);
    assert(elapsed < 30_000, `--once must still exit promptly, took ${elapsed}ms`);
    assert.equal(state(fixture, '133').state, 'COMPLETED');
    // The refresh really was live during that run (otherwise this proves nothing about the timer).
    assert(declarationPosts(fixture, 'w3').length >= 1, 'the declaration was posted, so the interval was armed');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});


// ---------------------------------------------------------------------------------------------
// L1 + L2 + L3 + L4 + D1 happy path: one governed task, evidence: pr.
// FAIL FAST on the guard of record. Every remaining test in this file waits on an UNBOUNDED
// `--once` run, so if a daemon cannot exit there is nothing left here that can report anything —
// the suite would hang for its CI alarm and the real failure above would scroll past. Stopping
// here is what makes that failure the visible one.
if (failed > 0) {
  console.error('\n  ABORTING: `--once` cannot exit, so every remaining test in this file would hang rather than assert.');
  console.log(`\nWorker lease loop tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

await test('happy path: acquire before clone, renew at ttl/3, fenced push+PR, release completed', async () => {
  const fixture = new WorkerTestFixture('lease-happy');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 1 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('101', 'w1', 'repo: test/repo\nevidence: pr\nref: job_lease1\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w1', ['--governor', governor.url], { FAKE_VINCI_SLEEP: '2000' });
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '101');
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);

    // D1: the declaration post, right after `online`, canonical JSON, digest recorded everywhere.
    const posts = fixture.getPostedMessages();
    const onlineIndex = posts.findIndex((p) => p.subject === 'worker w1 online');
    const declarationIndex = posts.findIndex((p) => p.subject === 'worker w1 declaration');
    assert(onlineIndex >= 0 && declarationIndex === onlineIndex + 1, 'declaration must be posted immediately after online');
    const declarationPost = posts[declarationIndex];
    assert.equal(declarationPost.kind, 'status');
    const declaration = JSON.parse(declarationPost.body);
    assert.equal(declaration.schemaVersion, 1);
    assert.deepEqual(Object.keys(declaration), ['adapter', 'controlLevel', 'schemaVersion', 'supports', 'worker'], 'body must be canonical (keys sorted)');
    assert.deepEqual(declaration.worker, { id: 'w1', name: 'Vinci Code worker', version: '0.0.0-fake' });
    assert.deepEqual(declaration.adapter, { id: 'vinci-worker-daemon', version: JSON.parse(readFileSync(join(ROOT, 'vinci/identity.json'), 'utf8')).version });
    assert.equal(declaration.controlLevel, 'inventoried');
    // F2: no overclaim. abort is false (the daemon consumes only kind "handoff" and has no abort
    // handler); safeResume is false (no test proves a kill mid-write resumes safely);
    // structuredEvidence is false HERE because this daemon runs without VINCI_EVIDENCE_URI_PREFIX.
    assert.deepEqual(declaration.supports, {
      activityStream: false, questions: false, steering: false, approvals: 'none', pause: false, restrictToReadOnly: false,
      abort: false, filesystemEnforcement: false, networkEnforcement: false, structuredEvidence: false, nativeReceipts: false,
      safeResume: false, independentVerification: false,
    });
    const digest = sha256(declarationPost.body);
    assert.equal(snapshot.capability_declaration_digest, digest, 'task must record the declaration digest');

    // L1: acquire body, ordered BEFORE the path claim (F4: no claim is held for a refused lease)
    // and before the clone (no git before it).
    assert.equal(governor.acquires.length, 1);
    const acquire = governor.acquires[0];
    assert.equal(acquire.work_order_id, 'job_lease1', 'work_order_id is the envelope ref');
    assert.equal(acquire.attempt_id, '101/1');
    assert.equal(acquire.adapter_version, declaration.adapter.version);
    assert.match(acquire.worker_build_digest, HEX40_OR_VERSION);
    assert.equal(acquire.capability_declaration_digest, digest);
    const claimIndex = governor.hits.findIndex((h) => h.url === '/v1/governor/claim-paths');
    const acquireIndex = governor.hits.findIndex((h) => h.url === '/v1/governor/leases');
    assert(acquireIndex >= 0 && claimIndex > acquireIndex, 'the path claim follows the lease acquire');
    assert.equal(governor.hits[acquireIndex].auth, 'Session gov-token');
    assert.equal(snapshot.lease.lease_id, 'lease-1');
    assert.equal(snapshot.lease.fencing_generation, 100);
    assert.equal(typeof snapshot.lease.expires_at, 'string');
    assert.equal(snapshot.lease.ttl, 3600, 'the Stage 2 path-claim fields stay on the same record');

    // L2: renews at ttl/3 = 333ms across a 2s run: several, evenly spaced, same generation.
    const renews = governor.hits.filter((h) => /\/renew$/.test(h.url));
    assert(renews.length >= 3, `expected >=3 renews over a 2s run at ttl_s 1, got ${renews.length}`);
    assert(renews.every((h) => h.body.fencing_generation === 100));
    const gaps = renews.slice(1).map((h, i) => h.at - renews[i].at).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    assert(median >= 200 && median <= 700, `median renew gap ${median}ms should be ~333ms (ttl/3)`);
    assert(snapshot.lease.renewals >= 3);

    // L3: check with the BUS token before push and before PR; both valid; PR footer names the generation.
    assert.deepEqual(governor.checks.map((c) => c.auth), ['Bearer test-token', 'Bearer test-token']);
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid]), [['push', true], ['pr', true]]);
    assert(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/101'), 'branch pushed');
    const create = ghCalls(fixture).find((c) => c.argv.includes('create'));
    assert(create, 'PR created');
    const body = create.argv[create.argv.indexOf('--body') + 1];
    // #25 owns the footer; #26 contributes the ` fence=<generation>` segment. Its presence is
    // also the end-to-end proof that the fence's `generation` getter resolved to the live lease
    // (a captured snapshot taken when the fence object was built would read `null` here).
    assert.match(body, /^vinci-worker: task=101 attempt=1 head=[0-9a-f]{7,64} base=main fence=100$/m, `PR body footer: ${JSON.stringify(body)}`);

    // L4: released exactly once, outcome matches the committed state, before the final post.
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'completed' }]);
    assert.equal(governor.leases.get('lease-1').released, 'completed');
    const releaseIndex = governor.hits.findIndex((h) => /\/release$/.test(h.url));
    assert(renews.every((h) => governor.hits.indexOf(h) < releaseIndex), 'no renew after release');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('409 leased => BLOCKED before clone: no git, no spawn, no renew, no release', async () => {
  const fixture = new WorkerTestFixture('lease-leased');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, mode: 'leased', holder: { holder_attempt_id: 'other-worker/7', expires_at: '2099-01-01T00:00:00.000Z' } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('102', 'w2', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w2', ['--governor', governor.url]);
    assert.equal(code, 0);
    const snapshot = state(fixture, '102');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'leased_by other-worker/7 until 2099-01-01T00:00:00.000Z');
    assert.equal(snapshot.outcome.governor, 'leased');
    assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'must not clone');
    assert.equal(fixture.getVinciCalls().length, 0, 'must not spawn');
    assert.equal(governor.acquires[0].work_order_id, '102', 'without a ref the task id is the subject');
    // F4: the Governor cannot release a path claim, so none may be taken for a lease we do not get.
    assert.equal(governor.hits.filter((h) => h.url === '/v1/governor/claim-paths').length, 0, 'a refused lease must leave no path claim held');
    assert.deepEqual(governor.events, ['acquire']);
    assert.equal(governor.renews.length, 0);
    assert.equal(governor.releases.length, 0);
    assert.equal(governor.checks.length, 0);
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert.match(blocker.body, /^Governor lease held elsewhere: leased_by other-worker\/7 until 2099-01-01T00:00:00\.000Z worker_build=/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('unusable lease answer at acquire (500) => BLOCKED lease_unavailable, fail closed', async () => {
  const fixture = new WorkerTestFixture('lease-500');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, mode: 'error' });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('103', 'w3', 'repo: test/repo\nevidence: pr\n\nTask')]);
    await runWorker(fixture, 'w3', ['--governor', governor.url]);
    const snapshot = state(fixture, '103');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.match(snapshot.outcome.reason, /^lease_unavailable: Governor error: unexpected status 500/);
    assert.equal(snapshot.outcome.governor, 'unavailable');
    assert.equal(governor.hits.filter((h) => h.url === '/v1/governor/claim-paths').length, 0, 'an unavailable lease must leave no path claim held');
    assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'must not clone');
    assert.equal(fixture.getVinciCalls().length, 0);
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert.match(blocker.body, /^Governor lease unavailable: lease_unavailable:/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('unreachable governor at acquire => lease_unavailable (connection failed); a 200 without a lease is not a lease', async () => {
  const probe = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await probe.start();
  const deadUrl = probe.url;
  await probe.close();
  const client = new LeaseClient({ governorUrl: deadUrl, token: 'gov-token', busToken: 'bus' });
  const result = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.equal(result.unavailable, true);
  assert.match(result.reason, /^Governor connection failed: (ECONNREFUSED|fetch failed)/);
  for (const body of [{ ttl_s: 60 }, { lease_id: 'l', ttl_s: 60 }, { lease_id: 'l', fencing_generation: 1, ttl_s: 0 }, { lease_id: 'l', fencing_generation: 1, ttl_s: 0.5 }, { lease_id: 'l', fencing_generation: 1, ttl_s: -3 }, { lease_id: 'l', fencing_generation: 1, ttl_s: '60' }]) {
    const fake = { fetch: async () => new Response(JSON.stringify(body), { status: 200 }) };
    const c = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', fetch: fake.fetch });
    const r = await c.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
    assert.equal(r.unavailable, true, `body ${JSON.stringify(body)} must not be a lease`);
    assert.match(r.reason, /^Governor lease invalid: /);
  }
  const noToken = new LeaseClient({ governorUrl: deadUrl, token: '' });
  assert.match((await noToken.acquire({ workOrderId: 'job_x', attemptId: 'x/1' })).reason, /governor token missing/);
});

// ---------------------------------------------------------------------------------------------
await test('renew 409 stale mid-run => child SIGTERMed, BLOCKED lease_lost, zero push/PR, evidence authority: lost, release abandoned', async () => {
  const fixture = new WorkerTestFixture('lease-lost');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 1, renewOkCount: 3, renewFailure: { status: 409, reason: 'stale_generation' } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('104', 'w4', 'repo: test/repo\nevidence: pr\nref: job_lost\n\nTask')]);
    const started = Date.now();
    const { code, stderr } = await runWorker(fixture, 'w4', ['--governor', governor.url], {
      FAKE_VINCI_SLEEP: '20000',
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/evidence/',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });
    const elapsed = Date.now() - started;
    assert.equal(code, 0, stderr);
    assert(elapsed < 15000, `run must be cut short by the lease loss, took ${elapsed}ms`);
    assert(vinciRecordLines(fixture).includes('SIGTERM'), 'the child must be SIGTERMed');
    assert.match(stderr, /task 104 lost its lease \(stale_generation\)/);
    const snapshot = state(fixture, '104');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.outcome.reason, 'lease_lost:stale_generation');
    assert.equal(snapshot.exit_code, 143);
    assert.equal(snapshot.aborted, 'lease_lost:stale_generation');
    assert.equal(snapshot.publish, 'skipped');
    assert.equal(snapshot.pr, null);
    assert.equal(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/104'), false, 'no branch push after loss of authority');
    // Authority was lost BEFORE publish, so publish is skipped whole: not even #25's read-only
    // `gh pr list` runs. Strict zero here, unlike the fenced-at-push case below where the
    // publisher is entered and its pre-effect reads are legitimate.
    assert.equal(ghCalls(fixture).length, 0, 'a lost lease skips publish entirely — no gh at all');
    assert.equal(governor.checks.length, 0, 'authority already lost: no check is even asked');
    // evidence bundle still attempted, marked authority: lost; the ledger POST is fenced out.
    const result = uploadedResultJson(fixture);
    assert.equal(result.authority, 'lost');
    assert.equal(result.state, 'BLOCKED');
    assert.equal(fixture.getEvidencePosts().length, 0, 'no evidence POST on a lost lease');
    assert.equal(snapshot.evidence_error, 'lease_lost:stale_generation');
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'abandoned' }]);
    assert.equal(governor.renews.length, 4, 'three granted renews, then the refused one; no renew after loss');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('renew unreachable (socket dropped) is retried once, then lease_lost:unreachable', async () => {
  const fixture = new WorkerTestFixture('lease-drop');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 1, renewOkCount: 3, renewFailure: 'drop' });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('105', 'w5', 'repo: test/repo\nevidence: none\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w5', ['--governor', governor.url], { FAKE_VINCI_SLEEP: '20000' });
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '105');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'lease_lost:unreachable');
    assert.equal(governor.renews.length, 5, 'three granted, the dropped one, exactly one retry');
    assert(vinciRecordLines(fixture).includes('SIGTERM'));
    assert.equal(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/105'), false);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('check invalid before push => push skipped, fenced_out recorded, BLOCKED, release abandoned', async () => {
  const fixture = new WorkerTestFixture('lease-fenced');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, check: false });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('106', 'w6', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w6', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '106');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.outcome.reason, 'revoked');
    assert.equal(snapshot.publish, 'fenced_out');
    assert.equal(snapshot.fenced_out, 'revoked');
    assert.equal(snapshot.pr, null);
    assert.equal(fixture.getVinciCalls().length, 1, 'the run itself happened');
    assert.equal(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/106'), false, 'push must be skipped');
    // #25's publisher looks for our PR BEFORE touching origin; that read is not an effect. What
    // the fence must prevent is the CREATE — and the push, asserted on the line above.
    assert.equal(ghCalls(fixture).filter((c) => c.argv.includes('create')).length, 0, 'no PR may be created behind a failed fence');
    assert.equal(governor.checks.length, 1, 'one check (push); nothing after a fence');
    assert.equal(governor.checks[0].auth, 'Bearer test-token');
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid, c.reason]), [['push', false, 'revoked']]);
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['abandoned']);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('check invalid between push and PR => branch pushed, PR skipped, fenced_out recorded', async () => {
  const fixture = new WorkerTestFixture('lease-fenced-pr');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, check: (_body, index) => (index === 0 ? { valid: true, reason: 'ok' } : { valid: false, reason: 'revoked' }) });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('107', 'w7', 'repo: test/repo\nevidence: pr\n\nTask')]);
    await runWorker(fixture, 'w7', ['--governor', governor.url]);
    const snapshot = state(fixture, '107');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'revoked');
    assert.equal(snapshot.publish, 'pushed');
    assert(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/107'));
    assert.equal(ghCalls(fixture).filter((c) => c.argv.includes('create')).length, 0, 'PR must be skipped');
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid]), [['push', true], ['pr', false]]);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('release on the catch path: clone failure after acquire => FAILED, release failed', async () => {
  const fixture = new WorkerTestFixture('lease-catch');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 60 });
  await governor.start();
  try {
    // No such origin: prepareRepository's clone throws after the lease was acquired.
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('108', 'w8', 'repo: test/missing\nevidence: none\n\nTask')]);
    const { code } = await runWorker(fixture, 'w8', ['--governor', governor.url]);
    assert.equal(code, 0);
    const snapshot = state(fixture, '108');
    assert.equal(snapshot.state, 'FAILED');
    assert.match(snapshot.outcome.reason, /git clone/);
    assert.equal(governor.acquires.length, 1);
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'failed' }]);
    assert.equal(snapshot.lease.lease_id, 'lease-1', 'the lease stays on the record after release');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('release outcome follows the state: FAILED run releases failed; UNVERIFIED releases unverified', async () => {
  const fixture = new WorkerTestFixture('lease-outcomes');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 60 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([
      handoff('109', 'w1', 'repo: test/repo\nevidence: none\n\nTask'),
      handoff('110', 'w1', 'repo: test/repo\nevidence: none\n\nTask'),
    ]);
    // Same daemon, two tasks: fake vinci exit code applies to both, so run twice instead.
    await runWorker(fixture, 'w1', ['--governor', governor.url], { FAKE_VINCI_EXIT: '3' });
    assert.equal(state(fixture, '109').state, 'FAILED');
    assert.equal(state(fixture, '110').state, 'FAILED');
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['failed', 'failed']);
    assert.deepEqual(governor.acquires.map((a) => a.attempt_id), ['109/1', '110/1']);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
  const fixture2 = new WorkerTestFixture('lease-unverified');
  const governor2 = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 60 });
  await governor2.start();
  try {
    fixture2.createRepo('test', 'repo');
    fixture2.linkTools(TOOLS);
    await fixture2.startBus([handoff('111', 'w2', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture2, 'w2', ['--governor', governor2.url]);
    assert.equal(state(fixture2, '111').state, 'UNVERIFIED');
    assert.deepEqual(governor2.releases.map((r) => r.outcome), ['unverified']);
  } finally {
    await governor2.close();
    await fixture2.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('release failure is logged and never changes the state', async () => {
  const fixture = new WorkerTestFixture('lease-release-fail');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 60, releaseStatus: 500 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('112', 'w3', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w3', ['--governor', governor.url]);
    assert.equal(code, 0);
    assert.equal(state(fixture, '112').state, 'COMPLETED');
    assert.match(stderr, /lease lease-1 release \(completed\) failed: status 500/);
    assert.equal(governor.releases.length, 1);
    const final = fixture.getPostedMessages().find((p) => p.subject === 'task 112 completed');
    assert(final, 'final post still happens');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('declaration digest = sha256(canonical declaration) and the daemon never overclaims control', async () => {
  const declaration = buildDeclaration({ workerId: 'w1', workerVersion: '0.0.51', adapterVersion: '0.0.51' });
  assert.deepEqual(declaration.supports, CAPABILITY_MATRIX);
  // controlLevel is a HAND-WRITTEN literal in buildDeclaration, not a derivation — no function in
  // this repo computes a rung from the matrix (lease.mjs says so at the literal). This pins the
  // hand-written value against the measured activityStream; it does not claim a mechanism.
  assert.equal(declaration.controlLevel, 'inventoried', 'activityStream is false, so the hand-written controlLevel literal must be the lowest rung');
  const digest = declarationDigest(declaration);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, sha256('{"adapter":{"id":"vinci-worker-daemon","version":"0.0.51"},"controlLevel":"inventoried","schemaVersion":1,"supports":{"abort":false,"activityStream":false,"approvals":"none","filesystemEnforcement":false,"independentVerification":false,"nativeReceipts":false,"networkEnforcement":false,"pause":false,"questions":false,"restrictToReadOnly":false,"safeResume":false,"steering":false,"structuredEvidence":false},"worker":{"id":"w1","name":"Vinci Code worker","version":"0.0.51"}}'));
  assert.equal(Object.keys(declaration.supports).length, 13, '12 booleans + approvals');
  assert.equal(Object.values(declaration.supports).filter((v) => typeof v === 'boolean').length, 12);
  // F2: the fixed matrix never claims abort or safeResume; structuredEvidence follows config.
  assert.equal(CAPABILITY_MATRIX.abort, false, 'no abort handler exists; abort must not be claimed');
  assert.equal(CAPABILITY_MATRIX.safeResume, false, 'kill-mid-write resume is unproven; must not be claimed');
  assert.equal(CAPABILITY_MATRIX.structuredEvidence, false, 'without an evidence prefix no bundle exists');
  const withEvidence = buildDeclaration({ workerId: 'w1', workerVersion: '0.0.51', adapterVersion: '0.0.51', structuredEvidence: true });
  assert.equal(withEvidence.supports.structuredEvidence, true);
  assert.notEqual(declarationDigest(withEvidence), digest, 'the digest names the posted bytes, config included');
  assert.equal(buildDeclaration({ workerId: 'w1', workerVersion: '1', adapterVersion: '1', structuredEvidence: 'yes' }).supports.structuredEvidence, false, 'only boolean true counts');
});

await test('heartbeat unit: renews at ttl/3, reschedules on the served ttl, stops on first loss', async () => {
  const scheduled = [];
  const renews = [];
  let answer = { ok: true, expires_at: 'later', ttl_s: 9 };
  const client = { renew: async (lease) => { renews.push({ ...lease }); return answer; } };
  const lease = { lease_id: 'l', fencing_generation: 1, ttl_s: 3 };
  const losses = [];
  const hb = startHeartbeat({ client, lease, onLoss: (r) => losses.push(r), setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {} });
  assert.equal(scheduled[0].ms, 1000, 'first renew at ttl_s/3');
  await scheduled[0].fn();
  assert.equal(renews.length, 1);
  assert.equal(lease.ttl_s, 9);
  assert.equal(scheduled[1].ms, 3000, 'the renewed ttl drives the next interval');
  answer = { ok: false, lost: true, reason: 'revoked' };
  await scheduled[1].fn();
  assert.deepEqual(losses, ['revoked']);
  assert.equal(hb.lost, true);
  assert.equal(scheduled.length, 2, 'no reschedule after loss');
  hb.stop();
});


// ---------------------------------------------------------------------------------------------
// F1: the THIRD fence (evidence POST) is a loss of authority like the first two: BLOCKED
// fenced_out, release abandoned, blocker post — not a quiet UNVERIFIED downgrade.
await test('check invalid at the evidence fence (third fence) => BLOCKED fenced_out, release abandoned, blocker says so', async () => {
  const fixture = new WorkerTestFixture('lease-fenced-evidence');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 60, check: (_body, index) => (index < 2 ? { valid: true, reason: 'ok' } : { valid: false, reason: 'revoked' }) });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('114', 'w1', 'repo: test/repo\nevidence: pr\nref: job_fence3\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w1', ['--governor', governor.url], {
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/evidence/',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });
    assert.equal(code, 0, stderr);
    // F2: with an evidence prefix configured the declaration claims structuredEvidence.
    const declarationPost = fixture.getPostedMessages().find((p) => p.subject === 'worker w1 declaration');
    assert.equal(JSON.parse(declarationPost.body).supports.structuredEvidence, true);
    const snapshot = state(fixture, '114');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.outcome.reason, 'revoked');
    assert.equal(snapshot.fenced_out, 'revoked');
    assert.equal(snapshot.evidence_error, 'revoked');
    assert.equal(snapshot.evidence_result_state, 'COMPLETED', 'result.json was uploaded as the intended COMPLETED; the downgrade is recorded');
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid, c.reason]), [['push', true, 'ok'], ['pr', true, 'ok'], ['evidence', false, 'revoked']]);
    assert(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/114'), 'push happened under a valid fence');
    assert(ghCalls(fixture).some((c) => c.argv.includes('create')), 'PR happened under a valid fence');
    assert.equal(fixture.getEvidencePosts().length, 0, 'the fenced evidence POST never reaches the ledger');
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'abandoned' }]);
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert(blocker, 'a blocker must be posted');
    assert.equal(blocker.subject, 'task 114 blocked');
    assert.match(blocker.body, /^state=BLOCKED .*evidence_error=revoked .*reason=revoked/, blocker.body);
    assert.equal(fixture.getPostedMessages().some((p) => p.subject === 'task 114 unverified' || p.subject === 'task 114 completed'), false);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// F3: a Governor that accepts the connection and never answers is bounded by the client timeout.
await test('hung Governor: check is valid:false within the timeout; renew retries once then unreachable', async () => {
  const sockets = new Set();
  const server = createServer((request) => { sockets.add(request.socket); /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(new LeaseClient({ governorUrl: url, token: 't' }).timeoutMs, LEASE_TIMEOUT_MS);
    assert.equal(LEASE_TIMEOUT_MS, 10_000);
    const client = new LeaseClient({ governorUrl: url, token: 'gov-token', busToken: 'bus', timeoutMs: 300, log: () => {} });
    const lease = { lease_id: 'lease-1', fencing_generation: 100, ttl_s: 60 };
    let started = Date.now();
    const verdict = await client.check(lease);
    let elapsed = Date.now() - started;
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, 'Governor connection failed: timeout after 300 ms');
    assert(elapsed >= 280 && elapsed < 1500, `check must resolve at the timeout, took ${elapsed}ms`);
    started = Date.now();
    const renew = await client.renew(lease);
    elapsed = Date.now() - started;
    assert.deepEqual({ ok: renew.ok, lost: renew.lost, reason: renew.reason }, { ok: false, lost: true, reason: 'unreachable' });
    assert.equal(renew.detail, 'Governor connection failed: timeout after 300 ms');
    assert(elapsed >= 580 && elapsed < 2000, `two timed-out attempts (one retry), took ${elapsed}ms`);
    started = Date.now();
    const acquired = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
    assert.equal(acquired.unavailable, true);
    assert.equal(acquired.reason, 'Governor connection failed: timeout after 300 ms');
    const released = await client.release(lease, 'abandoned');
    assert.equal(released.ok, false, 'a release that times out is reported, never thrown');
    assert(Date.now() - started < 2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------------------------
// F4: lease before claim — a refused path claim after a granted lease releases the lease.
await test('path claim refused after the lease was granted => BLOCKED refused, lease released blocked', async () => {
  const fixture = new WorkerTestFixture('lease-claim-refused');
  const governor = new FakeGovernor({ ttlS: 60, claim: { status: 409, body: { reason: 'path already leased to worker:other' } } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('115', 'w2', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w2', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '115');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'path already leased to worker:other');
    assert.equal(snapshot.outcome.governor, 'refused');
    assert.equal(snapshot.lease.lease_id, 'lease-1', 'the lease that was held is on the record');
    assert.deepEqual(governor.events, ['acquire', 'claim', 'release']);
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'blocked' }]);
    assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'must not clone');
    assert.equal(fixture.getVinciCalls().length, 0, 'must not spawn');
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert.match(blocker.body, /^Governor refused the lease: path already leased to worker:other worker_build=/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// F5: a renew in flight when the task finishes completes BEFORE the release is sent.
await test('release waits for the renew in flight: renew:end precedes release in the Governor log', async () => {
  const fixture = new WorkerTestFixture('lease-settle');
  // ttl 1 => first renew ~333ms after acquire, held open for 2.5s; the 500ms run ends well inside.
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 1, renewDelayMs: 2500 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('116', 'w3', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w3', ['--governor', governor.url], { FAKE_VINCI_SLEEP: '500' });
    assert.equal(code, 0, stderr);
    assert.equal(state(fixture, '116').state, 'COMPLETED');
    const starts = governor.events.filter((e) => e === 'renew:start').length;
    assert(starts >= 1, `a renew must have been in flight (${governor.events.join(',')})`);
    const releaseAt = governor.events.indexOf('release');
    assert(releaseAt >= 0, 'released');
    const lastStart = governor.events.lastIndexOf('renew:start');
    const lastEnd = governor.events.lastIndexOf('renew:end');
    assert(lastStart < releaseAt, `renew started before release (${governor.events.join(',')})`);
    assert(lastEnd > lastStart && lastEnd < releaseAt, `the in-flight renew must finish before the release is sent (${governor.events.join(',')})`);
    assert.equal(governor.events.slice(releaseAt + 1).includes('renew:start'), false, 'no renew after release');
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['completed']);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// F6: ttl_s below one second cannot bound a run.
await test('ttl_s < 1 is refused at acquire; a renew serving ttl_s < 1 keeps the previous ttl', async () => {
  const answers = [];
  const fake = async () => new Response(JSON.stringify(answers.shift()), { status: 200 });
  const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', fetch: fake });
  for (const ttl of [0.999, 0.3, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
    answers.push({ lease_id: 'l', fencing_generation: 1, ttl_s: ttl });
    const r = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
    assert.equal(r.unavailable, true, `ttl_s ${ttl} must be refused`);
    assert.equal(r.reason, `Governor lease invalid: ttl_s=${JSON.stringify(ttl) ?? 'undefined'}`);
  }
  answers.push({ lease_id: 'l', fencing_generation: 1, ttl_s: 1 });
  const ok = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
  assert.equal(ok.success, true, 'exactly 1 s is the floor');
  const lease = { ...ok.lease, ttl_s: 30 };
  for (const ttl of [0.5, 0, -2, '9', null]) {
    answers.push({ expires_at: 'later', ttl_s: ttl });
    const renewed = await client.renew(lease);
    assert.equal(renewed.ok, true);
    assert.equal(renewed.ttl_s, 30, `renew ttl_s ${ttl} must keep the previous ttl`);
  }
  answers.push({ expires_at: 'later', ttl_s: 12 });
  assert.equal((await client.renew(lease)).ttl_s, 12, 'a valid renew ttl is adopted');
  // FakeGovernor-served sub-second leases are refused end to end (the fixture used 0.3 s before F6).
  const fixture = new WorkerTestFixture('lease-subsecond');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 0.3 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('117', 'w4', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w4', ['--governor', governor.url]);
    const snapshot = state(fixture, '117');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'lease_unavailable: Governor lease invalid: ttl_s=0.3');
    assert.equal(fixture.getVinciCalls().length, 0);
    assert.equal(governor.renews.length, 0);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// F7: SIGTERM with a lease in flight releases it (abandoned) and SIGTERMs the child before exit.
await test('SIGTERM mid-run: heartbeat stops, lease released abandoned, child SIGTERMed, daemon exits 0', async () => {
  const fixture = new WorkerTestFixture('lease-sigterm');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, ttlS: 1 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('118', 'w5', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const worker = spawnWorker(fixture, 'w5', ['--governor', governor.url], { FAKE_VINCI_SLEEP: '30000' });
    await waitFor(() => fixture.getVinciCalls().length === 1, { label: 'the child spawn' });
    await waitFor(() => governor.renews.length >= 1, { label: 'a renew' });
    const renewsBefore = governor.renews.length;
    const started = Date.now();
    worker.proc.kill('SIGTERM');
    const { code, stderr } = await worker.closed;
    const elapsed = Date.now() - started;
    assert.equal(code, 0, stderr);
    assert(elapsed < 5000, `shutdown must be prompt, took ${elapsed}ms`);
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'abandoned' }]);
    assert.match(stderr, /SIGTERM: releasing lease lease-1 \(task 118\) as abandoned/);
    await new Promise((r) => setTimeout(r, 300));
    assert(governor.renews.length <= renewsBefore + 1, 'the heartbeat stopped (at most one renew was in flight)');
    const releaseAt = governor.events.indexOf('release');
    assert.equal(governor.events.slice(releaseAt + 1).includes('renew:start'), false, `no renew after release (${governor.events.join(',')})`);
    assert(vinciRecordLines(fixture).includes('SIGTERM'), 'the child must be SIGTERMed so nothing works under a released lease');
    const snapshot = state(fixture, '118');
    assert.equal(snapshot.state, 'RUNNING', 'the task record is left for the next daemon start to resume');
    assert.equal(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/118'), false, 'nothing published');
    assert.equal(hasTerminalFailure(fixture.getPostedMessages()), false, 'no terminal failure record must be posted');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('--governor unset => no declaration, no digest, no lease fields, no fencing footer', async () => {
  const fixture = new WorkerTestFixture('lease-off');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('113', 'w4', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w4', []);
    assert.equal(code, 0);
    const snapshot = state(fixture, '113');
    assert.equal(snapshot.state, 'COMPLETED');
    assert.equal('capability_declaration_digest' in snapshot, false);
    assert.equal('aborted' in snapshot, false);
    assert.equal('fenced_out' in snapshot, false);
    assert.equal(snapshot.lease, null);
    assert.equal(fixture.getPostedMessages().some((p) => / declaration$/.test(p.subject)), false);
    // #25 always writes its footer; what an UNGOVERNED run must not carry is the ` fence=`
    // segment — no lease, no generation, nothing for the Governor to be told was in force.
    const create = ghCalls(fixture).find((c) => c.argv.includes('create'));
    const body = create.argv[create.argv.indexOf('--body') + 1];
    assert.match(body, /^vinci-worker: task=113 attempt=1 head=[0-9a-f]{7,64} base=main$/m, body);
    assert.equal(/ fence=/.test(body), false, 'an ungoverned PR must not claim a fence generation');
  } finally {
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// BLOCK-A (#201/#199 review): the Governor's holder gate (governor_runtime.py:335-338) refuses a
// claim on a leased order unless the claim's attempt_id equals the holder's — an ABSENT one
// included. W1B acquires the lease BEFORE the claim, so every governed order is leased at claim
// time: without attempt_id on the claim body, EVERY governed task is refused
// 403 leased_by_other_attempt and blocked by a lease this very worker holds. This FakeGovernor
// enforces the gate the way the server does (claimHolderGate, on by default).
await test('BLOCK-A: the claim carries the acquire attempt_id, so the holder gate admits it', async () => {
  const fixture = new WorkerTestFixture('lease-holder-gate');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('130', 'w6', 'repo: test/repo\nevidence: pr\nref: job_gate\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w6', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    assert.equal(governor.claimHolderGate, true, 'the fake must enforce the gate, or this proves nothing');
    const snapshot = state(fixture, '130');
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(governor.acquires.length, 1);
    assert.equal(governor.claims.length, 1);
    // Byte-identical, and identical to the gate's holder: not merely "present" or "similar".
    assert.equal(governor.acquires[0].attempt_id, '130/1');
    assert.equal(governor.claims[0].attempt_id, governor.acquires[0].attempt_id, 'the claim attempt_id must be the acquire attempt_id, byte for byte');
    assert.equal(governor.claims[0].idempotency_key, governor.acquires[0].attempt_id, 'the claim is idempotency-keyed on the same attempt');
    // And the refusal the missing field would have produced never happened.
    assert.equal(snapshot.outcome?.governor, undefined);
    assert.equal(hasTerminalFailure(fixture.getPostedMessages()), false, 'no terminal failure: the holder gate admitted the claim');
    assert.equal(fixture.getVinciCalls().length, 1, 'the governed task actually ran');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// The gate is real: a claim whose attempt_id is NOT the holder's is refused 403 and the task is
// BLOCKED with the Governor's reason verbatim, the lease released `blocked`. This is the exact
// state an attempt_id-less claim would land every governed task in.
await test('BLOCK-A control: a non-holder attempt_id is refused leased_by_other_attempt and blocks', async () => {
  const fixture = new WorkerTestFixture('lease-holder-gate-neg');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('131', 'w7', 'repo: test/repo\nevidence: pr\n\nTask')]);
    // Force the gate to disagree with whatever the worker sends, exactly as an absent field does.
    const originalHandle = governor.handle.bind(governor);
    governor.handle = async (request, response) => {
      if (request.url === '/v1/governor/claim-paths') governor.holderAttemptId = 'someone-else/1';
      return originalHandle(request, response);
    };
    const { code } = await runWorker(fixture, 'w7', ['--governor', governor.url]);
    assert.equal(code, 0);
    const snapshot = state(fixture, '131');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'leased_by_other_attempt');
    assert.equal(snapshot.outcome.governor, 'refused');
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['blocked'], 'the lease this worker held is released');
    assert.equal(fixture.getVinciCalls().length, 0, 'a refused claim never spawns');
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert(blocker && blocker.body.includes('Governor refused the lease: leased_by_other_attempt'), `blocker: ${blocker?.body}`);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// 2xx acceptance (#201 review): the server's status fix moves a granted acquire from 201 to 200.
// The two repos deploy independently, so the client must take EITHER (and any other 2xx) as a
// lease, provided the body is well formed. A client pinned to 200 would refuse a lease it was
// granted and leave the Governor holding one nobody renews or releases.
await test('acquire accepts any 2xx with a well-formed body; 200 and 201 both grant', async () => {
  for (const status of [200, 201, 202]) {
    const client = new LeaseClient({
      governorUrl: 'http://governor.invalid',
      token: 't',
      fetch: async () => new Response(JSON.stringify({ lease_id: 'l1', fencing_generation: 7, expires_at: '2099-01-01T00:00:00Z', ttl_s: 60 }), { status, headers: { 'content-type': 'application/json' } }),
    });
    const result = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1', workerBuildDigest: 'abc', adapterVersion: '0' });
    assert.equal(result.success, true, `status ${status} must grant the lease`);
    assert.equal(result.lease.lease_id, 'l1');
    assert.equal(result.lease.fencing_generation, 7);
    assert.equal(result.lease.ttl_s, 60);
  }
  // A 2xx is never enough on its own: the body still has to bound the run.
  for (const status of [200, 201]) {
    const client = new LeaseClient({
      governorUrl: 'http://governor.invalid',
      token: 't',
      fetch: async () => new Response(JSON.stringify({ lease_id: 'l1', fencing_generation: 7, ttl_s: 0 }), { status, headers: { 'content-type': 'application/json' } }),
    });
    const result = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1' });
    assert.equal(result.unavailable, true, `status ${status} with an unusable ttl_s is not a lease`);
    assert.match(result.reason, /^Governor lease invalid: ttl_s=0$/);
  }
  // 3xx/4xx/5xx are still not leases.
  for (const status of [199, 302, 400, 500]) {
    const client = new LeaseClient({
      governorUrl: 'http://governor.invalid',
      token: 't',
      fetch: async () => new Response(JSON.stringify({ lease_id: 'l1', fencing_generation: 7, ttl_s: 60 }), { status, headers: { 'content-type': 'application/json' } }),
    });
    const result = await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1' });
    assert.equal(result.success, false, `status ${status} must not grant a lease`);
    assert.equal(result.blocked, true);
  }
  // renew, release and check are on the same rollout and take any 2xx too.
  const lease = { lease_id: 'l1', fencing_generation: 7, ttl_s: 60 };
  for (const status of [200, 201]) {
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', busToken: 'b', log: () => {}, fetch: async (url) => {
      if (/\/check$/.test(url)) return new Response(JSON.stringify({ valid: true }), { status, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ expires_at: '2099-01-01T00:00:00Z', ttl_s: 60 }), { status, headers: { 'content-type': 'application/json' } });
    } });
    assert.equal((await client.renew(lease)).ok, true, `renew must accept ${status}`);
    assert.equal((await client.release(lease, 'completed')).ok, true, `release must accept ${status}`);
    assert.equal((await client.check(lease)).valid, true, `check must accept ${status}`);
  }
});

// A granted acquire served as 201 by a pre-fix Governor still runs the whole governed task.
await test('2xx acceptance end to end: a 201 acquire runs, renews, fences and releases', async () => {
  const fixture = new WorkerTestFixture('lease-201');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, acquireStatus: 201 });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('132', 'w8', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w8', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    assert.equal(governor.acquireStatus, 201, 'the fake must serve 201, or this proves nothing');
    const snapshot = state(fixture, '132');
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.lease.lease_id, 'lease-1');
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['completed']);
    assert.equal(fixture.getVinciCalls().length, 1);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// WARN-3 (#201): lease-state answers are DECISIONS — final loss of authority, never retried —
// and the server is moving them from 403 to 409. The client must be right under BOTH, and must
// still fail CLOSED on anything it cannot classify. Nothing here assumes the server change landed.
await test('WARN-3: the reasons the server ACTUALLY emits are decisions on 403 and 409; anything else fails closed', async () => {
  const lease = { lease_id: 'l1', fencing_generation: 7, ttl_s: 60 };
  const renewWith = async (status, body) => {
    let calls = 0;
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', log: () => {}, fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    } });
    return { result: await client.renew(lease), calls: () => calls };
  };
  // D1: EVERY 403 on a lease route is an authority refusal (CONTRACT §29.1) — the status decides,
  // the reason is payload carried verbatim. These are real observed strings, but they are now
  // examples rather than the predicate: the list below deliberately includes reasons NOT known to
  // this client, because a reason nobody has seen yet must classify identically.
  const SERVER_403_REASONS = [
    'work order expired',                             // governor_runtime.py:530, 843
    'session not in a live state',                    // governor_runtime.py:854
    'work order deadline rule: deadline has passed',  // app.py:152 (_DEADLINE_PASSED)
    'unknown lease',                                  // relayed (#201 branch)
    'lease not held by this session',                 // relayed (#201 branch)
    'session does not hold this work order',          // OBSERVED on the wire by the integration —
                                                      // the one this client used to file as a
                                                      // transport fault (D1)
    'a reason this client has never heard of',        // the whole point: no list is consulted
    '',                                               // and an empty/absent reason is still a 403
  ];
  for (const reason of SERVER_403_REASONS) {
    const { result, calls } = await renewWith(403, { reason });
    assert.equal(result.ok, false, `403 ${reason}`);
    assert.equal(result.lost, true, `403 ${reason}`);
    // An empty reason has nothing to carry verbatim and falls back to the generic label.
    assert.equal(result.reason, reason || 'refused', `403 "${reason}" must be a decision carrying its reason, not "unreachable"`);
    assert.equal(calls(), 1, `a decision is never retried (403 "${reason}")`);
  }
  // A 403 with NO reason field at all, and one with a non-string reason: still a decision.
  for (const body of [{}, { reason: null }, { reason: 42 }]) {
    const { result, calls } = await renewWith(403, body);
    assert.deepEqual({ ok: result.ok, lost: result.lost, reason: result.reason }, { ok: false, lost: true, reason: 'refused' }, `403 ${JSON.stringify(body)}`);
    assert.equal(calls(), 1);
  }
  // The `|| !body` guard that used to sit in leaseStateDecision is GONE, and that is a deliberate
  // behaviour change, not an oversight: on main a 403/409 whose body did not PARSE returned null,
  // fell through to the transport path, and was RETRIED as if the Governor had been unreachable.
  // It is a decision by STATUS — an unparseable body cannot turn a refusal into a network blip,
  // and retrying one spends an attempt on an answer that will not change. Nothing else in this
  // suite exercises the undefined-body path (the cases above all parse), so it is pinned here.
  const renewRaw = async (status, text) => {
    let calls = 0;
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', log: () => {}, fetch: async () => {
      calls += 1;
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    } });
    return { result: await client.renew(lease), calls: () => calls };
  };
  for (const status of [403, 409]) {
    const { result, calls } = await renewRaw(status, '<<not json at all>>');
    assert.equal(result.ok, false, `${status} with an unparseable body`);
    assert.equal(result.lost, true, `${status} with an unparseable body must still be a LOSS`);
    assert.equal(result.reason, 'refused', `${status} with an unparseable body is a decision, not "unreachable"`);
    assert.equal(calls(), 1, `${status} with an unparseable body must NOT be retried`);
  }

  // A deadline rule is one of a "<rule>: <detail>" family. It needed a prefix rule when reasons
  // were the predicate; now it is simply another 403.
  const { result: deadline, calls: deadlineCalls } = await renewWith(403, { reason: 'work order deadline rule: something else entirely' });
  assert.equal(deadline.reason, 'work order deadline rule: something else entirely');
  assert.equal(deadlineCalls(), 1);
  // The wire reasons the Wave 1B lease contract specifies, on the new 409 and the old 403.
  for (const reason of ['stale_generation', 'expired', 'revoked', 'released', 'leased_by_other_attempt']) {
    for (const status of [409, 403]) {
      const { result, calls } = await renewWith(status, { reason });
      assert.deepEqual({ ok: result.ok, lost: result.lost, reason: result.reason }, { ok: false, lost: true, reason }, `${status} ${reason}`);
      assert.equal(calls(), 1, `a decision is never retried (${status} ${reason})`);
    }
  }
  // Anything else non-2xx is transport/unknown: retried once, then LOSS OF AUTHORITY (fail closed).
  // Deliberately NOT a blanket 4xx — 408 and 429 are transient and must keep their retry, and a
  // 404 is not one of the two statuses the contract names, whatever reason it carries.
  for (const [status, body] of [[500, { reason: 'boom' }], [502, {}], [404, { reason: 'stale_generation' }], [408, {}], [429, { reason: 'slow down' }]]) {
    const { result, calls } = await renewWith(status, body);
    assert.deepEqual({ ok: result.ok, lost: result.lost, reason: result.reason }, { ok: false, lost: true, reason: 'unreachable' }, `status ${status} ${JSON.stringify(body)}`);
    assert.equal(calls(), 2, `an unknown failure is retried exactly once (status ${status})`);
  }
});

// The same rule at ACQUIRE. A lease-state answer there is a Governor DECISION and must be filed as
// one: `leased` when it names another holder, `refused` otherwise. Before this, everything but a
// 409 "leased" came back `lease_unavailable: unexpected status 409` with
// `outcome.governor = "unavailable"` — a decision recorded as a failure.
await test('WARN-3 at acquire: lease-state answers are decisions (leased vs refused), never "unavailable"', async () => {
  const acquireWith = async (status, body) => {
    let calls = 0;
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    } });
    return { result: await client.acquire({ workOrderId: 'job_x', attemptId: 'x/1' }), calls: () => calls };
  };
  // Held by another attempt: `leased`, with the holder and expiry the operator can act on.
  for (const [status, reason] of [[409, 'leased'], [403, 'leased_by_other_attempt'], [403, 'lease not held by this session']]) {
    const { result, calls } = await acquireWith(status, { reason, holder_attempt_id: 'other/7', expires_at: '2099-01-01T00:00:00Z' });
    assert.equal(result.leased, true, `acquire ${status} ${reason} is a "not ours" decision`);
    assert.equal(result.blocked, true);
    assert.equal(result.unavailable, undefined, 'a decision is never also a failure');
    assert.equal(result.holder_attempt_id, 'other/7');
    assert.equal(calls(), 1, 'an acquire decision is never retried');
  }
  // The order itself will not admit this attempt: `refused`, reason verbatim.
  for (const [status, reason] of [
    [409, 'work order expired'], [409, 'session not in a live state'], [409, 'expired'], [409, 'revoked'],
    [403, 'work order expired'], [403, 'work order deadline rule: deadline has passed'], [403, 'unknown lease'],
    // D1: the reason text is NOT a predicate. A 403 this client has never seen is still a refusal
    // — this is the case the integration caught being filed as `unavailable`.
    [403, 'session does not hold this work order'], [403, 'something no list contains'],
    [409, 'a 409 reason nobody enumerated'],
  ]) {
    const { result, calls } = await acquireWith(status, { reason });
    assert.equal(result.refused, true, `acquire ${status} ${reason} must be a REFUSAL decision`);
    assert.equal(result.blocked, true);
    assert.equal(result.leased, undefined);
    assert.equal(result.unavailable, undefined, 'a Governor decision must never be filed as a Governor failure');
    assert.equal(result.reason, reason, 'the rule text rides verbatim');
    assert.equal(calls(), 1);
  }
  // Not a decision: still fails closed as unavailable. Only statuses OUTSIDE the contract's
  // 403/409 pair land here — a 403 never does, whatever it says.
  for (const [status, body] of [[500, { reason: 'boom' }], [418, {}], [404, { reason: 'revoked' }], [429, {}]]) {
    const { result } = await acquireWith(status, body);
    assert.equal(result.unavailable, true, `acquire ${status} ${JSON.stringify(body)} is a failure, not a decision`);
    assert.equal(result.refused, undefined);
    assert.equal(result.blocked, true);
  }
});

// A lease-state refusal at acquire reaches the task record and the blocker post as a DECISION.
await test('WARN-3 at acquire, end to end: 409 work order expired => BLOCKED refused, not unavailable', async () => {
  const fixture = new WorkerTestFixture('lease-acquire-refused');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, mode: 'refuse', refusal: { status: 409, reason: 'work order expired' } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('142', 'w8', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w8', ['--governor', governor.url]);
    assert.equal(code, 0);
    const snapshot = state(fixture, '142');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'work order expired', 'the rule text verbatim, with no lease_unavailable prefix');
    assert.equal(snapshot.outcome.governor, 'refused', 'a Governor DECISION, not "unavailable"');
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert(blocker && blocker.body.includes('Governor refused the lease: work order expired'), `blocker: ${blocker?.body}`);
    assert.equal(fixture.getVinciCalls().length, 0, 'must not spawn');
    assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'must not clone');
    assert.equal(governor.claims.length, 0, 'no claim is taken for a lease that was refused');
    assert.equal(governor.releases.length, 0, 'nothing to release');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// A fencing_generation the SERVER would reject on the way in must be refused at acquire, before
// any work — not accepted and then 400'd on the first renew, mid-run, after the child is spawned.
await test('D2 fencing_generation: an integer >= 1, and nothing else — strings included', async () => {
  const acquireGeneration = async (fencing_generation) => {
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', fetch: async () => new Response(JSON.stringify({ lease_id: 'l1', fencing_generation, ttl_s: 60 }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    return client.acquire({ workOrderId: 'job_x', attemptId: 'x/1' });
  };
  // `app.py::_generation_from` requires `type is int and >= 1` and 400s otherwise, so anything
  // else is a value this client could never hand back successfully. Refusing at ACQUIRE blocks
  // cleanly, before the clone, the spawn and any spend.
  for (const bad of [0, -3, 1.5, -0.0001, Number.NaN, Infinity, null, undefined, {}, [], true]) {
    const result = await acquireGeneration(bad);
    assert.equal(result.success, false, `fencing_generation ${JSON.stringify(bad)} must not be a lease`);
    assert.equal(result.unavailable, true);
    assert.match(result.reason, /^Governor lease invalid: fencing_generation=/);
  }
  // D2: STRINGS are refused too, and this is the case the integration flagged. The old code
  // accepted them so the fence "could not become inadmissible" — but the server 400s a string on
  // every renew, so accepting one did not avoid the failure, it moved it to mid-run: acquire ok,
  // clone done, child spawned, first renew 400 -> retried -> `unreachable` -> authority lost ->
  // SIGTERM. The same argument that narrowed the number half narrows this one.
  for (const token of ['gen-1', '1', '00000000-0000-4000-8000-000000000000', '']) {
    const result = await acquireGeneration(token);
    assert.equal(result.success, false, `a string generation ${JSON.stringify(token)} must be refused at acquire, not mid-run`);
    assert.equal(result.unavailable, true);
    assert.match(result.reason, /^Governor lease invalid: fencing_generation=/);
    // The offending value is IN the reason, so an operator sees what the server sent.
    assert(result.reason.includes(JSON.stringify(token)), result.reason);
  }
  for (const good of [1, 7, 100, Number.MAX_SAFE_INTEGER]) {
    const result = await acquireGeneration(good);
    assert.equal(result.success, true, `integer ${good} is a usable generation`);
    assert.equal(result.lease.fencing_generation, good);
  }
});

// ---------------------------------------------------------------------------------------------
// BLOCK-B (#199 review): the Governor expires a capability declaration at VGC_DECLARATION_MAX_AGE_S
// (default 86400 s) and then answers admission `eligible: false, reason: stale_declaration`. A
// declaration posted only at startup therefore makes any daemon alive more than a day silently
// inadmissible for ALL work, with no warning and no recovery. The declaration is re-posted on an
// interval (VINCI_DECLARATION_REFRESH_S, default DECLARATION_REFRESH_DEFAULT_S) on the SAME code path as the startup post.
// (The guard for "the refresh timer never holds the process open" is the FIRST test in this file.)
function declarationPosts(fixture, workerId) {
  return fixture.getPostedMessages().filter((post) => post.subject === `worker ${workerId} declaration`);
}

// A daemon (no --once) so the interval can actually fire.
function spawnDaemon(fixture, workerId, extraArgs, envOverrides = {}) {
  const env = fixture.getEnv({ VINCI_GOVERNOR_TOKEN: 'gov-token', ...envOverrides });
  const proc = spawn('node', [WORKER, 'start', '--id', workerId, '--server', fixture.busUrl(), '--state-dir', fixture.tempDir, ...extraArgs], { env, stdio: 'pipe' });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((r) => proc.on('close', (code) => r({ code, stderr })));
  return { proc, closed, stderr: () => stderr };
}

await test('BLOCK-B: the declaration is re-posted on the refresh interval, byte-identical', async () => {
  const fixture = new WorkerTestFixture('declaration-refresh');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  let worker = null;
  try {
    await fixture.startBus([]);
    worker = spawnDaemon(fixture, 'w1', ['--governor', governor.url, '--poll-seconds', '0.2'], { VINCI_DECLARATION_REFRESH_S: '0.4' });
    await waitFor(() => declarationPosts(fixture, 'w1').length >= 3, { label: 'three declaration posts (startup + two refreshes)' });
    const posts = declarationPosts(fixture, 'w1');
    // Same code path ⇒ identical canonical body ⇒ identical digest, so a re-post refreshes the
    // Governor's record instead of replacing it with a different declaration.
    assert.equal(new Set(posts.map((p) => p.body)).size, 1, 'every re-post must be byte-identical to the startup post');
    assert.equal(new Set(posts.map((p) => sha256(p.body))).size, 1, 'and therefore carry the same digest');
    assert.equal(posts[0].kind, 'status');
    assert.equal(JSON.parse(posts[0].body).schemaVersion, 1);
  } finally {
    worker?.proc.kill('SIGTERM');
    await worker?.closed;
    await governor.close();
    await fixture.cleanup();
  }
});

await test('BLOCK-B: a failed re-post is logged, never fatal, and the poll loop keeps running', async () => {
  const fixture = new WorkerTestFixture('declaration-refresh-fail');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  let worker = null;
  try {
    await fixture.startBus([]);
    worker = spawnDaemon(fixture, 'w2', ['--governor', governor.url, '--poll-seconds', '0.2'], { VINCI_DECLARATION_REFRESH_S: '0.4' });
    await waitFor(() => declarationPosts(fixture, 'w2').length >= 1, { label: 'the startup declaration' });
    // Refuse every declaration re-post for a while.
    fixture.failPostSubjects = / declaration$/;
    await waitFor(() => fixture.failedPosts.length >= 2, { label: 'two refused re-posts' });
    const pollsAtFailure = fixture.getRequests.length;
    // The daemon is still polling: a refused declaration must not stop the loop or kill the process.
    await waitFor(() => fixture.getRequests.length >= pollsAtFailure + 3, { label: 'polls after the refused re-posts' });
    assert.equal(worker.proc.exitCode, null, 'a refused re-post must not kill the daemon');
    // …and it recovers on its own once the bus accepts posts again.
    const before = declarationPosts(fixture, 'w2').length;
    fixture.failPostSubjects = null;
    await waitFor(() => declarationPosts(fixture, 'w2').length > before, { label: 'a recovered re-post' });
    assert.match(worker.stderr(), /declaration re-post failed \(\d+ in a row\).*stale_declaration/, `stderr must record the failure: ${worker.stderr()}`);
  } finally {
    fixture.failPostSubjects = null;
    worker?.proc.kill('SIGTERM');
    const { code } = (await worker?.closed) ?? {};
    assert.equal(code, 0, 'the daemon must still exit cleanly');
    await governor.close();
    await fixture.cleanup();
  }
});

await test('BLOCK-B: the refresh interval defaults to 3600 s and ignores an unusable override', async () => {
  for (const env of [{}, { VINCI_DECLARATION_REFRESH_S: 'soon' }, { VINCI_DECLARATION_REFRESH_S: '0' }, { VINCI_DECLARATION_REFRESH_S: '-5' }]) {
    const fixture = new WorkerTestFixture('declaration-refresh-default');
    const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
    await governor.start();
    let worker = null;
    try {
      await fixture.startBus([]);
      worker = spawnDaemon(fixture, 'w4', ['--governor', governor.url, '--poll-seconds', '0.2'], env);
      await waitFor(() => declarationPosts(fixture, 'w4').length >= 1, { label: 'the startup declaration' });
      const pollsBefore = fixture.getRequests.length;
      await waitFor(() => fixture.getRequests.length >= pollsBefore + 5, { label: 'several poll cycles' });
      assert.equal(declarationPosts(fixture, 'w4').length, 1, `${JSON.stringify(env)}: the default hour-scale interval must not fire within a couple of seconds`);
    } finally {
      worker?.proc.kill('SIGTERM');
      await worker?.closed;
      await governor.close();
      await fixture.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The claim-paths ttl interlock. VERIFIED against vinci-gpu-control main: the 200 body is
// `{ok, reason, claim_hash, paths}` (app.py:2888-2893) with NO `ttl`, while this client refuses a
// 200 without a finite positive ttl (governor.mjs) — so with BLOCK-A fixed and the claim finally
// reaching the gate, today's server blocks every governed task one step later, at
// `Governor lease invalid: ttl=undefined`. The server fix (returning the ttl it already computes)
// is dispatched on gpu-control #201.
//
// The client's ttl requirement STAYS: `tightenEnvelopeLimits` caps the run's `max_runtime_s` on
// the claim ttl (worker-governor-fail-closed.mjs T3/T3b/T3c), so accepting a ttl-less claim would
// silently delete a runtime cap rather than fix anything. This test is the tripwire on that
// disagreement: it fails if the client stops requiring the ttl, and it fails if the fixture goes
// back to inventing one.
await test('claim-paths without ttl (the DEPLOYED server shape) blocks before any work', async () => {
  const fixture = new WorkerTestFixture('claim-no-ttl');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_DEPLOYED });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('140', 'w6', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w6', ['--governor', governor.url]);
    assert.equal(code, 0);
    // The fixture is serving the real shape, not an invented one.
    assert.equal('ttl' in CLAIM_PATHS_DEPLOYED, false, 'the deployed claim response has no ttl');
    assert.deepEqual(Object.keys(CLAIM_PATHS_DEPLOYED).sort(), ['claim_hash', 'ok', 'paths', 'reason']);
    const snapshot = state(fixture, '140');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.outcome.reason, 'Governor lease invalid: ttl=undefined');
    assert.equal(snapshot.outcome.governor, 'unavailable', 'a body that cannot bound the run is a FAILURE, not a Governor decision');
    // It got past the holder gate — this is the NEXT blocker, not BLOCK-A coming back.
    assert.equal(governor.claims.length, 1, 'the claim was made');
    assert.equal(governor.claims[0].attempt_id, '140/1', 'and carried the holder attempt_id');
    // Fail closed, and the lease this worker held is given back.
    assert.equal(fixture.getVinciCalls().length, 0, 'must not spawn');
    assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'must not clone');
    assert.deepEqual(governor.releases.map((r) => r.outcome), ['blocked']);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// The same body once #201 adds the ttl: the identical task runs to completion, and the claim ttl
// becomes the run's runtime cap. Together with the test above this pins BOTH sides of the fix.
await test('claim-paths WITH ttl (the fixed server) runs, and the claim ttl caps the runtime', async () => {
  const fixture = new WorkerTestFixture('claim-with-ttl');
  const governor = new FakeGovernor({ claim: { ...CLAIM_PATHS_WITH_TTL, ttl: 77 } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('141', 'w7', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w7', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '141');
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.lease.ttl, 77);
    assert.equal(snapshot.lease.effective_max_runtime_s, 77, 'the claim ttl is a runtime cap — dropping the ttl requirement would delete it');
    assert.equal(fixture.getVinciCalls().length, 1);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// #26 x #24. Main's guard refuses --clean-room under a Governor BEFORE the run, because
// publishFromCache is a fork of the PRE-#25 publisher: no fence, and none of #25's remote-sha
// lease, push read-back, idempotent retry, foreign-PR refusal or PR-head check. Its own comment
// says wiring the fence MUST bring this test with it — until now `fence` was null everywhere, so
// nothing could reach the guard and deleting it left every suite green.
//
// The guard's predicate is `governorUrl`, not the fence object: the fence is constructed after the
// lease is acquired, which is AFTER this point, so `cleanRoom && fence` would be false forever.
await test('#26 x #24: --clean-room under a Governor is refused BEFORE the run', async () => {
  const fixture = new WorkerTestFixture('clean-room-fence');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('150', 'w1', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w1', ['--governor', governor.url, '--clean-room']);
    assert.equal(code, 0);
    const snapshot = state(fixture, '150');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.match(snapshot.outcome.reason, /^clean_room_publish_unsupported: /);
    assert.match(snapshot.outcome.reason, /does not honour a Governor fence/);
    // BEFORE the run is the whole point: nothing is spawned, nothing is cloned, and no lease is
    // even taken — an unsupported configuration must cost zero, not produce a paid commit that
    // can never be published.
    assert.equal(fixture.getVinciCalls().length, 0, 'the model must not be spawned');
    assert.equal(governor.acquires.length, 0, 'no lease is taken for a configuration that cannot publish under it');
    assert.equal(governor.claims.length, 0);
    assert.equal(ghCalls(fixture).length, 0, 'nothing published');
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert(blocker && blocker.body.includes('clean_room_publish_unsupported'), `blocker: ${blocker?.body}`);
  } finally {
    // If the guard ever stops firing, the clean room DOES run and seals its attempt dir read-only,
    // and an un-chmod'd rmSync then throws ENOTEMPTY — the mutant would be "detected" by a
    // teardown crash instead of by the assertions above. Unseal unconditionally so the failure is
    // always the named one.
    spawnSync('chmod', ['-R', 'u+w', fixture.tempDir]);
    await governor.close();
    await fixture.cleanup();
  }
});

// The CONTROL that keeps the guard honest in the other direction: --clean-room on its own is a
// supported mode and must still run. Without this, narrowing the guard to `if (cleanRoom)` would
// refuse every clean-room task and no test would notice.
await test('#26 x #24 control: --clean-room WITHOUT a Governor still runs', async () => {
  const fixture = new WorkerTestFixture('clean-room-no-governor');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('151', 'w2', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w2', ['--clean-room']);
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '151');
    assert.notEqual(snapshot.state, 'BLOCKED', `ungoverned clean room must not be refused (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(/clean_room_publish_unsupported/.test(JSON.stringify(snapshot.outcome ?? {})), false);
    // The run really happened: it reached a terminal COMPLETED with a push and a PR. (Not
    // getVinciCalls(): #24's clean room hands the child an ALLOWLISTED env, and the fixture's
    // FAKE_VINCI_RECORD is not on that allowlist, so the recorder is invisible from inside —
    // the reached state is the evidence here, not the recorder.)
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.publish, 'pushed');
  } finally {
    // #24 seals each attempt dir read-only, so rmSync alone hits ENOTEMPTY (same reason
    // worker-clean-room.mjs does this before its own cleanup).
    spawnSync('chmod', ['-R', 'u+w', fixture.tempDir]);
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The fence contract itself, against #25's publisher. `authorityLost` must land on main's
// semantics: a check that answers `{valid:false}` AND a check that THROWS both mean fenced out.
// The daemon's fence answers rather than throws, but the throw path is the fail-closed backstop
// and is asserted here so it cannot silently become fail-open.
await test('fence contract: a throwing check is fenced out, exactly like valid:false', async () => {
  const calls = [];
  const fakeExec = async (name, args) => {
    calls.push([name, ...args]);
    if (name === 'git' && args.includes('rev-parse')) return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (name === 'git' && args.includes('ls-remote')) return { status: 0, stdout: '', stderr: '' };
    if (name === 'gh') return { status: 0, stdout: '[]', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const base = { repoDir: '/tmp/nonexistent-repo', branch: 'worker/x', taskId: 'x', exec: fakeExec, promotion: 'none' };

  // (a) a check that returns valid:false
  const refused = await publish({ ...base, fence: { generation: 5, check: async () => ({ valid: false, reason: 'revoked' }) } });
  assert.equal(refused.publish, 'fenced_out');
  assert.equal(refused.fenced_out, 'revoked');

  // (b) a check that THROWS — same outcome, reason names the stage
  const threw = await publish({ ...base, fence: { generation: 5, check: async () => { throw new Error('governor unreachable'); } } });
  assert.equal(threw.publish, 'fenced_out', 'a throwing check must fence out, never publish');
  assert.match(threw.fenced_out, /^fence check failed before push: governor unreachable$/);

  // (c) a check returning a non-object, or nothing at all — still fenced out (fail closed)
  for (const bad of [undefined, null, {}, { valid: 'yes' }, { valid: 1 }]) {
    const result = await publish({ ...base, fence: { generation: 5, check: async () => bad } });
    assert.equal(result.publish, 'fenced_out', `check returning ${JSON.stringify(bad)} must fence out`);
  }

  // (d) NO push was attempted on any of those paths.
  assert.equal(calls.some((c) => c.includes('push')), false, 'nothing may be pushed behind a fence that did not pass');
});

// The daemon's own fence object, unit-level: the generation is a GETTER over the live lease, so it
// can never carry a value that has gone stale since the object was built.
await test("fence contract: the daemon's generation is read through to the live lease, not captured", async () => {
  // Model the daemon's construction exactly: the object is built while `lease` is still null.
  let lease = null;
  const fence = {
    get generation() {
      return lease?.fencing_generation ?? null;
    },
    check: async () => ({ valid: true }),
  };
  // Built before the acquire — a captured snapshot would have frozen `null` here forever.
  assert.equal(fence.generation, null, 'no lease yet: no generation to claim');
  lease = { lease_id: 'lease-1', fencing_generation: 100, ttl_s: 60 };
  assert.equal(fence.generation, 100, 'the getter resolves against the lease acquired later');
  // If a generation ever changes mid-attempt, the fence follows it rather than fencing on a
  // generation the Governor has already retired.
  lease.fencing_generation = 101;
  assert.equal(fence.generation, 101, 'a changed generation is picked up, never stale');
  // And the PR footer #25 writes reads the same getter at PR-creation time.
  assert.match(prBodyFooter({ taskId: 't', attempt: 1, head: 'abc1234', baseRef: 'main', fence }), / fence=101$/);
  lease = null;
  assert.equal(fence.generation, null, 'a released lease claims no generation');
  assert.equal(/ fence=/.test(prBodyFooter({ taskId: 't', attempt: 1, head: 'abc1234', baseRef: 'main', fence })), false);
});

// The refresh cadence is a RELATIONSHIP, not a magic number: often enough that several
// consecutive failed re-posts still leave the declaration fresh, and no more often than that,
// because every refresh writes a row into an append-only table (gpu-control §32:
// `worker_declarations` carries a DELETE trigger, so the volume cannot be pruned later).
// Asserting the ratio catches both directions — a value that eats the failure headroom AND a
// value that quietly multiplies the row growth this default exists to bound.
await test('declaration refresh cadence keeps its headroom inside the Governor staleness window', async () => {
  assert.equal(GOVERNOR_DECLARATION_MAX_AGE_S, 86400, "the Governor's documented default window");
  assert(DECLARATION_REFRESH_DEFAULT_S > 0);
  assert(
    DECLARATION_REFRESH_DEFAULT_S * REFRESH_HEADROOM_FACTOR <= GOVERNOR_DECLARATION_MAX_AGE_S,
    `a ${DECLARATION_REFRESH_DEFAULT_S}s interval leaves fewer than ${REFRESH_HEADROOM_FACTOR} refreshes inside the ${GOVERNOR_DECLARATION_MAX_AGE_S}s window`,
  );
  // …and not so frequent that the row growth the default is chosen against comes back: anything
  // under a quarter of the headroom interval is multiplying rows for no liveness gain.
  assert(
    DECLARATION_REFRESH_DEFAULT_S >= GOVERNOR_DECLARATION_MAX_AGE_S / (REFRESH_HEADROOM_FACTOR * 4),
    `a ${DECLARATION_REFRESH_DEFAULT_S}s interval writes rows far faster than the staleness window requires`,
  );
  assert.equal(DECLARATION_REFRESH_DEFAULT_S, 21600, '6h — four refreshes inside the 24h window');
});

// ---------------------------------------------------------------------------------------------
// D1 end to end, on the exact bytes the integration captured:
// `403 {"reason":"session does not hold this work order"}` at acquire. Before this fix that was
// recorded as `outcome.governor = "unavailable"` with a blocker reading
// `lease_unavailable: Governor error: unexpected status 403 …` — a Governor DECISION filed as a
// Governor FAILURE, which is what the soak ledger reads and what the README promises never
// happens. 14 of the server's 15 lease-route 403 reasons took that path.
await test('D1 end to end: a 403 the client has never seen is a REFUSAL, not "unavailable"', async () => {
  const fixture = new WorkerTestFixture('lease-403-refusal');
  const governor = new FakeGovernor({ claim: CLAIM_PATHS_WITH_TTL, mode: 'refuse', refusal: { status: 403, reason: 'session does not hold this work order' } });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('160', 'w5', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code } = await runWorker(fixture, 'w5', ['--governor', governor.url]);
    assert.equal(code, 0);
    const snapshot = state(fixture, '160');
    assert.equal(snapshot.state, 'BLOCKED');
    // The reason rides VERBATIM — no `lease_unavailable:` prefix, no "unexpected status 403".
    assert.equal(snapshot.outcome.reason, 'session does not hold this work order');
    assert.equal(snapshot.outcome.governor, 'refused', 'a 403 on a lease route is a DECISION');
    assert.equal(/unavailable/.test(JSON.stringify(snapshot.outcome)), false, 'never filed as unavailability');
    const blocker = findTerminalFailure(fixture.getPostedMessages());
    assert(blocker.body.includes('Governor refused the lease: session does not hold this work order'), `blocker: ${blocker.body}`);
    assert.equal(/lease_unavailable/.test(blocker.body), false, 'the blocker must not say unavailable');
    assert.equal(/unexpected status/.test(blocker.body), false);
    // Fail closed either way: nothing ran, nothing was claimed.
    assert.equal(fixture.getVinciCalls().length, 0);
    assert.equal(governor.claims.length, 0);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// The other half of D1: one wasted retry at renew. A 403 is final, so it must cost exactly ONE
// request — the integration measured the old path spending two.
await test('D1: a 403 at renew costs exactly one request, never a retry', async () => {
  for (const reason of ['session does not hold this work order', 'some reason added to the server next week']) {
    let calls = 0;
    const client = new LeaseClient({ governorUrl: 'http://governor.invalid', token: 't', log: () => {}, fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ reason }), { status: 403, headers: { 'content-type': 'application/json' } });
    } });
    const result = await client.renew({ lease_id: 'l1', fencing_generation: 7, ttl_s: 60 });
    assert.deepEqual({ ok: result.ok, lost: result.lost, reason: result.reason }, { ok: false, lost: true, reason });
    assert.equal(calls, 1, `403 "${reason}" must not be retried`);
  }
});

console.log(`\nWorker lease loop tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
