#!/usr/bin/env node
// Diagnostic-only helper: prints buildPlanJsonSchema(tools) as JSON so a raw
// curl/node script can replicate HttpLLMClient's openaiBody() response_format
// exactly, for live model verification outside the actual server process.
// Usage: node --require ts-node/register tools/print-plan-schema.ts < tools.json

import { buildPlanJsonSchema } from '../packages/hiba-agent/src/planning/HttpLLMClient';
import type { ToolSpec } from '../packages/hiba-agent/src/types/hiba.types';

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
  const tools = JSON.parse(raw) as ToolSpec[];
  process.stdout.write(JSON.stringify(buildPlanJsonSchema(tools)));
}

main();
