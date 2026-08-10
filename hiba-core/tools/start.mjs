#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(root, 'packages', 'hiba-agent');
const accountingPort = Number(process.env.ACCOUNTING_PORT ?? 9090);
const agentPort = Number(process.env.AGENT_PORT ?? 8090);
const accountingUrl = process.env.ACCOUNTING_URL ?? `http://127.0.0.1:${accountingPort}`;
const agentUrl = `http://127.0.0.1:${agentPort}`;
const ollamaUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const children = [];
let stopping = false;

const services = [
  {
    name: 'accounting',
    healthUrl: `${accountingUrl}/health`,
    cwd: root,
    args: [path.join(root, 'tools', 'accounting-server.mjs')],
    env: { PORT: String(accountingPort) },
  },
  {
    name: 'agent',
    healthUrl: `${agentUrl}/health`,
    cwd: agentDir,
    args: ['--require', 'ts-node/register', 'src/server/start.ts'],
    env: {
      AGENT_PORT: String(agentPort),
      ACCOUNTING_URL: accountingUrl,
      HIBA_BASE_URL: accountingUrl,
    },
  },
];

function log(name, message) {
  for (const line of String(message).trimEnd().split(/\r?\n/)) {
    if (line) console.log(`[${name}] ${line}`);
  }
}

async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(service, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(service.healthUrl)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${service.name} did not become healthy: ${service.healthUrl}`);
}

function startService(service) {
  const child = spawn(process.execPath, service.args, {
    cwd: service.cwd,
    env: { ...process.env, ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Own process group so a Ctrl+C in this console doesn't hit the child
    // directly. Without this, Windows delivers CTRL_C_EVENT to every
    // process sharing the console at once, and the child can exit before
    // shutdown() below sets `stopping`, making a normal Ctrl+C look like
    // an unexpected crash. The parent still relays SIGINT via kill() below.
    detached: true,
  });
  children.push(child);
  child.stdout.on('data', data => log(service.name, data));
  child.stderr.on('data', data => log(service.name, data));
  child.once('error', error => {
    if (!stopping) void shutdown(1, `${service.name} failed to start: ${error.message}`);
  });
  child.once('exit', code => {
    if (!stopping) void shutdown(code || 1, `${service.name} exited unexpectedly (${code})`);
  });
}

async function shutdown(code = 0, message) {
  if (stopping) return;
  stopping = true;
  if (message) console.error(`[start] ${message}`);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(children.map(child => child.exitCode === null
    ? new Promise(resolve => child.once('exit', resolve))
    : Promise.resolve()));
  process.exitCode = code;
}

async function main() {
  if (!existsSync(path.join(agentDir, 'node_modules', 'ts-node'))) {
    throw new Error(`Missing agent dependencies. Run npm install in ${agentDir}`);
  }

  for (const service of services) {
    if (await healthy(service.healthUrl)) {
      log('start', `${service.name} already running at ${service.healthUrl}`);
      continue;
    }
    startService(service);
    await waitForHealth(service);
  }

  const ollamaReady = await healthy(`${ollamaUrl}/api/tags`);
  log('start', `Accounting: ${accountingUrl}`);
  log('start', `Agent:      ${agentUrl}`);
  log('start', ollamaReady
    ? `Ollama:     ${ollamaUrl}`
    : `Ollama is not reachable at ${ollamaUrl}; planning requests will fail until it is started`);

  if (process.argv.includes('--smoke')) {
    await shutdown();
    return;
  }
  log('start', 'Press Ctrl+C to stop services started by this script');
  process.stdin.resume();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch(error => void shutdown(1, error instanceof Error ? error.message : String(error)));
