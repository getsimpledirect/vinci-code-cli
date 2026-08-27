// Test: kill daemon mid-run, restart -> same session_id, attempt 2, no re-spawn after terminal
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
      message_id: '2',
      kind: 'handoff',
      to_agent: 'w2',
      subject: 'restart task',
      body: 'repo: test/repo\nmax_runtime_s: 60\nref: job_xyz\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    // First run: long sleep, kill it mid-run
    const proc1 = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w2', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '5000' }), stdio: 'pipe' });

    while (fixture.getVinciCalls().length === 0) await new Promise(r => setTimeout(r, 25));
    const firstState = JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', '2.json'), 'utf8'));
    proc1.kill('SIGTERM');
    await new Promise(r => { proc1.on('close', r); });

    // Second run: --once again, same daemon state
    const proc2 = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w2', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_SLEEP: '100' }), stdio: 'pipe' });

    const secondCode = await new Promise(r => { proc2.on('close', r); });
    assert.equal(secondCode, 0);

    const secondState = JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', '2.json'), 'utf8'));
    assert.equal(secondState.attempt, 2);
    assert.equal(secondState.session_id, firstState.session_id);
    assert.equal(secondState.state, 'COMPLETED');
    assert.equal(
      fixture.getPostedMessages().filter((post) => post.subject === 'task 2 claimed').length,
      1,
      'restart must not post a duplicate claim',
    );

    const callsAfterSecondStart = fixture.getVinciCalls().length;
    assert.equal(callsAfterSecondStart, 2);

    const proc3 = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w2', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });
    const thirdCode = await new Promise(r => { proc3.on('close', r); });
    assert.equal(thirdCode, 0);
    assert.equal(fixture.getVinciCalls().length, callsAfterSecondStart, 'terminal task must not invoke vinci again');
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-restart');
} catch (err) {
  console.error(`✗ worker-restart: ${err.message}`);
  process.exit(1);
}
