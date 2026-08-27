// Worker envelope parsing tests
import assert from 'node:assert/strict';
import { parseEnvelope } from '../worker/task.mjs';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
};

// Test basic parsing
test('parseEnvelope parses repo', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.repo, 'test/repo');
});

test('parseEnvelope parses evidence', () => {
  const result = parseEnvelope('repo: test/repo\nevidence: none\n\nSpec');
  assert.equal(result.evidence, 'none');
});

test('parseEnvelope defaults evidence to pr', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.evidence, 'pr');
});

test('parseEnvelope parses provider', () => {
  const result = parseEnvelope('repo: test/repo\nprovider: deepinfra\n\nSpec');
  assert.equal(result.provider, 'deepinfra');
});

test('parseEnvelope defaults provider', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.provider, 'openrouter');
});

test('parseEnvelope parses model', () => {
  const result = parseEnvelope('repo: test/repo\nmodel: custom/model\n\nSpec');
  assert.equal(result.model, 'custom/model');
});

test('parseEnvelope defaults model', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.model, 'z-ai/glm-5.2');
});

test('parseEnvelope parses budget_usd', () => {
  const result = parseEnvelope('repo: test/repo\nbudget_usd: 10\n\nSpec');
  assert.equal(result.budget_usd, 10);
});

test('parseEnvelope defaults budget_usd', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.budget_usd, 5);
});

test('parseEnvelope parses max_runtime_s', () => {
  const result = parseEnvelope('repo: test/repo\nmax_runtime_s: 3600\n\nSpec');
  assert.equal(result.max_runtime_s, 3600);
});

test('parseEnvelope defaults max_runtime_s', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.max_runtime_s, 14400);
});

test('parseEnvelope parses deadline', () => {
  const deadline = new Date(Date.now() + 60000).toISOString();
  const result = parseEnvelope(`repo: test/repo\ndeadline: ${deadline}\n\nSpec`);
  assert.equal(result.deadline, deadline);
});

test('parseEnvelope parses ref', () => {
  const result = parseEnvelope('repo: test/repo\nref: job_abc123\n\nSpec');
  assert.equal(result.ref, 'job_abc123');
});

test('parseEnvelope parses branch', () => {
  const result = parseEnvelope('repo: test/repo\nbranch: worker/custom\n\nSpec');
  assert.equal(result.branch, 'worker/custom');
});

test('parseEnvelope extracts spec', () => {
  const result = parseEnvelope('repo: test/repo\n\nFix the bug');
  assert.equal(result.spec.trim(), 'Fix the bug');
});

test('parseEnvelope rejects unknown headers', () => {
  assert.throws(() => {
    parseEnvelope('repo: test/repo\nbadkey: value\n\nSpec');
  }, /unknown envelope header/);
});

test('parseEnvelope requires repo', () => {
  assert.throws(() => {
    parseEnvelope('evidence: pr\n\nSpec');
  }, /repo must be/);
});

test('parseEnvelope requires valid repo format', () => {
  assert.throws(() => {
    parseEnvelope('repo: notvalid\n\nSpec');
  }, /repo must be in org\/name form/);
});

test('parseEnvelope requires spec', () => {
  assert.throws(() => {
    parseEnvelope('repo: test/repo\n\n');
  }, /spec must not be empty/);
});

test('parseEnvelope requires blank line', () => {
  assert.throws(() => {
    parseEnvelope('repo: test/repo\nSpec without blank');
  }, /blank line/);
});

test('parseEnvelope rejects invalid budget', () => {
  assert.throws(() => parseEnvelope('repo: test/repo\nbudget_usd: 0\n\nSpec'), /budget_usd/);
});

test('parseEnvelope rejects invalid runtime', () => {
  assert.throws(() => parseEnvelope('repo: test/repo\nmax_runtime_s: nope\n\nSpec'), /max_runtime_s/);
});

test('parseEnvelope rejects non-UTC deadlines', () => {
  assert.throws(() => parseEnvelope('repo: test/repo\ndeadline: 2026-08-26T12:00:00-04:00\n\nSpec'), /UTC/);
});

test('parseEnvelope rejects duplicate headers', () => {
  assert.throws(() => parseEnvelope('repo: test/repo\nrepo: other/repo\n\nSpec'), /duplicate/);
});

console.log(`\nWorker envelope tests: ${passed} passed, ${failed} failed`);

test('parseEnvelope parses claim header', () => {
  const result = parseEnvelope('repo: test/repo\nclaim: src/\n\nSpec');
  assert.equal(result.claim, 'src/');
});

test('parseEnvelope defaults claim to .', () => {
  const result = parseEnvelope('repo: test/repo\n\nSpec');
  assert.equal(result.claim, '.');
});

test('parseEnvelope parses evidence_ref alias for ref', () => {
  const result = parseEnvelope('repo: test/repo\nevidence_ref: job_abc123\n\nSpec');
  assert.equal(result.ref, 'job_abc123');
});

test('parseEnvelope prefers evidence_ref over ref', () => {
  const result = parseEnvelope('repo: test/repo\nref: job_old\nevidence_ref: job_new\n\nSpec');
  assert.equal(result.ref, 'job_new');
});

if (failed > 0) process.exit(1);

// Branch header hardening: a branch value is a git ref NAME, never a refspec or option.
test('parseEnvelope accepts a normal branch', () => {
  assert.equal(parseEnvelope('repo: t/r\nbranch: worker/msg_abc\n\nSpec').branch, 'worker/msg_abc');
});
for (const hostile of ['+main', '-x', 'a:b', 'a..b', 'refs/heads/x', 'a b', '--force']) {
  test(`parseEnvelope rejects hostile branch ${JSON.stringify(hostile)}`, () => {
    assert.throws(() => parseEnvelope(`repo: t/r\nbranch: ${hostile}\n\nSpec`), /branch/);
  });
}
