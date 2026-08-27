// Test: worker branch is created from origin/main without destructive -B.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('branch');
  try {
    fixture.linkTools(TOOLS);
    fixture.createRepo('test', 'repo');
    await fixture.startBus([{
      message_id: '7',
      kind: 'handoff',
      to_agent: 'w7',
      subject: 'branch task',
      body: 'repo: test/repo\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w7', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    const code = await new Promise(r => { proc.on('close', r); });
    assert.equal(code, 0);
    const repoDir = join(fixture.tempDir, 'repos', 'repo');
    const branch = spawnSync('git', ['-C', repoDir, 'branch', '--show-current'], { encoding: 'utf8' });
    assert.equal(branch.status, 0, branch.stderr);
    assert.equal(branch.stdout.trim(), 'worker/7');
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-branch');
} catch (err) {
  console.error(`✗ worker-branch: ${err.message}`);
  process.exit(1);
}
