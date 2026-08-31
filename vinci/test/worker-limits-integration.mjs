// Test: max_runtime_s kills, budget kills, deadline blocks
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

function state(fixture, taskId) {
  return JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', `${taskId}.json`), 'utf8'));
}

const test = async () => {
  // Test max_runtime_s
  let fixture = new WorkerTestFixture('limits-runtime');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: '3',
      kind: 'handoff',
      to_agent: 'worker:w3',
      subject: 'runtime task',
      body: 'repo: test/repo\nmax_runtime_s: 0.05\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w3', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '3000', VINCI_WORKER_KILL_GRACE_MS: '25' }), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });
    assert.equal(state(fixture, '3').state, 'FAILED');
    assert.equal(state(fixture, '3').limit_tripped, 'max_runtime_s');
  } finally {
    await fixture.cleanup();
  }

  fixture = new WorkerTestFixture('limits-budget');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      message_id: '8',
      kind: 'handoff',
      to_agent: 'worker:w8',
      subject: 'budget task',
      body: 'repo: test/repo\nbudget_usd: 1\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);
    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w8', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], {
      env: fixture.getEnv({
        FAKE_VINCI_SLEEP: '3000',
        FAKE_VINCI_USAGE: '1',
        VINCI_WORKER_LIMIT_POLL_MS: '25',
        VINCI_WORKER_KILL_GRACE_MS: '25',
      }),
      stdio: 'pipe',
    });
    await new Promise(r => { proc.on('close', r); });
    assert.equal(state(fixture, '8').state, 'FAILED');
    assert.equal(state(fixture, '8').limit_tripped, 'budget_usd');
  } finally {
    await fixture.cleanup();
  }

  // Test deadline
  fixture = new WorkerTestFixture('limits-deadline');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    const pastDeadline = new Date(Date.now() - 1000).toISOString();
    await fixture.startBus([{
      message_id: '4',
      kind: 'handoff',
      to_agent: 'worker:w4',
      subject: 'deadline task',
      body: `repo: test/repo\ndeadline: ${pastDeadline}\n\nTask`,
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w4', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });

    const posts = fixture.getPostedMessages();
    const blockerPost = posts.find(
      p => p.kind === 'status' && ['FAILED', 'BLOCKED', 'REFUSED'].includes(p.outcome),
    );
    assert(blockerPost, 'should post blocker for past deadline');
    assert.equal(fixture.getVinciCalls().length, 0, 'past deadline must not invoke vinci');
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-limits');
} catch (err) {
  console.error(`✗ worker-limits: ${err.message}`);
  process.exit(1);
}
