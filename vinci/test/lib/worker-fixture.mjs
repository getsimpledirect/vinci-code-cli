// Test fixture for worker integration tests
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class WorkerTestFixture {
  constructor(testName) {
    this.testName = testName;
    this.tempDir = mkdtempSync(`worker-test-${testName}-`);
    this.reposDir = join(this.tempDir, 'repos');
    this.toolsDir = join(this.tempDir, 'tools');
    this.recordFile = join(this.tempDir, 'vinci-calls.txt');
    this.postedMessages = [];
    this.busMessages = [];
    this.busServer = null;
    this.busPort = 0;
    mkdirSync(this.reposDir, { recursive: true });
  }

  createRepo(org, name, options = {}) {
    const origin = join(this.reposDir, `${org}/${name}.git`);
    mkdirSync(join(this.reposDir, org), { recursive: true });
    spawnSync('git', ['init', '--bare'], { cwd: origin, stdio: 'pipe' });

    // Create initial commit via a temporary worktree
    const tempGit = join(this.tempDir, `git-${org}-${name}`);
    mkdirSync(tempGit, { recursive: true });
    spawnSync('git', ['-C', tempGit, 'init'], { stdio: 'pipe' });
    spawnSync('git', ['-C', tempGit, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
    spawnSync('git', ['-C', tempGit, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    writeFileSync(join(tempGit, 'README.md'), 'test repo');
    spawnSync('git', ['-C', tempGit, 'add', 'README.md'], { stdio: 'pipe' });
    spawnSync('git', ['-C', tempGit, 'commit', '-m', 'init'], { stdio: 'pipe' });
    spawnSync('git', ['-C', tempGit, 'remote', 'add', 'origin', origin], { stdio: 'pipe' });
    spawnSync('git', ['-C', tempGit, 'push', '-u', 'origin', 'main'], { stdio: 'pipe' });
    rmSync(tempGit, { recursive: true });

    return { origin, cloneUrl: `file://${origin}` };
  }

  async startBus(handoffs = []) {
    this.busMessages = handoffs;
    this.postedMessages = [];

    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/messages') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.busMessages));
      } else if (req.method === 'POST' && req.url === '/v1/messages') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          this.postedMessages.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.busServer = server;
    return new Promise((resolve) => {
      server.listen(0, () => {
        this.busPort = server.address().port;
        resolve();
      });
    });
  }

  busUrl() {
    return `http://localhost:${this.busPort}`;
  }

  linkTools(toolsSource) {
    mkdirSync(this.toolsDir, { recursive: true });
    const tools = ['vinci', 'npm', 'gh'];
    for (const tool of tools) {
      spawnSync('ln', ['-sf', join(toolsSource, tool), join(this.toolsDir, tool)], { stdio: 'pipe' });
    }
  }

  getEnv(overrides = {}) {
    const env = {
      ...process.env,
      VINCI_BUS_TOKEN: 'test-token',
      VINCI_WORKER_GIT_BASE: `file://${this.reposDir}/`,
      PATH: `${this.toolsDir}:${process.env.PATH}`,
      FAKE_VINCI_RECORD: this.recordFile,
    };
    Object.assign(env, overrides);
    return env;
  }

  getVinciCalls() {
    try {
      const content = readFileSync(this.recordFile, 'utf8');
      return content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  getPostedMessages() {
    return this.postedMessages;
  }

  cleanup() {
    if (this.busServer) {
      this.busServer.close();
    }
    rmSync(this.tempDir, { recursive: true });
  }
}
