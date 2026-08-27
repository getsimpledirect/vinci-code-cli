// End-to-end worker integration tests
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

let testsPassed = 0;
let testsFailed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    testsFailed++;
  }
};

// Test: Unknown headers trigger blocker
import { TaskEnvelope } from '../worker/task.mjs';

const testUnknownHeaders = () => {
  test('Unknown headers in envelope throw', () => {
    const badBody = 'repo: test/repo\nunknown_key: value\n\nSpec';
    assert.throws(() => {
      new TaskEnvelope(badBody, 'task1');
    }, /Unknown headers: unknown_key/);
  });
};

testUnknownHeaders();

// Test: Deadline validation
const testDeadline = () => {
  const pastDeadline = new Date(Date.now() - 1000).toISOString();
  const futureDeadline = new Date(Date.now() + 60000).toISOString();

  test('Past deadline fails validation', () => {
    const body = `repo: test/repo\ndeadline: ${pastDeadline}\n\nSpec`;
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('past')));
  });

  test('Future deadline passes validation', () => {
    const body = `repo: test/repo\ndeadline: ${futureDeadline}\n\nSpec`;
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(!errors.some(e => e.includes('past')));
  });

  test('Invalid deadline format fails validation', () => {
    const body = 'repo: test/repo\ndeadline: not-a-date\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('ISO-8601')));
  });
};

testDeadline();

// Test: Budget and timeout validation
const testLimits = () => {
  test('Budget must be > 0', () => {
    const body = 'repo: test/repo\nbudget_usd: 0\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('budget_usd')));
  });

  test('Timeout must be > 0', () => {
    const body = 'repo: test/repo\nmax_runtime_s: 0\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('max_runtime_s')));
  });

  test('Negative timeout must be > 0', () => {
    const body = 'repo: test/repo\nmax_runtime_s: -1\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('max_runtime_s')));
  });
};

testLimits();

// Test: Evidence values
const testEvidence = () => {
  test('Evidence can be "pr"', () => {
    const body = 'repo: test/repo\nevidence: pr\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    assert.equal(envelope.evidence, 'pr');
  });

  test('Evidence can be "none"', () => {
    const body = 'repo: test/repo\nevidence: none\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    assert.equal(envelope.evidence, 'none');
  });

  test('Invalid evidence fails validation', () => {
    const body = 'repo: test/repo\nevidence: invalid\n\nSpec';
    const envelope = new TaskEnvelope(body, 'task1');
    const errors = envelope.validate();
    assert(errors.some(e => e.includes('evidence')));
  });
};

testEvidence();

// Test: Defaults
const testDefaults = () => {
  const body = 'repo: test/repo\n\nSpec';
  const envelope = new TaskEnvelope(body, 'task1');

  test('Default evidence is "pr"', () => {
    assert.equal(envelope.evidence, 'pr');
  });

  test('Default provider is "openrouter"', () => {
    assert.equal(envelope.provider, 'openrouter');
  });

  test('Default model is "z-ai/glm-5.2"', () => {
    assert.equal(envelope.model, 'z-ai/glm-5.2');
  });

  test('Default budget is 5', () => {
    assert.equal(envelope.budget_usd, 5);
  });

  test('Default max_runtime_s is 14400', () => {
    assert.equal(envelope.max_runtime_s, 14400);
  });

  test('Default branch is "worker/<taskid>"', () => {
    assert.equal(envelope.branch, 'worker/task1');
  });
};

testDefaults();

// Test: Task ref is preserved
const testRef = () => {
  const body = 'repo: test/repo\nref: job_abc123\n\nSpec';
  const envelope = new TaskEnvelope(body, 'task1');
  
  test('ref from envelope is preserved', () => {
    assert.equal(envelope.ref, 'job_abc123');
  });
};

testRef();

// Summary
console.log(`\nWorker E2E tests: ${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exit(1);
