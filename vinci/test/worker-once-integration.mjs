import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

const test = async () => {
  const fixture = new WorkerTestFixture('once');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await fixture.startBus([{
      id: 1,
      kind: 'handoff',
      to: 'worker:w1',
      body: 'repo: test/repo\nevidence: pr\n\nFix bug',
      ref: 'job_abc'
    }]);

    const env = fixture.getEnv();
    
    // Verify fake vinci is first on PATH
    const whichResult = spawnSync('bash', ['-c', 'which vinci'], { env, encoding: 'utf8' });
    const vinciPath = whichResult.stdout.trim();
    assert(vinciPath.includes('tools'), `vinci should be from tools dir, got: ${vinciPath}`);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w1', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env, stdio: 'pipe' });

    await new Promise((r, j) => {
      proc.on('close', code => code === 0 ? r() : j(new Error(`exit ${code}`)));
    });

    const calls = fixture.getVinciCalls();
    assert(calls.length >= 1, `vinci not invoked (got ${calls.length} calls)`);

    const posts = fixture.getPostedMessages();
    assert.equal(posts.length, 2, `expected 2 posts, got ${posts.length}`);
  } finally {
    fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-once');
} catch (err) {
  console.error(`✗ worker-once: ${err.message}`);
  process.exit(1);
}
