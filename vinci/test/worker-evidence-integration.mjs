// Test: evidence final body carries uri/sha256; ledger ref posts evidence to the bus.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function taskFile(fixture, id) {
  return JSON.parse(readFileSync(join(fixture.tempDir, 'tasks', `${id}.json`), 'utf8'));
}

// The fake aws records `s3 cp --no-progress <bundle.tgz> <uri>`; read result.json back out of
// the bundle the worker actually handed to the uploader.
function uploadedResultJson(fixture) {
  const calls = readFileSync(join(fixture.tempDir, 'aws-calls.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, 'exactly one aws s3 cp is expected');
  const tarPath = calls[0].argv[3];
  assert.match(tarPath, /\.tgz$/);
  const out = mkdtempSync(join(tmpdir(), 'evidence-bundle-'));
  try {
    const tar = spawnSync('tar', ['xzf', tarPath, '-C', out], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    return JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function handoff(body) {
  return {
    message_id: '5',
    kind: 'handoff',
    to_agent: 'worker:w5',
    subject: 'evidence task',
    body,
    ts: '2026-08-26T10:00:00Z',
    posted_by: 'scheduler',
  };
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

// W0.2: evidence before terminal. When evidence is configured and does not fully land, a
// COMPLETED claim is downgraded to UNVERIFIED and the record on disk says so.
await testRun('S3 upload failure with evidence configured downgrades COMPLETED to UNVERIFIED', async () => {
  const fixture = new WorkerTestFixture('evidence-upload-fail');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [handoff('repo: test/repo\nevidence: pr\nref: job_5\n\nTask')], {
      FAKE_VINCI_OUTCOME: 'DONE',
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/',
      FAKE_AWS_EXIT: '1',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });

    const onDisk = taskFile(fixture, '5');
    assert.equal(onDisk.state, 'UNVERIFIED', 'task file must show UNVERIFIED, not COMPLETED');
    assert.equal(onDisk.terminal, true);
    assert.equal(onDisk.evidence_error, 'S3 upload failed');
    assert.equal(onDisk.pr, 'https://github.com/test/repo/pull/123', 'published fields survive the downgrade');
    assert.equal(fixture.getEvidencePosts().length, 0, 'no metadata POST after a failed upload');

    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'status', 'UNVERIFIED must not post a finding');
    assert.equal(final.refs, undefined);
    assert.match(final.subject, /^task 5 unverified$/);
    assert.match(final.body, /^state=UNVERIFIED /);
    assert.match(final.body, / evidence_error=S3 upload failed/);
    assert.doesNotMatch(final.body, /state=COMPLETED/);
    assert.doesNotMatch(final.body, /evidence_uri=/, 'a bundle that never landed must not be advertised');
    assert.doesNotMatch(final.body, /evidence_sha256=/, 'a bundle that never landed must not be advertised');
    assert.equal(onDisk.evidence_result_state, 'COMPLETED', 'the intended state is recorded next to the committed one');
  } finally {
    await fixture.cleanup();
  }
});

await testRun('metadata POST failure (upload ok) downgrades COMPLETED to UNVERIFIED with the error in the body', async () => {
  const fixture = new WorkerTestFixture('evidence-post-fail');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    fixture.evidencePostStatus = 500;
    await runOnce(fixture, [handoff('repo: test/repo\nevidence: pr\nref: job_5\n\nTask')], {
      FAKE_VINCI_OUTCOME: 'DONE',
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });

    assert.equal(fixture.getEvidencePosts().length, 0);
    assert.equal(fixture.rejectedPosts.length, 1, 'the metadata POST was attempted and refused');
    const onDisk = taskFile(fixture, '5');
    assert.equal(onDisk.state, 'UNVERIFIED');
    assert.equal(onDisk.evidence_error, 'Bus POST failed: 500');
    assert.equal(onDisk.evidence_result_state, 'COMPLETED', 'disagreement with the bundle is explicit on disk');

    // The bundle that DID land must not claim a committed COMPLETED the record does not hold.
    const uploaded = uploadedResultJson(fixture);
    assert.equal(uploaded.snapshot, 'pre-terminal');
    assert.equal(uploaded.committed_state, null);
    assert.equal(uploaded.terminal, false, 'a pre-terminal bundle never asserts terminal');
    assert.equal(uploaded.state, 'COMPLETED', 'the intended state is still named, as the disk record says');

    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'status');
    assert.equal(final.refs, undefined, 'no ledger finding without ledger evidence');
    assert.match(final.body, /^state=UNVERIFIED /);
    assert.match(final.body, / evidence_uri=s3:\/\/bucket\/vinci-evidence\/5\/[0-9a-f]{64}\.tgz/, 'the bundle did reach S3');
    assert.match(final.body, / evidence_error=Bus POST failed: 500/);
  } finally {
    await fixture.cleanup();
  }
});

await testRun('BLOCKED keeps its state on evidence failure but records evidence_error', async () => {
  const fixture = new WorkerTestFixture('evidence-blocked-fail');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [handoff('repo: test/repo\nevidence: pr\nref: job_5\n\nTask')], {
      FAKE_VINCI_OUTCOME: 'BLOCKED',
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/',
      FAKE_AWS_EXIT: '1',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });
    const onDisk = taskFile(fixture, '5');
    assert.equal(onDisk.state, 'BLOCKED');
    assert.equal(onDisk.evidence_error, 'S3 upload failed');
    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'status');
    assert.match(final.body, / evidence_error=S3 upload failed/);
  } finally {
    await fixture.cleanup();
  }
});

await testRun('evidence not configured: COMPLETED is unchanged and no bundle is attempted', async () => {
  const fixture = new WorkerTestFixture('evidence-unconfigured');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [handoff('repo: test/repo\nevidence: pr\nref: job_5\n\nTask')], {
      FAKE_VINCI_OUTCOME: 'DONE',
      FAKE_AWS_EXIT: '1',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });
    const onDisk = taskFile(fixture, '5');
    assert.equal(onDisk.state, 'COMPLETED');
    assert.equal(onDisk.evidence_error, null);
    assert.equal(onDisk.evidence_result_state, null, 'no evidence attempted, nothing to compare');
    assert.throws(() => readFileSync(join(fixture.tempDir, 'aws-calls.txt')), { code: 'ENOENT' }, 'aws must not be invoked');
    const final = fixture.getPostedMessages().at(-1);
    assert.equal(final.kind, 'finding');
    assert.deepEqual(final.refs, ['job_5']);
    assert.doesNotMatch(final.body, /evidence_/);
  } finally {
    await fixture.cleanup();
  }
});

await testRun('the uploaded result.json carries the final state, not PENDING/RUNNING', async () => {
  const fixture = new WorkerTestFixture('evidence-result-json');
  try {
    fixture.createRepo('test', 'repo');
    fixture.linkTools(TOOLS);
    await runOnce(fixture, [handoff('repo: test/repo\nevidence: pr\nref: job_5\n\nTask')], {
      FAKE_VINCI_OUTCOME: 'DONE',
      VINCI_EVIDENCE_URI_PREFIX: 's3://bucket/vinci-evidence/',
      FAKE_AWS_RECORD: join(fixture.tempDir, 'aws-calls.txt'),
    });
    const uploaded = uploadedResultJson(fixture);
    const onDisk = taskFile(fixture, '5');
    assert.equal(onDisk.state, 'COMPLETED');
    assert.equal(uploaded.state, 'COMPLETED', 'result.json must carry the final state');
    assert.equal(uploaded.snapshot, 'pre-terminal');
    assert.equal(uploaded.committed_state, null);
    assert.equal(uploaded.terminal, false, 'the bundle is built before the terminal write');
    assert.equal(onDisk.evidence_result_state, 'COMPLETED');
    assert.equal(uploaded.pr, onDisk.pr);
    assert.equal(uploaded.head, onDisk.head);
    assert.equal(uploaded.finished_at, onDisk.finished_at, 'the uploaded snapshot is the one committed');
    assert.equal(uploaded.exit_code, 0);
  } finally {
    await fixture.cleanup();
  }
});

console.log('\u2713 worker-evidence');
