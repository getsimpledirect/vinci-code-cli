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
      message_id: '5',
      kind: 'handoff',
      to_agent: 'w5',
      subject: 'evidence task',
      body: 'repo: test/repo\nevidence: pr\nref: handoff:5\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }]);

    const proc = spawn('node', [
      join(ROOT, 'vinci/worker/worker.mjs'),
      'start', '--id', 'w5', '--server', fixture.busUrl(),
      '--once', '--state-dir', fixture.tempDir
    ], { env: fixture.getEnv({ FAKE_VINCI_OUTCOME: 'DONE' }), stdio: 'pipe' });

    const code = await new Promise(r => { proc.on('close', r); });
    assert.equal(code, 0);
    assert.equal(fixture.rejectedPosts.length, 0, 'worker must not send refs rejected by the bus');
    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'status');
    assert.equal(final.refs, undefined);
    assert.match(final.body, /pr=https:\/\/github\.com\/test\/repo\/pull\/123/);
    assert.match(final.body, /head=[0-9a-f]{40}/);
  } finally {
    await fixture.cleanup();
  }
};

try {
  await test();
  console.log('✓ worker-evidence');
} catch (err) {
  console.error(`✗ worker-evidence: ${err.message}`);
  process.exit(1);
}
