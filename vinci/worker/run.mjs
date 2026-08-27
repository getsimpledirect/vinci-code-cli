// Spawn and manage vinci process with limits and publishing
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readSessionOutcome, readSessionUsage } from './session-read.mjs';

export class TaskRunner {
  constructor(stateDir, taskEnvelope, taskLifecycle, busClient) {
    this.stateDir = stateDir;
    this.envelope = taskEnvelope;
    this.lifecycle = taskLifecycle;
    this.busClient = busClient;
    this.repoDir = join(stateDir, 'repos', taskEnvelope.repo.split('/').pop());
    this.logsDir = join(stateDir, 'logs');
    mkdirSync(this.logsDir, { recursive: true });
  }

  async run() {
    const taskState = this.lifecycle.getState();
    const sessionId = taskState.session_id;
    const attempt = taskState.attempt;

    try {
      // Parse and validate envelope
      const errors = this.envelope.validate();
      if (errors.length) {
        await this.busClient.post('blocker', 
          `task ${this.envelope.taskId} blocked`,
          `Invalid envelope: ${errors.join('; ')}`,
          this.envelope.ref ? [this.envelope.ref] : undefined);
        this.lifecycle.update({ state: 'BLOCKED', terminal: true });
        return;
      }

      // Claim the task
      this.lifecycle.transitionTo('CLAIMED');
      await this.busClient.post('status', 
        `claimed ${this.envelope.taskId} attempt ${attempt}`,
        `Worker claimed task ${this.envelope.taskId}`);

      // Clone/fetch repo
      await this.ensureRepo();

      // Setup dependencies if needed
      const depResult = await this.setupDependencies();
      if (!depResult.success) {
        await this.busClient.post('blocker',
          `task ${this.envelope.taskId} failed`,
          `Dependencies installation failed: ${depResult.reason}`,
          this.envelope.ref ? [this.envelope.ref] : undefined);
        this.lifecycle.update({ state: 'FAILED', terminal: true, limit_tripped: 'deps' });
        return;
      }

      // Checkout branch
      await this.ensureBranch();

      // Spawn vinci process
      this.lifecycle.transitionTo('RUNNING');
      const runResult = await this.spawnVinci(sessionId);
      this.lifecycle.update(runResult);

      // Read outcome
      const outcome = readSessionOutcome(join(this.stateDir, 'sessions'), sessionId);
      const costUsd = readSessionUsage(join(this.stateDir, 'sessions'), sessionId);
      this.lifecycle.update({ outcome, cost_usd: costUsd });

      // Publish work
      await this.publish();

      // Determine final state
      const finalState = this.determineFinalState(runResult, outcome);
      this.lifecycle.update({ state: finalState, terminal: true });

      // Post final result
      await this.postFinalResult(finalState, outcome, runResult, costUsd);

    } catch (err) {
      console.error(`Task run failed: ${err.message}`);
      this.lifecycle.update({ state: 'FAILED', terminal: true });
      try {
        await this.busClient.post('blocker',
          `task ${this.envelope.taskId} failed`,
          `Worker error: ${err.message}`,
          this.envelope.ref ? [this.envelope.ref] : undefined);
      } catch {
        // Best effort
      }
    }
  }

  async ensureRepo() {
    if (existsSync(join(this.repoDir, '.git'))) {
      // Fetch updates
      const result = spawnSync('git', ['fetch', '-q', 'origin'], {
        cwd: this.repoDir,
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(`git fetch failed: ${result.stderr?.toString() || 'unknown'}`);
      }
    } else {
      // Clone repo
      mkdirSync(dirname(this.repoDir), { recursive: true });
      const url = `https://github.com/${this.envelope.repo}.git`;
      const args = process.env.GH_TOKEN 
        ? ['clone', '-q', url, this.repoDir]
        : ['clone', '-q', url, this.repoDir];
      
      const result = spawnSync('git', args, { stdio: 'pipe' });
      if (result.status !== 0) {
        throw new Error(`git clone failed: ${result.stderr?.toString() || 'unknown'}`);
      }
    }
  }

  async setupDependencies() {
    const packageLock = join(this.repoDir, 'package-lock.json');
    const nodeModules = join(this.repoDir, 'node_modules');

    if (existsSync(packageLock) && !existsSync(nodeModules)) {
      const logFile = join(this.logsDir, `${this.envelope.taskId}.npm.log`);
      const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
        cwd: this.repoDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      writeFileSync(logFile, result.stdout?.toString() || '');
      if (result.stderr) {
        writeFileSync(logFile, result.stderr?.toString() || '', { flag: 'a' });
      }

      if (result.status !== 0) {
        return { success: false, reason: 'npm ci failed' };
      }
    }

    return { success: true };
  }

  async ensureBranch() {
    const branchExists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${this.envelope.branch}`], {
      cwd: this.repoDir,
      stdio: 'pipe',
    }).status === 0;

    if (branchExists) {
      const result = spawnSync('git', ['checkout', '-q', this.envelope.branch], {
        cwd: this.repoDir,
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(`git checkout ${this.envelope.branch} failed`);
      }
    } else {
      const result = spawnSync('git', ['checkout', '-q', '-b', this.envelope.branch, 'origin/main'], {
        cwd: this.repoDir,
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(`git checkout -b ${this.envelope.branch} failed`);
      }
    }
  }

  async spawnVinci(sessionId) {
    const prompt = `Unattended worker run. Commit work on the current branch. Do not push or open PR.\n\n${this.envelope.spec}`;
    
    return new Promise((resolve) => {
      let exitCode = null;
      let childPid = null;
      let limitTripped = null;
      let timed = false;
      const startTime = Date.now();
      const maxRuntime = this.envelope.max_runtime_s * 1000;
      const budget = this.envelope.budget_usd;

      const proc = spawn('vinci', [
        '-p',
        '--session-id', sessionId,
        '--session-dir', join(this.stateDir, 'sessions'),
        '--provider', this.envelope.provider,
        '--model', this.envelope.model,
        '--tools', 'read,grep,find,ls,bash,edit,write',
        prompt,
      ], {
        cwd: this.repoDir,
        stdio: 'pipe',
        detached: true, // Process group
      });

      childPid = proc.pid;

      const limitChecker = setInterval(() => {
        if (timed) return;

        const elapsed = Date.now() - startTime;

        // Check deadline
        if (this.envelope.deadline) {
          const deadlineTime = new Date(this.envelope.deadline).getTime();
          if (Date.now() >= deadlineTime) {
            limitTripped = 'deadline';
            process.kill(-childPid, 'SIGTERM');
            timed = true;
          }
        }

        // Check max_runtime_s
        if (elapsed >= maxRuntime) {
          limitTripped = 'max_runtime_s';
          process.kill(-childPid, 'SIGTERM');
          timed = true;
          setTimeout(() => {
            try { process.kill(-childPid, 'SIGKILL'); } catch {}
          }, 30000);
        }

        // Check budget
        const cost = readSessionUsage(join(this.stateDir, 'sessions'), sessionId);
        if (cost > budget) {
          limitTripped = 'budget';
          process.kill(-childPid, 'SIGTERM');
          timed = true;
          setTimeout(() => {
            try { process.kill(-childPid, 'SIGKILL'); } catch {}
          }, 30000);
        }
      }, 15000);

      proc.on('close', (code) => {
        clearInterval(limitChecker);
        exitCode = code;

        // Get head commit
        const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd: this.repoDir,
          stdio: 'pipe',
        });
        const head = headResult.status === 0 ? headResult.stdout.toString().trim() : '';

        // Get vinci version
        const versionResult = spawnSync('vinci', ['--version'], { stdio: 'pipe' });
        const version = versionResult.status === 0 ? versionResult.stdout.toString().trim() : 'unknown';

        resolve({
          exit_code: exitCode,
          head,
          vinci_version: version,
          provider: this.envelope.provider,
          model: this.envelope.model,
          limit_tripped: limitTripped,
        });
      });

      proc.on('error', (err) => {
        clearInterval(limitChecker);
        resolve({
          exit_code: 1,
          head: '',
          vinci_version: 'unknown',
          provider: this.envelope.provider,
          model: this.envelope.model,
          limit_tripped: limitTripped,
        });
      });
    });
  }

  async publish() {
    if (!process.env.GH_TOKEN) return;

    // Check if commits exist ahead of origin/main
    const checkResult = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], {
      cwd: this.repoDir,
      stdio: 'pipe',
    });
    const aheadCount = parseInt(checkResult.stdout.toString().trim(), 10) || 0;

    if (aheadCount === 0) return;

    // Push branch
    const pushResult = spawnSync('git', ['push', '-u', 'origin', this.envelope.branch], {
      cwd: this.repoDir,
      stdio: 'pipe',
    });

    if (pushResult.status !== 0) {
      this.lifecycle.update({ publish: 'push-failed' });
      return;
    }

    this.lifecycle.update({ publish: 'pushed' });

    // If evidence==pr, create/find PR
    if (this.envelope.evidence === 'pr') {
      const blockerExists = existsSync(join(this.repoDir, 'BLOCKER.md'));
      if (blockerExists) return;

      // Check if PR exists
      const prResult = spawnSync('gh', ['pr', 'list', '--head', this.envelope.branch, '--json', 'url', '-q', '.[0].url'], {
        cwd: this.repoDir,
        stdio: 'pipe',
      });
      let prUrl = prResult.stdout?.toString().trim();

      if (!prUrl) {
        // Create PR
        const titleResult = spawnSync('git', ['log', '-1', '--format=%s'], {
          cwd: this.repoDir,
          stdio: 'pipe',
        });
        const title = titleResult.stdout?.toString().trim() || 'Worker task';

        const bodyResult = spawnSync('git', ['log', '--reverse', '--format=%s%n%n%b', 'origin/main..HEAD'], {
          cwd: this.repoDir,
          stdio: 'pipe',
        });
        let body = bodyResult.stdout?.toString().trim() || '';
        const state = this.lifecycle.getState();
        body += `\n\nUnattended Vinci Worker run (task ${this.envelope.taskId}, attempt ${state.attempt}, ${this.envelope.provider}/${this.envelope.model}, vinci ${state.vinci_version}). Not merged by the worker.`;

        const createResult = spawnSync('gh', ['pr', 'create', '--base', 'main', '--head', this.envelope.branch, '--title', title, '--body', body], {
          cwd: this.repoDir,
          stdio: 'pipe',
        });
        prUrl = createResult.stdout?.toString().trim();
      }

      if (prUrl) {
        this.lifecycle.update({ pr: prUrl });
      }
    }
  }

  determineFinalState(runResult, outcome) {
    // Check for failures
    if (runResult.exit_code !== 0 || runResult.limit_tripped) {
      return 'FAILED';
    }

    // Check for blocked
    if (outcome === 'BLOCKED' || outcome === 'WAITING') {
      return 'BLOCKED';
    }

    const blockerExists = existsSync(join(this.repoDir, 'BLOCKER.md'));
    if (blockerExists) {
      return 'BLOCKED';
    }

    // Check for evidence
    if (this.envelope.evidence === 'none') {
      return 'COMPLETED';
    }

    if (this.envelope.evidence === 'pr') {
      const state = this.lifecycle.getState();
      if (state.pr) {
        return 'COMPLETED';
      }
    }

    return 'UNVERIFIED';
  }

  async postFinalResult(finalState, outcome, runResult, costUsd) {
    const state = this.lifecycle.getState();

    if (finalState === 'COMPLETED' && this.envelope.ref) {
      await this.busClient.post('finding',
        `task ${this.envelope.taskId} completed`,
        `Outcome: ${outcome}. Head: ${runResult.head}. Cost: $${costUsd.toFixed(2)}.`,
        [this.envelope.ref]);
    } else if (finalState === 'BLOCKED') {
      const reason = outcome ? `Agent reported: ${outcome}` : 'BLOCKER.md at HEAD or limit tripped';
      await this.busClient.post('blocker',
        `task ${this.envelope.taskId} blocked`,
        reason,
        this.envelope.ref ? [this.envelope.ref] : undefined);
    } else if (finalState === 'FAILED') {
      let reason = `Exit code: ${runResult.exit_code}`;
      if (runResult.limit_tripped) {
        reason += `, Limit: ${runResult.limit_tripped}`;
      }
      reason += `, Cost: $${costUsd.toFixed(2)}`;
      await this.busClient.post('blocker',
        `task ${this.envelope.taskId} failed`,
        reason,
        this.envelope.ref ? [this.envelope.ref] : undefined);
    } else if (finalState === 'UNVERIFIED') {
      await this.busClient.post('status',
        `task ${this.envelope.taskId} unverified`,
        `Evidence requirement not met (evidence: ${this.envelope.evidence}). Head: ${runResult.head}.`);
    }
  }
}
