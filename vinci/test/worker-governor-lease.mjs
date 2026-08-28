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

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
};

// Test TaskLifecycle has lease field in initial state
test('TaskLifecycle initial state has lease field', () => {
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
test('TaskLifecycle initial state has evidence_error field', () => {
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
test('TaskLifecycle persists lease field', () => {
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
test('TaskLifecycle persists evidence_error field', () => {
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
test('claimGovernorPaths returns null when no url', async () => {
  const result = await claimGovernorPaths({
    governorUrl: null,
    token: 'test-token',
    paths: ['.'],
    taskId: 'task1',
    attempt: 1,
  });
  assert.equal(result, null);
});

console.log(`\nWorker Governor lease tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
