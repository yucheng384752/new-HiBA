#!/usr/bin/env node
// Bridges buildDefaultSystemPrompt() (TypeScript, packages/hiba-agent) to
// non-TS callers (currently training/data/build_c6_scenarios.py) so the C6
// eval set's prompt stays byte-for-byte identical to what production sends,
// without re-implementing the prompt template in Python.
//
// Usage: reads {resources, nodes, tools, requestedAt} as JSON from stdin,
// writes the built system prompt (plain text, no trailing formatting) to
// stdout.
//   node --require ts-node/register tools/print-system-prompt.ts < payload.json

import { buildDefaultSystemPrompt } from '../packages/hiba-agent/src/planning/HttpLLMClient';
import type { ToolSpec, NodeDescriptor, NodeResourceMap } from '../packages/hiba-agent/src/types/hiba.types';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    resources: NodeResourceMap;
    nodes: NodeDescriptor[];
    tools: ToolSpec[];
    requestedAt: string;
  };
  process.stdout.write(buildDefaultSystemPrompt(payload.resources, payload.nodes, payload.tools, payload.requestedAt));
}

main();
