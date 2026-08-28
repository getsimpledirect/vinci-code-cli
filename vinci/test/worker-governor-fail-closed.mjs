// W0.1 fail-closed Governor: with a Governor URL configured, ONLY a granted lease lets a task
// clone or spawn. Everything else BLOCKS. Plus: lease ttl caps max_runtime_s; --require-governor
// refuses to start without --governor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');
const WORKER = join(ROOT, 'vinci/worker/worker.mjs');

let passed = 0;
let failed = 0;

function state(fixture, taskId) {
  return JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', `${taskId}.json`), 'utf8'));
}

function handoff(id, workerId, body) {
  return {
    message_id: id,
    kind: 'handoff',
    to_agent: `worker:${workerId}`,
    subject: 'governor task',
    body,
    ts: '2026-08-26T10:00:00Z',
    posted_by: 'scheduler',
  };
}

// A fake Governor whose /v1/governor/claim-paths answer is scripted per test. `respond` gets
// (request, response) and must end the response; every hit is recorded.
async function startGovernor(respond) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    respond(request, response);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

function runWorker(fixture, workerId, extraArgs, envOverrides, { stripGovernorToken = false } = {}) {
  const env = fixture.getEnv(envOverrides);
  if (stripGovernorToken) delete env.VINCI_GOVERNOR_TOKEN;
  const proc = spawn('node', [WORKER, 'start', '--id', workerId, '--server', fixture.busUrl(), '--once', '--state-dir', fixture.tempDir, ...extraArgs], {
    env,
    stdio: 'pipe',
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((r) => proc.on('close', (code) => r({ code, stderr })));
}

function assertBlockedBeforeWork(fixture, taskId, reasonPattern) {
  const snapshot = state(fixture, taskId);
  assert.equal(snapshot.state, 'BLOCKED', `expected BLOCKED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
  assert.equal(snapshot.terminal, true);
  assert.match(snapshot.outcome?.reason ?? '', reasonPattern);
  assert.equal(snapshot.lease, null, 'no lease may be recorded on a blocked task');
  assert.equal(fixture.getVinciCalls().length, 0, 'model must not be spawned');
  assert.equal(existsSync(join(fixture.tempDir, 'repos')), false, 'repository must not be cloned');
  const blocker = fixture.getPostedMessages().find((p) => p.kind === 'blocker');
  assert(blocker, 'a blocker must be posted');
  assert.match(blocker.body ?? JSON.stringify(blocker), reasonPattern);
  return snapshot;
}

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
};

// T1: Governor URL configured, token missing => BLOCKED before clone/spawn, Governor never called.
await test('T1 governor url without token blocks before any work', async () => {
  const fixture = new WorkerTestFixture('gov-no-token');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ paths: ['.'], ttl: 3600 }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('11', 'w1', 'repo: test/repo\nevidence: none\n\nTask')]);
    const { code } = await runWorker(fixture, 'w1', ['--governor', governor.url], {}, { stripGovernorToken: true });
    assert.equal(code, 0, 'daemon itself exits cleanly after blocking the task');
    assertBlockedBeforeWork(fixture, '11', /governor token missing \(VINCI_GOVERNOR_TOKEN\)/);
    assert.equal(governor.hits.length, 0, 'Governor must not be contacted without a token');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T2a: Governor answers 500 => BLOCKED, no spawn.
await test('T2a governor 500 blocks', async () => {
  const fixture = new WorkerTestFixture('gov-500');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reason: 'listener exploded' }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('12', 'w2', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w2', ['--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assertBlockedBeforeWork(fixture, '12', /unexpected status 500/);
    assert.equal(governor.hits.length, 1);
    assert.equal(governor.hits[0].auth, 'Session gov-token');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T2b: Governor unreachable (connection refused) => BLOCKED, no spawn.
await test('T2b governor connection refused blocks', async () => {
  const fixture = new WorkerTestFixture('gov-refused');
  // Grab a free port and release it so nothing listens there.
  const probe = await startGovernor(() => {});
  const deadUrl = probe.url;
  await probe.close();
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('13', 'w3', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w3', ['--governor', deadUrl], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assertBlockedBeforeWork(fixture, '13', /Governor connection failed: (ECONNREFUSED|fetch failed)/);
  } finally {
    await fixture.cleanup();
  }
});

// T2c: Governor returns 200 with a non-JSON body => BLOCKED, no spawn.
await test('T2c governor non-JSON body blocks', async () => {
  const fixture = new WorkerTestFixture('gov-nonjson');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html>proxy login page</html>');
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('14', 'w4', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w4', ['--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assertBlockedBeforeWork(fixture, '14', /Governor returned invalid JSON \(status 200\)/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T2d: an explicit refusal (409) still blocks with the Governor's own rule text.
await test('T2d governor 409 refusal blocks with rule text', async () => {
  const fixture = new WorkerTestFixture('gov-409');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reason: 'path already leased to worker:other' }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('15', 'w5', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w5', ['--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assertBlockedBeforeWork(fixture, '15', /path already leased to worker:other/);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T3: lease ttl 60 with the envelope default max_runtime_s 14400 => effective limit 60, recorded.
await test('T3 lease ttl caps max_runtime_s and is recorded in the snapshot', async () => {
  const fixture = new WorkerTestFixture('gov-ttl');
  let claimBody = null;
  const governor = await startGovernor((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      claimBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ paths: ['.'], ttl: 60 }));
    });
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('16', 'w6', 'repo: test/repo\nevidence: none\n\nTask')]);
    const { code } = await runWorker(fixture, 'w6', ['--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assert.equal(code, 0);
    const snapshot = state(fixture, '16');
    assert.equal(snapshot.state, 'COMPLETED', `expected COMPLETED, got ${snapshot.state} (${JSON.stringify(snapshot.outcome)})`);
    assert.equal(snapshot.lease.ttl, 60);
    assert.equal(snapshot.lease.effective_max_runtime_s, 60, 'effective limit must be min(14400, ttl 60)');
    assert.deepEqual(claimBody, { paths: ['.'] });
    assert.equal(fixture.getVinciCalls().length, 1, 'a granted lease runs the task exactly once');
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T3b: a lease ttl LARGER than the envelope never loosens the limit.
await test('T3b lease ttl larger than envelope keeps the envelope limit', async () => {
  const fixture = new WorkerTestFixture('gov-ttl-large');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ paths: ['.'], ttl: 99999 }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('17', 'w7', 'repo: test/repo\nevidence: none\nmax_runtime_s: 120\n\nTask')]);
    await runWorker(fixture, 'w7', ['--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    const snapshot = state(fixture, '17');
    assert.equal(snapshot.lease.ttl, 99999);
    assert.equal(snapshot.lease.effective_max_runtime_s, 120);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T3c: the ttl is ENFORCED, not merely recorded: a run longer than its lease is killed as a
// max_runtime_s trip even though the envelope allowed 14400s.
await test('T3c a run that outlives its lease ttl is killed', async () => {
  const fixture = new WorkerTestFixture('gov-ttl-kill');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ paths: ['.'], ttl: 0.05 }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('20', 'w7', 'repo: test/repo\nevidence: none\n\nTask')]);
    await runWorker(fixture, 'w7', ['--governor', governor.url], {
      VINCI_GOVERNOR_TOKEN: 'gov-token',
      FAKE_VINCI_SLEEP: '3000',
      VINCI_WORKER_KILL_GRACE_MS: '25',
    });
    const snapshot = state(fixture, '20');
    assert.equal(snapshot.state, 'FAILED', `expected FAILED, got ${snapshot.state}`);
    assert.equal(snapshot.limit_tripped, 'max_runtime_s');
    assert.equal(snapshot.lease.effective_max_runtime_s, 0.05);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

// T4: --require-governor without --governor => exit 78 before any poll.
await test('T4 --require-governor without --governor exits 78 before polling', async () => {
  const fixture = new WorkerTestFixture('gov-required-flag');
  try {
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('18', 'w8', 'repo: test/repo\nevidence: none\n\nTask')]);
    const { code, stderr } = await runWorker(fixture, 'w8', ['--require-governor'], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assert.equal(code, 78, `expected exit 78, got ${code}: ${stderr}`);
    assert.match(stderr, /Governor is required .* no --governor/);
    assert.equal(fixture.getRequests.length, 0, 'must not poll the bus');
    assert.equal(fixture.getPostedMessages().length, 0);
    assert.equal(existsSync(join(fixture.tempDir, 'daemon.lock')), false, 'must refuse before taking the daemon lock');
  } finally {
    await fixture.cleanup();
  }
});

// T4b: same via VINCI_WORKER_REQUIRE_GOVERNOR=1.
await test('T4b VINCI_WORKER_REQUIRE_GOVERNOR=1 without --governor exits 78', async () => {
  const fixture = new WorkerTestFixture('gov-required-env');
  try {
    fixture.linkTools(TOOLS);
    await fixture.startBus([]);
    const { code } = await runWorker(fixture, 'w8', [], { VINCI_WORKER_REQUIRE_GOVERNOR: '1' });
    assert.equal(code, 78);
    assert.equal(fixture.getRequests.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

// T4c: --require-governor WITH --governor starts normally (the requirement is satisfied).
await test('T4c --require-governor with --governor starts and governs', async () => {
  const fixture = new WorkerTestFixture('gov-required-ok');
  const governor = await startGovernor((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ paths: ['.'], ttl: 3600 }));
  });
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([handoff('19', 'w8', 'repo: test/repo\nevidence: none\n\nTask')]);
    const { code } = await runWorker(fixture, 'w8', ['--require-governor', '--governor', governor.url], { VINCI_GOVERNOR_TOKEN: 'gov-token' });
    assert.equal(code, 0);
    assert.equal(state(fixture, '19').state, 'COMPLETED');
    assert.equal(governor.hits.length, 1);
  } finally {
    await governor.close();
    await fixture.cleanup();
  }
});

console.log(`\nWorker Governor fail-closed tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
