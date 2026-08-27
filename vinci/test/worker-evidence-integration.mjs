// Test: evidence final body carries uri/sha256; ledger ref posts evidence to the bus.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerTestFixture } from './lib/worker-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = join(ROOT, 'vinci/test/fixtures/worker-test-tools');

async function runOnce(fixture, handoffs, envOverrides = {}) {
  await fixture.startBus(handoffs);
  const proc = spawn('node', [
    join(ROOT, 'vinci/worker/worker.mjs'),
    'start', '--id', 'w5', '--server', fixture.busUrl(),
    '--once', '--state-dir', fixture.tempDir
  ], { env: fixture.getEnv(envOverrides), stdio: 'pipe' });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise(r => { proc.on('close', r); });
  if (code !== 0) { console.error(stderr); }
  assert.equal(code, 0);
}

const testRun = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  \u00d7 ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

await testRun('evidence uri+sha256 appear in the final body when the upload is configured', async () => {
  const fixture = new WorkerTestFixture('evidence-final');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [{
      message_id: '5',
      kind: 'handoff',
      to_agent: 'worker:w5',
      subject: 'evidence task',
      body: 'repo: test/repo\nevidence: pr\nref: handoff:5\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }], { FAKE_VINCI_OUTCOME: 'DONE', VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/' });

    assert.equal(fixture.rejectedPosts.length, 0, 'worker must not send refs rejected by the bus');
    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'status');
    assert.equal(final.refs, undefined);
    assert.match(final.body, /pr=https:\/\/github\.com\/test\/repo\/pull\/123/);
    assert.match(final.body, /head=[0-9a-f]{40}/);
    // The upload succeeded but the ref is a non-ledger ref: bus must see no evidence POST,
    // yet uri + sha256 must be in the final status body.
    assert.equal(fixture.getEvidencePosts().length, 0, 'non-ledger ref must skip the evidence bus POST');
    assert.match(final.body, / evidence_uri=s3:\/\/bucket\/vinci-evidence\/5\/[0-9a-f]{64}\.tgz/);
    assert.match(final.body, / evidence_sha256=[0-9a-f]{64}/);
  } finally {
    await fixture.cleanup();
  }
});

await testRun('ledger ref records the evidence POST before the final finding', async () => {
  const fixture = new WorkerTestFixture('evidence-ledger');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [{
      message_id: '5',
      kind: 'handoff',
      to_agent: 'worker:w5',
      subject: 'evidence task',
      body: 'repo: test/repo\nevidence: pr\nref: job_5\n\nTask',
      ts: '2026-08-26T10:00:00Z',
      posted_by: 'scheduler',
    }], { FAKE_VINCI_OUTCOME: 'DONE', VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/' });

    assert.equal(fixture.rejectedPosts.length, 0);
    const evidencePosts = fixture.getEvidencePosts();
    assert.equal(evidencePosts.length, 1, 'ledger ref must post evidence metadata to /v1/evidence');
    assert.equal(evidencePosts[0].kind, 'bundle');
    assert.equal(evidencePosts[0].job_ref, 'job_5');
    assert.equal(evidencePosts[0].refs, undefined, 'evidence attests via job_ref, not message refs');
    assert.match(evidencePosts[0].uri, /^s3:\/\/bucket\/vinci-evidence\/5\/[0-9a-f]{64}\.tgz$/);

    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'finding', 'COMPLETED with ledger ref must post a finding');
    assert.deepEqual(final.refs, ['job_5']);
    assert.match(final.body, / evidence_uri=s3:\/\/bucket\/vinci-evidence\/5\/[0-9a-f]{64}\.tgz/);
    assert.match(final.body, / evidence_sha256=[0-9a-f]{64}/, 'final body must carry evidence uri+sha256 even on success');
    assert.doesNotMatch(final.body, /evidence_error/, 'successful upload must not report evidence_error');
  } finally {
    await fixture.cleanup();
  }
});

console.log('\u2713 worker-evidence');
