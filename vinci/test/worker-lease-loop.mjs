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
import { FakeGovernor, WorkerTestFixture } from './lib/worker-fixture.mjs';
import { CAPABILITY_MATRIX, LEASE_TIMEOUT_MS, LeaseClient, buildDeclaration, declarationDigest, startHeartbeat } from '../worker/lease.mjs';

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
// L1 + L2 + L3 + L4 + D1 happy path: one governed task, evidence: pr.
await test('happy path: acquire before clone, renew at ttl/3, fenced push+PR, release completed', async () => {
  const fixture = new WorkerTestFixture('lease-happy');
  const governor = new FakeGovernor({ ttlS: 1 });
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
    assert.match(body, /\n---\nfencing_generation: 100$/, `PR body footer: ${JSON.stringify(body)}`);

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
  const governor = new FakeGovernor({ mode: 'leased', holder: { holder_attempt_id: 'other-worker/7', expires_at: '2099-01-01T00:00:00.000Z' } });
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
    const blocker = fixture.getPostedMessages().find((p) => p.kind === 'blocker');
    assert.match(blocker.body, /^Governor lease held elsewhere: leased_by other-worker\/7 until 2099-01-01T00:00:00\.000Z worker_build=/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('unusable lease answer at acquire (500) => BLOCKED lease_unavailable, fail closed', async () => {
  const fixture = new WorkerTestFixture('lease-500');
  const governor = new FakeGovernor({ mode: 'error' });
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
    const blocker = fixture.getPostedMessages().find((p) => p.kind === 'blocker');
    assert.match(blocker.body, /^Governor lease unavailable: lease_unavailable:/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('unreachable governor at acquire => lease_unavailable (connection failed); a 200 without a lease is not a lease', async () => {
  const probe = new FakeGovernor();
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
  const governor = new FakeGovernor({ ttlS: 1, renewOkCount: 3, renewFailure: { status: 409, reason: 'stale_generation' } });
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
    assert.equal(ghCalls(fixture).length, 0, 'no PR calls');
    assert.equal(governor.checks.length, 0, 'authority already lost: no check is even asked');
    // evidence bundle still attempted, marked authority: lost; the ledger POST is fenced out.
    const result = uploadedResultJson(fixture);
    assert.equal(result.authority, 'lost');
    assert.equal(result.state, 'BLOCKED');
    assert.equal(fixture.getEvidencePosts().length, 0, 'no evidence POST on a lost lease');
    assert.equal(snapshot.evidence_error, 'fenced_out:lease_lost:stale_generation');
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'abandoned' }]);
    assert.equal(governor.renews.length, 4, 'three granted renews, then the refused one; no renew after loss');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

await test('renew unreachable (socket dropped) is retried once, then lease_lost:unreachable', async () => {
  const fixture = new WorkerTestFixture('lease-drop');
  const governor = new FakeGovernor({ ttlS: 1, renewOkCount: 3, renewFailure: 'drop' });
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
  const governor = new FakeGovernor({ check: false });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('106', 'w6', 'repo: test/repo\nevidence: pr\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w6', ['--governor', governor.url]);
    assert.equal(code, 0, stderr);
    const snapshot = state(fixture, '106');
    assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.outcome.reason, 'fenced_out:revoked');
    assert.equal(snapshot.publish, 'fenced_out');
    assert.equal(snapshot.fenced_out, 'fenced_out:revoked');
    assert.equal(snapshot.pr, null);
    assert.equal(fixture.getVinciCalls().length, 1, 'the run itself happened');
    assert.equal(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/106'), false, 'push must be skipped');
    assert.equal(ghCalls(fixture).length, 0, 'no PR calls');
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
  const governor = new FakeGovernor({ check: (_body, index) => (index === 0 ? { valid: true, reason: 'ok' } : { valid: false, reason: 'revoked' }) });
  await governor.start();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('107', 'w7', 'repo: test/repo\nevidence: pr\n\nTask')]);
    await runWorker(fixture, 'w7', ['--governor', governor.url]);
    const snapshot = state(fixture, '107');
    assert.equal(snapshot.state, 'BLOCKED');
    assert.equal(snapshot.outcome.reason, 'fenced_out:revoked');
    assert.equal(snapshot.publish, 'pushed');
    assert(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/107'));
    assert.equal(ghCalls(fixture).length, 0, 'PR must be skipped');
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid]), [['push', true], ['pr', false]]);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
await test('release on the catch path: clone failure after acquire => FAILED, release failed', async () => {
  const fixture = new WorkerTestFixture('lease-catch');
  const governor = new FakeGovernor({ ttlS: 60 });
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
  const governor = new FakeGovernor({ ttlS: 60 });
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
  const governor2 = new FakeGovernor({ ttlS: 60 });
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
  const governor = new FakeGovernor({ ttlS: 60, releaseStatus: 500 });
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
  assert.equal(declaration.controlLevel, 'inventoried', 'activityStream=false caps the derived rung at inventoried');
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
  const governor = new FakeGovernor({ ttlS: 60, check: (_body, index) => (index < 2 ? { valid: true, reason: 'ok' } : { valid: false, reason: 'revoked' }) });
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
    assert.equal(snapshot.outcome.reason, 'fenced_out:revoked');
    assert.equal(snapshot.fenced_out, 'fenced_out:revoked');
    assert.equal(snapshot.evidence_error, 'fenced_out:revoked');
    assert.equal(snapshot.evidence_result_state, 'COMPLETED', 'result.json was uploaded as the intended COMPLETED; the downgrade is recorded');
    assert.deepEqual(snapshot.lease.checks.map((c) => [c.effect, c.valid, c.reason]), [['push', true, 'ok'], ['pr', true, 'ok'], ['evidence', false, 'revoked']]);
    assert(originHasBranch(join(fixture.reposDir, 'test', 'repo.git'), 'worker/114'), 'push happened under a valid fence');
    assert(ghCalls(fixture).some((c) => c.argv.includes('create')), 'PR happened under a valid fence');
    assert.equal(fixture.getEvidencePosts().length, 0, 'the fenced evidence POST never reaches the ledger');
    assert.deepEqual(governor.releases, [{ lease_id: 'lease-1', fencing_generation: 100, outcome: 'abandoned' }]);
    const blocker = fixture.getPostedMessages().find((p) => p.kind === 'blocker');
    assert(blocker, 'a blocker must be posted');
    assert.equal(blocker.subject, 'task 114 blocked');
    assert.match(blocker.body, /^state=BLOCKED .*evidence_error=fenced_out:revoked .*reason=fenced_out:revoked/, blocker.body);
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
    const blocker = fixture.getPostedMessages().find((p) => p.kind === 'blocker');
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
  const governor = new FakeGovernor({ ttlS: 1, renewDelayMs: 2500 });
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
  const governor = new FakeGovernor({ ttlS: 0.3 });
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
  const governor = new FakeGovernor({ ttlS: 1 });
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
    assert.equal(fixture.getPostedMessages().some((p) => p.kind === 'blocker'), false);
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
    const create = ghCalls(fixture).find((c) => c.argv.includes('create'));
    assert.equal(create.argv[create.argv.indexOf('--body') + 1], 'Unattended Vinci worker result for task 113.');
  } finally {
    await fixture.cleanup();
  }
});

console.log(`\nWorker lease loop tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
