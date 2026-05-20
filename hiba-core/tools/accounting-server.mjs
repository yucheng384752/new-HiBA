#!/usr/bin/env node
/**
 * HiBA Accounting Server
 * Manages node resource registry, node address registry, and audit anchoring.
 *
 * Endpoints:
 *   GET    /api/resources              → NodeResourceMap (all nodes)
 *   GET    /api/resources/:nodeId      → ResourceItem[]  (single node)
 *   POST   /api/resources/:nodeId      → register/update node resources
 *   DELETE /api/resources/:nodeId      → deregister node resources
 *
 *   GET    /api/nodes                  → all node registrations (address + resources)
 *   GET    /api/nodes/:nodeId          → single node registration
 *   POST   /api/nodes/:nodeId          → register/update node { agentUrl }
 *   DELETE /api/nodes/:nodeId          → deregister node address
 *
 *   POST   /api/audit/anchor           → store anchored audit records
 *   GET    /api/audit/anchor           → query anchored records (?traceId=)
 *   GET    /health                     → { status }
 */
import http from 'node:http';

// ── Default node resources ────────────────────────────────────────────────────

const store = new Map([
  ['node-1', [
    { name: 'cut.sh',    version: '1.2.0', type: 'script' },
    { name: '切割機',    version: '2.0.0', type: 'tool'   },
  ]],
  ['node-2', [
    { name: 'cnc_job.sh', version: '1.0.3', type: 'script' },
    { name: 'CNC-03',     version: '3.1.0', type: 'tool'   },
  ]],
  ['node-3', [
    { name: 'qc_check.sh', version: '1.1.0', type: 'script' },
    { name: '品質檢測儀',  version: '1.0.0', type: 'tool'   },
  ]],
  ['node-4', [
    { name: 'report.sh',  version: '2.3.0', type: 'script'  },
    { name: 'report-svc', version: '1.5.0', type: 'service' },
  ]],
  ['node-5', [
    { name: 'transfer.sh', version: '1.0.1', type: 'script' },
    { name: '搬運車',      version: '1.0.0', type: 'tool'   },
  ]],
]);

/** nodeId → { agentUrl: string, registeredAt: string } */
const nodeRegistry = new Map();

/** @type {Array<{anchoredAt: string, traceId: string, records: unknown[]}>} */
const auditAnchors = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth',
};

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const [urlPath, qs] = (req.url ?? '/').split('?');

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    // GET /health
    if (method === 'GET' && urlPath === '/health') {
      reply(res, 200, { status: 'ok', service: 'hiba-accounting', nodes: store.size });
      return;
    }

    // GET /api/resources → full map
    if (method === 'GET' && urlPath === '/api/resources') {
      const map = Object.fromEntries(store);
      reply(res, 200, map);
      return;
    }

    // GET /api/resources/:nodeId
    const nodeMatch = urlPath.match(/^\/api\/resources\/(.+)$/);
    if (nodeMatch) {
      const nodeId = decodeURIComponent(nodeMatch[1]);

      if (method === 'GET') {
        if (!store.has(nodeId)) {
          reply(res, 404, { error: `Node '${nodeId}' not registered` });
          return;
        }
        reply(res, 200, store.get(nodeId));
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (!Array.isArray(body)) {
          reply(res, 400, { error: 'Body must be an array of ResourceItem' });
          return;
        }
        store.set(nodeId, body);
        reply(res, 200, { nodeId, registered: body.length });
        return;
      }

      if (method === 'DELETE') {
        if (!store.has(nodeId)) {
          reply(res, 404, { error: `Node '${nodeId}' not registered` });
          return;
        }
        store.delete(nodeId);
        reply(res, 200, { nodeId, status: 'deregistered' });
        return;
      }
    }

    // GET /api/nodes → full list with address + resources
    if (method === 'GET' && urlPath === '/api/nodes') {
      const all = [...new Set([...nodeRegistry.keys(), ...store.keys()])].map(nodeId => ({
        nodeId,
        agentUrl:     nodeRegistry.get(nodeId)?.agentUrl ?? null,
        registeredAt: nodeRegistry.get(nodeId)?.registeredAt ?? null,
        resources:    store.get(nodeId) ?? [],
      }));
      reply(res, 200, all);
      return;
    }

    const nodeRegMatch = urlPath.match(/^\/api\/nodes\/(.+)$/);
    if (nodeRegMatch) {
      const nodeId = decodeURIComponent(nodeRegMatch[1]);

      if (method === 'GET') {
        const reg = nodeRegistry.get(nodeId);
        if (!reg) {
          reply(res, 404, { error: `Node '${nodeId}' not registered` });
          return;
        }
        reply(res, 200, { nodeId, ...reg, resources: store.get(nodeId) ?? [] });
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body?.agentUrl !== 'string' || !body.agentUrl) {
          reply(res, 400, { error: '"agentUrl" (string) is required' });
          return;
        }
        nodeRegistry.set(nodeId, { agentUrl: body.agentUrl, registeredAt: new Date().toISOString() });
        reply(res, 200, { nodeId, agentUrl: body.agentUrl, status: 'registered' });
        return;
      }

      if (method === 'DELETE') {
        if (!nodeRegistry.has(nodeId)) {
          reply(res, 404, { error: `Node '${nodeId}' not registered` });
          return;
        }
        nodeRegistry.delete(nodeId);
        reply(res, 200, { nodeId, status: 'deregistered' });
        return;
      }
    }

    // POST /api/audit/anchor
    if (method === 'POST' && urlPath === '/api/audit/anchor') {
      const body = await readBody(req);
      if (!Array.isArray(body?.records)) {
        reply(res, 400, { error: '"records" array is required' });
        return;
      }
      const traceId = req.headers['x-trace-id'] ?? 'unknown';
      auditAnchors.push({
        anchoredAt: new Date().toISOString(),
        traceId,
        records: body.records,
      });
      reply(res, 200, { anchored: body.records.length, traceId });
      return;
    }

    // GET /api/audit/anchor?traceId=xxx
    if (method === 'GET' && urlPath === '/api/audit/anchor') {
      const params = new URLSearchParams(qs ?? '');
      const filterTrace = params.get('traceId');
      const result = filterTrace
        ? auditAnchors.filter(a => a.traceId === filterTrace)
        : auditAnchors;
      reply(res, 200, result);
      return;
    }

    reply(res, 404, { error: `${method} ${urlPath} not found` });
  } catch (err) {
    reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const PORT = process.env.PORT ?? 9090;
server.listen(PORT, () => {
  console.log(`[accounting] http://localhost:${PORT}`);
  console.log(`[accounting] nodes: ${[...store.keys()].join(', ')}`);
});
