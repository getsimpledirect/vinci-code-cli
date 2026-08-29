// Worker Governor lease tests
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLifecycle } from '../worker/task.mjs';
import { claimGovernorPaths } from '../worker/governor.mjs';

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

// Test TaskLifecycle has lease field in initial state
await test('TaskLifecycle initial state has lease field', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  try {
    const lifecycle = new TaskLifecycle(tempDir, 'task1');
    const initial = lifecycle.snapshot();
    assert('lease' in initial, 'lease field missing from initial state');
    assert.equal(initial.lease, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test TaskLifecycle has evidence_error field in initial state
await test('TaskLifecycle initial state has evidence_error field', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  try {
    const lifecycle = new TaskLifecycle(tempDir, 'task2');
    const initial = lifecycle.snapshot();
    assert('evidence_error' in initial, 'evidence_error field missing from initial state');
    assert.equal(initial.evidence_error, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test TaskLifecycle stores and persists lease
await test('TaskLifecycle persists lease field', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  try {
    const lifecycle = new TaskLifecycle(tempDir, 'task3');
    lifecycle.startAttempt({ id: 'task3', envelope: { evidence: 'pr', provider: 'openrouter', model: 'glm' } }, '1.0');
    const leaseData = {
      claimed_at: new Date().toISOString(),
      paths: ['.', 'src/'],
      ttl: 3600,
    };
    lifecycle.record({ lease: leaseData });
    const state = lifecycle.snapshot();
    assert.deepEqual(state.lease.paths, ['.', 'src/']);
    assert.equal(state.lease.ttl, 3600);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test TaskLifecycle stores and persists evidence_error
await test('TaskLifecycle persists evidence_error field', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
  try {
    const lifecycle = new TaskLifecycle(tempDir, 'task4');
    lifecycle.startAttempt({ id: 'task4', envelope: { evidence: 'pr', provider: 'openrouter', model: 'glm' } }, '1.0');
    lifecycle.transition('RUNNING');
    lifecycle.transition('UNVERIFIED', {
      evidence_error: 'S3 upload failed: 403 Access Denied',
    });
    const state = lifecycle.snapshot();
    assert.equal(state.evidence_error, 'S3 upload failed: 403 Access Denied');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Test claimGovernorPaths returns null when no url
await test('claimGovernorPaths returns null when no url', async () => {
  const result = await claimGovernorPaths({
    governorUrl: null,
    token: 'test-token',
    paths: ['.'],
    attemptId: 'task1/1',
  });
  assert.equal(result, null);
});

// BLOCK-A: the claim carries attempt_id, and refuses to go out without one. The Governor's holder
// gate refuses a claim whose attempt_id is not the lease holder's — an ABSENT one included — so a
// missing attempt_id must fail closed here rather than be sent and refused for every governed task.
await test('claimGovernorPaths fails closed when attemptId is missing', async () => {
  let called = false;
  const fetched = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  try {
    for (const attemptId of [undefined, null, '', 0, 7]) {
      const result = await claimGovernorPaths({ governorUrl: 'http://governor.invalid', token: 't', paths: ['.'], attemptId });
      assert.equal(result.success, false, `attemptId ${JSON.stringify(attemptId)} must not claim`);
      assert.equal(result.blocked, true);
      assert.equal(result.error, true, 'a missing attempt_id is a client failure, not a Governor decision');
      assert.match(result.reason, /^claim attempt_id is missing/);
    }
    assert.equal(called, false, 'nothing may be sent without an attempt_id');
  } finally {
    globalThis.fetch = fetched;
  }
});

// BLOCK-A: the body and the idempotency key both carry the caller's attempt_id, verbatim.
await test('claimGovernorPaths sends attempt_id in the body and as the idempotency key', async () => {
  const fetched = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ paths: ['.'], ttl: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await claimGovernorPaths({ governorUrl: 'http://governor.invalid', token: 'gov-token', paths: ['src/'], attemptId: 'task-9/3' });
    assert.equal(result.success, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].body, { paths: ['src/'], attempt_id: 'task-9/3' });
    assert.equal(seen[0].headers['Idempotency-Key'], 'task-9/3');
  } finally {
    globalThis.fetch = fetched;
  }
});

console.log(`\nWorker Governor lease tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
