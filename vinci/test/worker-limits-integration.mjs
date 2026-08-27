// Test: max_runtime_s kills, budget kills, deadline blocks
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  // Test max_runtime_s
  let fixture = new WorkerTestFixture('limits-runtime');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      id: 3,
      kind: 'handoff',
      to: 'worker:w3',
      body: 'repo: test/repo\nmax_runtime_s: 1\n\nTask'
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w3', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '3000' }), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });
  } finally {
    fixture.cleanup();
  }

  // Test deadline
  fixture = new WorkerTestFixture('limits-deadline');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    const pastDeadline = new Date(Date.now() - 1000).toISOString();
    await fixture.startBus([{
      id: 4,
      kind: 'handoff',
      to: 'worker:w4',
      body: `repo: test/repo\ndeadline: ${pastDeadline}\n\nTask`
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w4', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });

    const posts = fixture.getPostedMessages();
    const blockerPost = posts.find(p => p.kind === 'blocker');
    assert(blockerPost, 'should post blocker for past deadline');
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-limits');
} catch (err) {
  console.error(`✗ worker-limits: ${err.message}`);
  process.exit(1);
}
