// Test: npm ci detection and execution
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname, writeFileSync } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('deps');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    
    // Add package-lock.json to the repo (will be cloned)
    const { origin } = fixture.createRepo('test', 'repo-with-deps');
    const tempClone = join(fixture.tempDir, 'temp-with-deps');
    require('child_process').spawnSync('git', ['clone', origin, tempClone], { stdio: 'pipe' });
    writeFileSync(join(tempClone, 'package-lock.json'), '{}');
    require('child_process').spawnSync('git', ['-C', tempClone, 'add', 'package-lock.json'], { stdio: 'pipe' });
    require('child_process').spawnSync('git', ['-C', tempClone, 'commit', '-m', 'add lock'], { stdio: 'pipe' });
    require('child_process').spawnSync('git', ['-C', tempClone, 'push'], { stdio: 'pipe' });
    require('child_process').spawnSync('rm', ['-rf', tempClone], { stdio: 'pipe' });

    await fixture.startBus([{
      id: 6,
      kind: 'handoff',
      to: 'worker:w6',
      body: 'repo: test/repo-with-deps\n\nTask'
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w6', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv(), stdio: 'pipe' });

    await new Promise(r => { proc.on('close', r); });
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-deps');
} catch (err) {
  console.error(`✗ worker-deps: ${err.message}`);
  process.exit(1);
}
