import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'scripts_pi', 'deploy_http', 'sub_web_server.js'),
  'utf8',
);
const start = source.indexOf('function validateInput');
const end = source.indexOf('// ── 端點實作', start);
assert.ok(start >= 0 && end > start, 'validateInput source not found');

const context = {};
vm.runInNewContext(`${source.slice(start, end)}; this.validateInput = validateInput;`, context);
const schema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['read', 'write'] },
    count: { type: 'integer' },
  },
  required: ['mode'],
};

assert.deepEqual([...context.validateInput({ mode: 'read', count: 2 }, schema)], []);
assert.equal(context.validateInput({ count: 1.5 }, schema).length, 2);
assert.equal(context.validateInput({ mode: 'delete' }, schema).length, 1);

const dashboard = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'scripts_pi', 'claw-dashboard.html'),
  'utf8',
);
const scripts = [...dashboard.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length > 0, 'dashboard script block not found');
for (const [, script] of scripts) new vm.Script(script);
console.log('Sub-Web JSON Schema validation passed');
