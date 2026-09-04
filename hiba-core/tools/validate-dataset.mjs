#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';

const PROTOCOL_VERSION = '1.0';

function fail(condition, message) {
  if (!condition) throw new Error(message);
}

function validateValue(value, schema, field) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.enum) fail(schema.enum.includes(value), `${field} is not in enum`);
  if (schema.type === 'string') fail(typeof value === 'string', `${field} must be string`);
  if (schema.type === 'number') fail(typeof value === 'number' && Number.isFinite(value), `${field} must be number`);
  if (schema.type === 'integer') fail(Number.isInteger(value), `${field} must be integer`);
  if (schema.type === 'boolean') fail(typeof value === 'boolean', `${field} must be boolean`);
  if (schema.type === 'array') {
    fail(Array.isArray(value), `${field} must be array`);
    value.forEach((item, index) => validateValue(item, schema.items, `${field}[${index}]`));
  }
  if (schema.type === 'object') {
    fail(value && typeof value === 'object' && !Array.isArray(value), `${field} must be object`);
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) fail(key in value, `${field}.${key} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) fail(key in properties, `${field}.${key} is not allowed`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateValue(item, properties[key], `${field}.${key}`);
    }
  }
}

function hasCycle(steps) {
  const pending = new Map(steps.map(item => [item.stepId, new Set(item.dependsOn)]));
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!ready.length) return true;
    for (const id of ready) pending.delete(id);
    for (const deps of pending.values()) ready.forEach(id => deps.delete(id));
  }
  return false;
}

export function validateRow(row) {
  fail(row && typeof row === 'object', 'row must be object');
  // `system` is what LLaMA-Factory actually trains on (mapped via
  // dataset_info.json's "system" column, built by the real
  // buildDefaultSystemPrompt() -- see plan_LLM_訓練清單.md §十四).
  // `context` is the raw structured {resources, nodes, tools} used only by
  // this validator and benchmark_quality.py to mechanically check the plan;
  // it is NOT fed to the model (not in dataset_info.json's columns map).
  for (const key of ['instruction', 'system', 'context', 'output']) fail(typeof row[key] === 'string', `${key} must be string`);

  let context;
  let plan;
  try { context = JSON.parse(row.context); } catch { throw new Error('context must contain JSON'); }
  try { plan = JSON.parse(row.output); } catch { throw new Error('output must contain JSON'); }

  fail(context.protocolVersion === PROTOCOL_VERSION, 'context protocolVersion must be 1.0');
  fail(Array.isArray(context.tools), 'context.tools must be array');
  fail(Array.isArray(context.nodes), 'context.nodes must be array');
  fail(plan.protocolVersion === PROTOCOL_VERSION, 'output protocolVersion must be 1.0');
  fail(Array.isArray(plan.steps), 'output.steps must be array');
  fail(['fail-fast', 'partial-success'].includes(plan.supervisorPolicy), 'invalid supervisorPolicy');
  // reject 決策 pattern（見 plan_LLM_訓練清單.md §三-E）：steps 為空時必須附上 error 說明；
  // 其餘情況（無 error）steps 不得為空，避免規劃器學到「隨便回空計畫」。
  if (plan.error !== undefined) {
    fail(typeof plan.error === 'string' && plan.error.length > 0, 'output.error must be non-empty string when present');
    fail(plan.steps.length === 0, 'output.steps must be empty when error is present');
  } else {
    fail(plan.steps.length > 0, 'output.steps must be non-empty array when no error');
  }

  const tools = new Map(context.tools.map(item => [`${item.name}@${item.version}`, item]));
  const nodes = new Map(context.nodes.map(item => [item.nodeId, item]));
  const stepIds = new Set();
  for (const item of plan.steps) {
    for (const key of ['stepId', 'toolName', 'nodeId', 'version']) fail(typeof item[key] === 'string' && item[key], `step.${key} is required`);
    fail(item.input && typeof item.input === 'object' && !Array.isArray(item.input), `${item.stepId}.input must be object`);
    fail(Array.isArray(item.dependsOn), `${item.stepId}.dependsOn must be array`);
    fail(!stepIds.has(item.stepId), `duplicate stepId ${item.stepId}`);
    stepIds.add(item.stepId);

    const spec = tools.get(`${item.toolName}@${item.version}`);
    fail(spec, `${item.stepId} references unknown tool/version`);
    validateValue(item.input, spec.inputSchema, `${item.stepId}.input`);

    const node = nodes.get(item.nodeId);
    fail(node?.status === 'online', `${item.stepId} node must be online`);
    const advertised = node.resources?.some(resource => resource.name === item.toolName && resource.version === item.version);
    fail(node.canInstall === true || advertised, `${item.stepId} node cannot execute tool`);
  }
  for (const item of plan.steps) {
    for (const dependency of item.dependsOn) fail(stepIds.has(dependency), `${item.stepId} has unknown dependency ${dependency}`);
  }
  fail(!hasCycle(plan.steps), 'dependency cycle detected');
  return true;
}

async function validateFile(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let total = 0;
  const invalid = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    total += 1;
    try { validateRow(JSON.parse(line)); } catch (error) { invalid.push(`Line ${total}: ${error.message}`); }
  }
  console.log(`${filePath}: total=${total} valid=${total - invalid.length} invalid=${invalid.length}`);
  invalid.slice(0, 20).forEach(issue => console.log(issue));
  if (!total || invalid.length) process.exitCode = 1;
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node tools/validate-dataset.mjs <dataset.jsonl> [...]');
for (const file of files) await validateFile(file);
