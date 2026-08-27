// Test: worker session JSONL is stored in state-dir, not inside the cloned repo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('session-location');
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo('test', 'repo');
    await fixture.startBus([{
      message_id: '8',
      kind: 'handoff',
      to_agent: 'worker:w8',
      subject: 'session location task',
      body: 'repo: test/repo\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w8', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    const code = await new Promise(r => { proc.on('close', r); });
    assert.equal(code, 0);

    // Sessions must NOT be written into the cloned repo tree.
    const repoDir = join(fixture.tempDir, 'repos', 'repo');
    assert.equal(
      existsSync(join(repoDir, 'sessions')),
      false,
      'sessions/ must not exist inside the cloned repo',
    );

    // Sessions must be written under <state-dir>/sessions/<task-id>/.
    const sessionRoot = join(fixture.tempDir, 'sessions', '8');
    assert.equal(existsSync(sessionRoot), true, `expected session dir under state-dir: ${sessionRoot}`);
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-session-location');
} catch (err) {
  console.error(`✗ worker-session-location: ${err.message}`);
  process.exit(1);
}
