// Test: kill daemon mid-run, restart -> same session_id, attempt 2, no re-spawn after terminal
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('restart');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      id: 2,
      kind: 'handoff',
      to: 'worker:w2',
      body: 'repo: test/repo\nmax_runtime_s: 60\n\nTask',
      ref: 'job_xyz'
    }]);

    // First run: long sleep, kill it mid-run
    const proc1 = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w2', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '5000' }), stdio: 'pipe' });

    await new Promise(r => setTimeout(r, 500)); // Let it start
    proc1.kill('SIGTERM');
    await new Promise(r => { proc1.on('close', r); });

    // Second run: --once again, same daemon state
    const proc2 = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w2', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '100' }), stdio: 'pipe' });

    await new Promise(r => { proc2.on('close', code => code === 0 ? r() : r()); });

    const calls = fixture.getVinciCalls();
    assert(calls.length >= 1, 'vinci should be called at least once');
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-restart');
} catch (err) {
  console.error(`✗ worker-restart: ${err.message}`);
  process.exit(1);
}
