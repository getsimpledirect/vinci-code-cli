// Focused behavioral test for the evidence upload credential and bus-contract decision matrix.
//
// uploadEvidence must never touch the bus (and thus never use busToken/busUrl) when uriPrefix is
// absent. When uriPrefix is present and the upload succeeds, evidence metadata goes to POST
// /v1/evidence (never /v1/messages) with the same Bearer credential. Ledger refs (job_/exp_/bk_)
// become the evidence body's refs; non-ledger refs skip the bus entirely (the server would 422).
import assert from 'node:assert/strict';
import { uploadEvidence } from '../worker/evidence.mjs';

const BUS_TOKEN = 'bus-token-credential';
let posted = null;

const bus = {
  serverUrl: 'http://127.0.0.1:9999',
  token: BUS_TOKEN,
};

// Stub fetch to capture what the evidence upload would transmit.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  posted = {
    url: String(url),
    method: options?.method ?? 'GET',
    auth: options?.headers?.['Authorization'] ?? options?.headers?.authorization,
    body: options?.body ? JSON.parse(options.body) : null,
  };
  return { ok: true, status: 200, text: async () => '' };
};

let passed = 0;
let failed = 0;
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

try {
  await test('returns null and never posts to the bus when uriPrefix is absent', async () => {
    posted = null;
    const result = await uploadEvidence({
      sessionJsonl: 's',
      gitDiff: 'd',
      resultJson: { state: 'COMPLETED' },
      logTail: 'log',
      taskId: 't1',
      busUrl: bus.serverUrl,
      busToken: bus.token,
      ref: 'job_1',
    });
    assert.equal(result, null, 'no uriPrefix must short-circuit to null');
    assert.equal(posted, null, 'bus must not be contacted without uriPrefix');
  });

  // Deterministic: a fake `aws` first on PATH decides the upload outcome; the real one on a
  // developer machine must never make this test flap.
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const binDir = mkdtempSync(join(tmpdir(), 'fake-aws-'));
  const realPath = process.env.PATH;
  function fakeAws(exitCode) {
    writeFileSync(join(binDir, 'aws'), `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(join(binDir, 'aws'), 0o755);
    process.env.PATH = `${binDir}:${realPath}`;
  }

  await test('upload failure: no bus POST, result reports failure', async () => {
    fakeAws(1); posted = null;
    const result = await uploadEvidence({
      sessionJsonl: 's', gitDiff: 'd', resultJson: { state: 'COMPLETED' }, logTail: 'log',
      uriPrefix: 's3://bucket/evidence/', taskId: 't1', busUrl: bus.serverUrl, busToken: bus.token, ref: 'job_abc',
    });
    assert.equal(result.success, false, 'aws exit 1 must be reported as failure');
    assert.equal(posted, null, 'a failed upload must not be recorded on the bus');
  });

  await test('upload success with a ledger ref: POST /v1/evidence reuses the Bearer credential', async () => {
    fakeAws(0); posted = null;
    const result = await uploadEvidence({
      sessionJsonl: 's', gitDiff: 'd', resultJson: { state: 'COMPLETED' }, logTail: 'log',
      uriPrefix: 's3://bucket/evidence/', taskId: 't1', busUrl: bus.serverUrl, busToken: bus.token, ref: 'job_abc',
    });
    assert.equal(result.success, true);
    assert.ok(posted, 'successful upload with a ledger ref must record evidence on the bus');
    assert.equal(posted.method, 'POST');
    assert.equal(posted.url, `${bus.serverUrl}/v1/evidence`, 'evidence must go to /v1/evidence, not /v1/messages');
    assert.equal(String(posted.auth).toLowerCase(), `bearer ${BUS_TOKEN}`, 'evidence POST must reuse the worker bus token');
    assert.equal(posted.body.job_ref, "job_abc");
    assert.equal(posted.body.uri, result.uri, 'body uri must match the returned uri');
    assert.equal(posted.body.sha256, result.sha256, 'body sha256 must match the returned sha256');
    assert.match(posted.body.uri, /^s3:\/\/bucket\/evidence\/t1\/[0-9a-f]{64}\.tgz$/);
    assert.equal(typeof posted.body.bytes, 'number');
    assert.equal(typeof posted.body.produced_at, 'string');
    assert.equal(posted.body.refs, undefined, 'evidence attests via job_ref; no message-style refs');
  });

  await test('upload success with a NON-ledger ref: no bus POST (the server would 422)', async () => {
    fakeAws(0); posted = null;
    const result = await uploadEvidence({
      sessionJsonl: 's', gitDiff: 'd', resultJson: { state: 'COMPLETED' }, logTail: 'log',
      uriPrefix: 's3://bucket/evidence/', taskId: 't1', busUrl: bus.serverUrl, busToken: bus.token, ref: 'handoff:1',
    });
    assert.equal(result.success, true);
    assert.equal(posted, null, 'non-ledger ref must not be posted as evidence');
  });

  await test('upload success with no ref: no bus POST', async () => {
    fakeAws(0); posted = null;
    const result = await uploadEvidence({
      sessionJsonl: 's', gitDiff: 'd', resultJson: { state: 'COMPLETED' }, logTail: 'log',
      uriPrefix: 's3://bucket/evidence/', taskId: 't1', busUrl: bus.serverUrl, busToken: bus.token,
    });
    assert.equal(result.success, true);
    assert.equal(posted, null, 'missing ref must skip the bus post');
  });
  process.env.PATH = realPath;
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nWorker evidence credential tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
