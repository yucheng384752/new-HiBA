#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';

async function loadZod() {
  try {
    return await import('zod');
  } catch {
    try {
      return await import('https://esm.sh/zod');
    } catch {
      return null;
    }
  }
}

function createLineValidator(zodModule) {
  const z = zodModule?.z || zodModule?.default || zodModule;
  if (z?.object && z?.array && z?.record && z?.unknown && z?.enum && z?.string) {
    const stepSchema = z.object({
      nodeId: z.string(),
      tool: z.string(),
      script: z.string(),
      args: z.record(z.string(), z.unknown()),
    });
    const planSchema = z.object({
      steps: z.array(stepSchema),
      supervisorPolicy: z.enum(['fail-fast', 'partial-success']),
    });
    const rowSchema = z.object({
      instruction: z.string(),
      input: z.string(),
      output: z.string(),
    });

    return (line) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return { valid: false, message: 'invalid JSON' };
      }

      const rowResult = rowSchema.safeParse(row);
      if (!rowResult.success) return { valid: false, message: formatZodIssue(rowResult.error) };

      let output;
      try {
        output = JSON.parse(row.output);
      } catch {
        return { valid: false, message: 'output invalid JSON' };
      }

      const planResult = planSchema.safeParse(output);
      if (!planResult.success) return { valid: false, message: formatZodIssue(planResult.error) };
      return { valid: true };
    };
  }

  return (line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { valid: false, message: 'invalid JSON' };
    }

    for (const key of ['instruction', 'input', 'output']) {
      if (typeof row?.[key] !== 'string') return { valid: false, message: `missing ${key}` };
    }

    let output;
    try {
      output = JSON.parse(row.output);
    } catch {
      return { valid: false, message: 'output invalid JSON' };
    }

    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      return { valid: false, message: 'output must be an object' };
    }
    if (!Array.isArray(output.steps)) return { valid: false, message: 'missing steps' };
    for (let i = 0; i < output.steps.length; i += 1) {
      const step = output.steps[i];
      if (!step || typeof step !== 'object' || Array.isArray(step)) return { valid: false, message: `steps[${i}] must be an object` };
      for (const key of ['nodeId', 'tool', 'script']) {
        if (typeof step[key] !== 'string') return { valid: false, message: `steps[${i}] missing ${key}` };
      }
      if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) return { valid: false, message: `steps[${i}] missing args` };
    }
    if (!['fail-fast', 'partial-success'].includes(output.supervisorPolicy)) {
      return { valid: false, message: 'missing supervisorPolicy' };
    }
    return { valid: true };
  };
}

function formatZodIssue(error) {
  const issue = error?.issues?.[0];
  if (!issue) return 'validation failed';
  const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
  if (path) {
    const normalized = path.replace(/steps\.(\d+)\./g, 'steps[$1] ');
    const last = String(issue.path[issue.path.length - 1] ?? '');
    if (issue.code === 'invalid_type' && issue.received === 'undefined') return `${normalized}`;
    if (last) return `${normalized} ${issue.message}`.trim();
  }
  return issue.message || 'validation failed';
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Usage: node tools/validate-dataset.mjs dataset.jsonl');

  const validateLine = createLineValidator(await loadZod());
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let total = 0;
  let valid = 0;
  const invalid = [];

  for await (const line of rl) {
    if (line.trim() === '') continue;
    total += 1;
    const result = validateLine(line);
    if (result.valid) {
      valid += 1;
    } else {
      invalid.push({ line: total, message: result.message });
    }
  }

  console.log(`Total: ${total} | Valid: ${valid} | Invalid: ${invalid.length}`);
  for (const issue of invalid) {
    console.log(`Line ${issue.line}: ${issue.message}`);
  }

  if (invalid.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
