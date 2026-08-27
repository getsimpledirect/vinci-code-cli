// Stage 1 leaves dependency setup to the unattended task; the worker must not run npm implicitly.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('deps');
  try {
    fixture.linkTools(TOOLS);
    const npmRecord = join(fixture.tempDir, 'npm-calls.txt');
    writeFileSync(npmRecord, '');

    await fixture.startBus([{
      id: 6,
      kind: 'handoff',
      to: 'worker:w6',
      body: 'repo: test/repo\n\nTask'
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w6', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_NPM_RECORD: npmRecord }), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });
    assert.equal(existsSync(npmRecord) ? readFileSync(npmRecord, 'utf8') : '', '');
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-deps-are-task-owned');
} catch (err) {
  console.error(`✗ worker-deps: ${err.message}`);
  process.exit(1);
}
