#!/usr/bin/env node
// Vinci Worker daemon — Stage 1
// Polls HTTP bus for handoff messages, spawns unattended vinci -p runs, publishes results

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BusClient } from './bus.mjs';
import { TaskEnvelope, TaskLifecycle } from './task.mjs';
import { TaskRunner } from './run.mjs';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const opts = {
    id: undefined,
    server: undefined,
    once: false,
    pollSeconds: 60,
    stateDir: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') opts.id = args[++i];
    else if (args[i] === '--server') opts.server = args[++i];
    else if (args[i] === '--once') opts.once = true;
    else if (args[i] === '--poll-seconds') opts.pollSeconds = parseInt(args[++i], 10);
    else if (args[i] === '--state-dir') opts.stateDir = args[++i];
  }

  if (!opts.id) throw new Error('--id required');
  if (!opts.server) throw new Error('--server required');
  if (!opts.stateDir) opts.stateDir = join(process.cwd(), '.vinci-worker-state');

  const token = process.env.VINCI_BUS_TOKEN;
  if (!token) throw new Error('VINCI_BUS_TOKEN environment variable required');

  return { opts, token };
};

const loadCursor = (stateDir, workerId) => {
  const cursorFile = join(stateDir, 'cursor.json');
  try {
    const data = readFileSync(cursorFile, 'utf8');
    const obj = JSON.parse(data);
    return obj[workerId] || 0;
  } catch {
    return 0;
  }
};

const saveCursor = (stateDir, workerId, id) => {
  const cursorFile = join(stateDir, 'cursor.json');
  mkdirSync(stateDir, { recursive: true });
  let obj = {};
  try {
    const data = readFileSync(cursorFile, 'utf8');
    obj = JSON.parse(data);
  } catch {}
  obj[workerId] = id;
  writeFileSync(cursorFile, JSON.stringify(obj, null, 2));
};

const main = async () => {
  const { opts, token } = parseArgs();
  const bus = new BusClient(opts.server, token);
  const stateDir = opts.stateDir;
  mkdirSync(stateDir, { recursive: true });

  console.log(`Vinci Worker starting: id=${opts.id}, server=${opts.server}, state=${stateDir}`);

  const processHandoff = async (message) => {
    try {
      const taskId = message.id.toString();
      const lifecycle = new TaskLifecycle(stateDir, taskId);

      // Skip if already terminal
      if (lifecycle.isTerminal()) {
        console.log(`  Task ${taskId} already terminal, skipping`);
        return;
      }

      // Start or resume
      const sessionId = taskId;
      if (!lifecycle.getState().session_id) {
        lifecycle.nextAttempt(sessionId);
      }

      // Parse envelope
      const envelope = new TaskEnvelope(message.body, taskId, message.ref);
      
      // Run task
      const runner = new TaskRunner(stateDir, envelope, lifecycle, bus);
      await runner.run();

      console.log(`  Task ${taskId} completed with state: ${lifecycle.getState().state}`);
    } catch (err) {
      console.error(`  Error processing handoff: ${err.message}`);
    }
  };

  const pollOnce = async () => {
    const cursor = loadCursor(stateDir, opts.id);
    const handoffs = await bus.poll(opts.id, cursor);

    if (handoffs.length === 0) {
      console.log(`[${new Date().toISOString()}] No new handoffs (cursor=${cursor})`);
      return false;
    }

    console.log(`[${new Date().toISOString()}] Received ${handoffs.length} handoff(s)`);
    for (const handoff of handoffs) {
      await processHandoff(handoff);
      saveCursor(stateDir, opts.id, handoff.id);
    }
    return true;
  };

  if (opts.once) {
    await pollOnce();
    process.exit(0);
  } else {
    // Polling loop
    while (true) {
      try {
        await pollOnce();
      } catch (err) {
        console.error(`Poll error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, opts.pollSeconds * 1000));
    }
  }
};

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
