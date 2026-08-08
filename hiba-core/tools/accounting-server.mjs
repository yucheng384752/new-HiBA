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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROTOCOL_VERSION = '1.0';
const NODE_LEASE_MS = Number(process.env.NODE_LEASE_MS ?? 30_000);
const catalogDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts_pi', 'deploy_http', 'scripts');

/** @type {Array<{anchoredAt: string, traceId: string, records: unknown[]}>} */
const auditAnchors = [];

/** @type {Map<string, unknown>} */
const blockchainFiles = new Map();
let blockchainBlockNumber = 1;

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

function replyError(res, status, errorCode, error, details) {
  reply(res, status, {
    success: false,
    protocolVersion: PROTOCOL_VERSION,
    errorCode,
    error,
    retryable: errorCode === 'SERVICE_UNAVAILABLE' || errorCode === 'NODE_OFFLINE',
    durationMs: 0,
    executedAt: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
  });
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

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function txHashFor(scope, payload) {
  return `0x${sha256Hex(`${scope}:${JSON.stringify(payload)}`)}`;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
  const text = await res.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { raw: text }; }
  }
  return { res, body };
}

function openNodeChannel(nodeId, agentUrl) {
  const now = new Date().toISOString();
  return {
    agentUrl,
    registeredAt: now,
    lastSeenAt: now,
    status: 'online',
    connectionId: sha256Hex(`${nodeId}:${agentUrl}:${Date.now()}`).slice(0, 16),
  };
}

function nodeStatus(reg) {
  if (!reg?.lastSeenAt) return 'offline';
  return Date.now() - Date.parse(reg.lastSeenAt) <= NODE_LEASE_MS ? 'online' : 'offline';
}

function toolCatalogEntry(toolName, version) {
  const manifestPath = join(catalogDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const entries = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = entries.find(entry => entry.name === toolName && (!version || entry.version === version));
  if (!manifest) return null;
  const localScriptPath = join(catalogDir, `${manifest.scriptName}.py`);
  const scriptPath = existsSync(localScriptPath)
    ? localScriptPath
    : join(catalogDir, '..', `${manifest.scriptName}.py`);
  if (!existsSync(scriptPath)) return null;
  const content = readFileSync(scriptPath, 'utf8');
  return {
    toolName,
    version: manifest.version ?? '1.0.0',
    sha256: sha256Hex(content),
    deploy: { type: 'script', scriptName: manifest.scriptName, content, manifest, overwrite: true },
  };
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

    // POST /api/blockchain/protect
    if (method === 'POST' && urlPath === '/api/blockchain/protect') {
      const body = await readBody(req);
      if (typeof body?.filePath !== 'string' || !body.filePath.trim()) {
        replyError(res, 400, 'REQUEST_INVALID', '"filePath" is required');
        return;
      }

      const fileHash = typeof body.fileHash === 'string' ? body.fileHash : sha256Hex(body.filePath);
      const txHash = txHashFor('file-protect', {
        filePath: body.filePath,
        fileHash,
        traceId: req.headers['x-trace-id'] ?? null,
      });
      const record = {
        filePath: body.filePath,
        fileHash,
        txHash,
        blockHash: txHashFor('block', txHash),
        blockNumber: blockchainBlockNumber++,
        contractAddress: process.env.FILE_PROTECTION_CONTRACT_ADDRESS ?? 'mock-file-protection-contract',
        chainId: Number(process.env.BLOCKCHAIN_CHAIN_ID ?? 31337),
        protectedAt: new Date().toISOString(),
        metadata: body.metadata ?? {},
      };
      blockchainFiles.set(body.filePath, record);
      reply(res, 200, { success: true, mode: 'mock', ...record });
      return;
    }

    // POST /api/blockchain/verify
    if (method === 'POST' && urlPath === '/api/blockchain/verify') {
      const body = await readBody(req);
      if (typeof body?.filePath !== 'string' || !body.filePath.trim()) {
        replyError(res, 400, 'REQUEST_INVALID', '"filePath" is required');
        return;
      }

      const record = blockchainFiles.get(body.filePath);
      const expectedHash = typeof body.expectedHash === 'string'
        ? body.expectedHash
        : (typeof body.fileHash === 'string' ? body.fileHash : undefined);
      const valid = record !== undefined && (expectedHash === undefined || record.fileHash === expectedHash);
      reply(res, 200, {
        valid,
        isValid: valid,
        filePath: body.filePath,
        fileHash: record?.fileHash ?? null,
        expectedHash: expectedHash ?? null,
        txHash: record?.txHash ?? '',
        blockHash: record?.blockHash ?? '',
        blockNumber: record?.blockNumber ?? null,
        contractAddress: record?.contractAddress ?? null,
        chainId: record?.chainId ?? Number(process.env.BLOCKCHAIN_CHAIN_ID ?? 31337),
        mode: 'mock',
      });
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
          replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
          return;
        }
        reply(res, 200, store.get(nodeId));
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (!Array.isArray(body)) {
          replyError(res, 400, 'REQUEST_INVALID', 'Body must be an array of ResourceItem');
          return;
        }
        store.set(nodeId, body);
        reply(res, 200, { nodeId, registered: body.length });
        return;
      }

      if (method === 'DELETE') {
        if (!store.has(nodeId)) {
          replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
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
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        ...nodeRegistry.get(nodeId),
        status:       nodeStatus(nodeRegistry.get(nodeId)),
        canInstall:   nodeRegistry.get(nodeId)?.canInstall ?? false,
        agentUrl:     nodeRegistry.get(nodeId)?.agentUrl ?? null,
        registeredAt: nodeRegistry.get(nodeId)?.registeredAt ?? null,
        lastSeenAt:   nodeRegistry.get(nodeId)?.lastSeenAt ?? null,
        resources:    store.get(nodeId) ?? [],
      }));
      reply(res, 200, all);
      return;
    }

    if (method === 'GET' && urlPath === '/api/nodes/capabilities') {
      const nodeId = new URLSearchParams(qs ?? '').get('nodeId');
      if (!nodeId) {
        replyError(res, 400, 'REQUEST_INVALID', '"nodeId" is required');
        return;
      }
      const reg = nodeRegistry.get(nodeId);
      if (!reg) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
        return;
      }
      reply(res, 200, {
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        status: nodeStatus(reg),
        lastSeenAt: reg.lastSeenAt,
        canInstall: reg.canInstall ?? false,
        tools: (store.get(nodeId) ?? []).map(tool => ({ name: tool.name, version: tool.version ?? '1.0.0' })),
      });
      return;
    }

    const catalogMatch = urlPath.match(/^\/api\/tools\/catalog\/(.+)$/);
    if (method === 'GET' && catalogMatch) {
      const params = new URLSearchParams(qs ?? '');
      const entry = toolCatalogEntry(decodeURIComponent(catalogMatch[1]), params.get('version'));
      if (!entry) {
        replyError(res, 404, 'TOOL_NOT_FOUND', 'Tool artifact not found');
        return;
      }
      reply(res, 200, entry);
      return;
    }

    const nodeConnectMatch = urlPath.match(/^\/api\/nodes\/([^/]+)\/connect$/);
    if (method === 'POST' && nodeConnectMatch) {
      const nodeId = decodeURIComponent(nodeConnectMatch[1]);
      const body = await readBody(req);
      if (typeof body?.agentUrl !== 'string' || !body.agentUrl) {
        replyError(res, 400, 'REQUEST_INVALID', '"agentUrl" (string) is required');
        return;
      }

      const { res: healthRes, body: health } = await fetchJson(`${body.agentUrl}/health`);
      if (!healthRes.ok) {
        replyError(res, 502, 'NODE_OFFLINE', `Node health check failed: HTTP ${healthRes.status}`);
        return;
      }

      let resources = Array.isArray(body.resources) ? body.resources : null;
      let canInstall = body.canInstall === true;
      if (!resources) {
        const scripts = await fetchJson(`${body.agentUrl}/scripts`).catch(() => null);
        if (scripts?.res.ok && Array.isArray(scripts.body?.scripts)) {
          resources = scripts.body.scripts.map(tool => ({ name: tool.name, version: tool.version ?? '1.0.0', type: 'tool' }));
          canInstall = true;
        }
      }
      if (resources) store.set(nodeId, resources);

      const channel = { ...openNodeChannel(nodeId, body.agentUrl), canInstall };
      nodeRegistry.set(nodeId, channel);
      reply(res, 200, {
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        ...channel,
        health,
        endpoints: {
          heartbeat: `/api/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
          update: `/api/nodes/${encodeURIComponent(nodeId)}/update`,
        },
      });
      return;
    }

    const nodeHeartbeatMatch = urlPath.match(/^\/api\/nodes\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && nodeHeartbeatMatch) {
      const nodeId = decodeURIComponent(nodeHeartbeatMatch[1]);
      const reg = nodeRegistry.get(nodeId);
      if (!reg) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
        return;
      }
      reg.lastSeenAt = new Date().toISOString();
      reg.status = 'online';
      reply(res, 200, { nodeId, ...reg });
      return;
    }

    const nodeUpdateMatch = urlPath.match(/^\/api\/nodes\/([^/]+)\/update$/);
    if (method === 'POST' && nodeUpdateMatch) {
      const nodeId = decodeURIComponent(nodeUpdateMatch[1]);
      const reg = nodeRegistry.get(nodeId);
      if (!reg?.agentUrl) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
        return;
      }

      const body = await readBody(req);
      const artifact = typeof body?.toolName === 'string'
        ? toolCatalogEntry(body.toolName, body.version)
        : null;
      if (body?.toolName && !artifact) {
        replyError(res, 404, 'TOOL_NOT_FOUND', `Tool '${body.toolName}@${body.version ?? 'latest'}' not found in catalog`);
        return;
      }
      const { res: updateRes, body: updateBody } = await fetchJson(
        artifact ? `${reg.agentUrl}/deploy` : `${reg.agentUrl}/api/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Node-Id': nodeId },
        body: JSON.stringify(artifact?.deploy ?? body),
        timeoutMs: 30_000,
      });
      if (!updateRes.ok) {
        replyError(res, 502, 'SERVICE_UNAVAILABLE', `Node update failed: HTTP ${updateRes.status}`, { node: updateBody });
        return;
      }
      if (artifact) {
        const resources = (store.get(nodeId) ?? []).filter(tool => tool.name !== artifact.toolName);
        resources.push({ name: artifact.toolName, version: artifact.version, type: 'tool', sha256: artifact.sha256 });
        store.set(nodeId, resources);
      }
      reg.lastSeenAt = new Date().toISOString();
      reply(res, 200, { nodeId, forwarded: true, artifact: artifact ? { toolName: artifact.toolName, version: artifact.version, sha256: artifact.sha256 } : undefined, node: updateBody });
      return;
    }

    const nodeRegMatch = urlPath.match(/^\/api\/nodes\/(.+)$/);
    if (nodeRegMatch) {
      const nodeId = decodeURIComponent(nodeRegMatch[1]);

      if (method === 'GET') {
        const reg = nodeRegistry.get(nodeId);
        if (!reg) {
          replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
          return;
        }
        reply(res, 200, { protocolVersion: PROTOCOL_VERSION, nodeId, ...reg, resources: store.get(nodeId) ?? [] });
        return;
      }

      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body?.agentUrl !== 'string' || !body.agentUrl) {
          replyError(res, 400, 'REQUEST_INVALID', '"agentUrl" (string) is required');
          return;
        }
        const channel = openNodeChannel(nodeId, body.agentUrl);
        nodeRegistry.set(nodeId, channel);
        reply(res, 200, { protocolVersion: PROTOCOL_VERSION, nodeId, ...channel, status: 'registered' });
        return;
      }

      if (method === 'DELETE') {
        if (!nodeRegistry.has(nodeId)) {
          replyError(res, 404, 'RESOURCE_NOT_FOUND', `Node '${nodeId}' not registered`);
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
        replyError(res, 400, 'REQUEST_INVALID', '"records" array is required');
        return;
      }
      const traceId = req.headers['x-trace-id'] ?? 'unknown';
      auditAnchors.push({
        anchoredAt: new Date().toISOString(),
        traceId,
        txHash: txHashFor('audit-anchor', { traceId, records: body.records }),
        records: body.records,
      });
      const anchor = auditAnchors[auditAnchors.length - 1];
      const blockHash = txHashFor('block', anchor.txHash);
      const blockNumber = blockchainBlockNumber++;
      Object.assign(anchor, {
        blockHash,
        blockNumber,
        contractAddress: process.env.FILE_PROTECTION_CONTRACT_ADDRESS ?? 'mock-file-protection-contract',
        chainId: Number(process.env.BLOCKCHAIN_CHAIN_ID ?? 31337),
      });
      reply(res, 200, {
        anchored: body.records.length,
        traceId,
        txHash: anchor.txHash,
        blockHash,
        blockNumber,
        contractAddress: anchor.contractAddress,
        chainId: anchor.chainId,
        mode: 'mock',
      });
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

    replyError(res, 404, 'RESOURCE_NOT_FOUND', `${method} ${urlPath} not found`);
  } catch (err) {
    replyError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  }
});

const PORT = process.env.PORT ?? 9090;
server.listen(PORT, () => {
  console.log(`[accounting] http://localhost:${PORT}`);
  console.log(`[accounting] nodes: ${[...store.keys()].join(', ')}`);
});
