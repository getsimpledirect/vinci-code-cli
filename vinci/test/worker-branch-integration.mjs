// Test: custom branch checkout
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('branch');
  try {
    fixture.createRepo('test', 'repo', { withWorkerOld: true });
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      id: 7,
      kind: 'handoff',
      to: 'worker:w7',
      body: 'repo: test/repo\nbranch: worker/old\n\nTask'
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w7', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', code => code === 0 ? r() : r()); });
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-branch');
} catch (err) {
  console.error(`✗ worker-branch: ${err.message}`);
  process.exit(1);
}
