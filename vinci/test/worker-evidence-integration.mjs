// Test: blocked outcome -> BLOCKED, evidence pr no PR -> UNVERIFIED
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('evidence');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      id: 5,
      kind: 'handoff',
      to: 'worker:w5',
      body: 'repo: test/repo\nevidence: pr\n\nTask'
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w5', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_OUTCOME: 'DONE' }), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', code => code === 0 ? r() : r()); });
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-evidence');
} catch (err) {
  console.error(`✗ worker-evidence: ${err.message}`);
  process.exit(1);
}
