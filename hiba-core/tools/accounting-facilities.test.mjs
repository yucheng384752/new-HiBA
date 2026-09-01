#!/usr/bin/env node
/**
 * 黑箱測試：把 accounting-server.mjs 當子行程啟動（FACILITIES_DIR 指向暫存
 * 目錄），逐一打 /api/facilities* 端點驗證。比照 tools/start.mjs 既有的
 * spawn + 輪詢 /health 模式，不重刻一套啟動邏輯。
 *
 * 執行：node --test tools/accounting-facilities.test.mjs（於 hiba-core/ 下）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const serverPath = join(root, 'accounting-server.mjs');
const port = 19999 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const facilitiesDir = mkdtempSync(join(tmpdir(), 'hiba-facilities-test-'));

let child;

async function healthy() {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('accounting-server did not become healthy in time');
}

async function api(method, path, body, headers) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

before(async () => {
  child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), FACILITIES_DIR: facilitiesDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', data => console.error(`[accounting] ${data}`));
  await waitForHealth();
});

after(async () => {
  child.kill('SIGTERM');
  rmSync(facilitiesDir, { recursive: true, force: true });
});

test('POST /api/facilities creates a facility', async () => {
  const res = await api('POST', '/api/facilities', { facilityId: 'test-fac', name: 'Test Facility' });
  assert.equal(res.status, 201);
  assert.equal(res.body.facilityId, 'test-fac');
  assert.deepEqual(res.body.stations, []);
});

test('POST /api/facilities rejects an invalid facilityId', async () => {
  const res = await api('POST', '/api/facilities', { facilityId: 'Bad Id!', name: 'x' });
  assert.equal(res.status, 400);
});

test('POST /api/facilities rejects a duplicate facilityId', async () => {
  const res = await api('POST', '/api/facilities', { facilityId: 'test-fac', name: 'dup' });
  assert.equal(res.status, 409);
});

test('POST /api/facilities/:id/stations upserts stations', async () => {
  const s1 = await api('POST', '/api/facilities/test-fac/stations', { stationId: 's1', name: 'Station 1', nodeId: 'node-x' });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.nodeId, 'node-x');
  const s2 = await api('POST', '/api/facilities/test-fac/stations', { stationId: 's2', name: 'Station 2' });
  assert.equal(s2.status, 200);
});

test('POST /api/facilities/:id/edges creates an immediately-approved manual edge', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges', {
    fromStationId: 's1', relation: 'upstream_of', toStationId: 's2',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.source, 'manual');
});

test('POST /api/facilities/:id/edges rejects an unknown station', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges', {
    fromStationId: 's1', relation: 'upstream_of', toStationId: 'nope',
  });
  assert.equal(res.status, 400);
});

test('POST /api/facilities/:id/edges rejects an invalid relation', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges', {
    fromStationId: 's1', relation: 'flies_over', toStationId: 's2',
  });
  assert.equal(res.status, 400);
});

test('POST /api/facilities/:id/edges/suggest does not downgrade an already-approved edge', async () => {
  // 為什麼重要：這是從 TopologySequenceDetector.test.ts 移過來的案例
  // ——upgrade-guard 邏輯現在在伺服器端的 upsertEdge()。
  const res = await api('POST', '/api/facilities/test-fac/edges/suggest', {
    fromStationId: 's1', relation: 'upstream_of', toStationId: 's2',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
});

test('POST /api/facilities/:id/edges/suggest creates a suggested edge for a new pair', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges/suggest', {
    fromStationId: 's2', relation: 'backup_for', toStationId: 's1',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'suggested');
  assert.equal(res.body.source, 'audit_trail_inference');
});

test('POST /api/facilities/:id/edges/approve requires X-User-Id', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges/approve', {
    fromStationId: 's2', relation: 'backup_for', toStationId: 's1',
  });
  assert.equal(res.status, 400);
});

test('POST /api/facilities/:id/edges/approve flips status to approved', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges/approve', {
    fromStationId: 's2', relation: 'backup_for', toStationId: 's1',
  }, { 'X-User-Id': 'tester' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.approvedBy, 'tester');
});

test('POST /api/facilities/:id/edges/approve is idempotent on an already-approved edge', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges/approve', {
    fromStationId: 's2', relation: 'backup_for', toStationId: 's1',
  }, { 'X-User-Id': 'tester' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
});

test('POST /api/facilities/:id/edges/approve returns 404 for an unknown edge', async () => {
  const res = await api('POST', '/api/facilities/test-fac/edges/approve', {
    fromStationId: 'zz', relation: 'backup_for', toStationId: 's1',
  }, { 'X-User-Id': 'tester' });
  assert.equal(res.status, 404);
});

test('GET /api/facilities?nodeIds= reverse lookup filters by node membership', async () => {
  await api('POST', '/api/facilities', { facilityId: 'other-fac', name: 'Other' });

  const res = await api('GET', '/api/facilities?nodeIds=node-x');
  assert.equal(res.status, 200);
  const ids = res.body.map(f => f.facilityId);
  assert.ok(ids.includes('test-fac'));
  assert.ok(!ids.includes('other-fac'));
});

test('GET /api/facilities/:id?status=suggested filters edges', async () => {
  const res = await api('GET', '/api/facilities/test-fac?status=suggested');
  assert.equal(res.status, 200);
  assert.ok(res.body.edges.every(e => e.status === 'suggested'));
});

test('GET /api/facilities/:id returns 404 for an unknown facility', async () => {
  const res = await api('GET', '/api/facilities/does-not-exist');
  assert.equal(res.status, 404);
});

test('mtime cache picks up direct file edits, not just API writes', async () => {
  const path = join(facilitiesDir, 'test-fac.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.name = 'Renamed Directly';
  await new Promise(resolve => setTimeout(resolve, 10)); // 確保 mtime 真的往前推進
  writeFileSync(path, JSON.stringify(doc, null, 2));

  const res = await api('GET', '/api/facilities/test-fac');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed Directly');
});
