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
 *
 *   GET    /api/facilities                     → facility index (?nodeIds= for reverse lookup)
 *   POST   /api/facilities                     → create a new facility file
 *   GET    /api/facilities/:facilityId         → full facility document (?status= to filter edges)
 *   POST   /api/facilities/:facilityId/stations       → upsert a station
 *   POST   /api/facilities/:facilityId/edges          → manual edge, immediately approved
 *   POST   /api/facilities/:facilityId/edges/suggest  → AuditTrail-inferred edge (suggested; upgrade-guarded)
 *   POST   /api/facilities/:facilityId/edges/approve  → approve a suggested edge (requires X-User-Id)
 *
 *   GET    /health                     → { status }
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const HIBA_RELAY_TOKEN = process.env.HIBA_RELAY_TOKEN ?? '';
const catalogDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts_pi', 'deploy_http', 'scripts');

// ── 場域拓樸（facilities）──────────────────────────────────────────────────────
// 真實來源是 hiba-core/facilities/<facilityId>.json，人工編輯、git 追蹤。這裡
// 不維護另一份索引檔——每次需要「全部場域清單」時直接 readdirSync 這個目錄，
// 檔案本身就是登錄表，避免重蹈這個 repo 清理過的「複本各自漂移」覆轍。
// 見 hiba-core/facilities/README.md。
const facilitiesDir = process.env.FACILITIES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'facilities');
const TOPOLOGY_RELATIONS = ['upstream_of', 'downstream_of', 'backup_for', 'same_line'];
const FACILITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** facilityId → { doc, mtimeMs } —— 只在檔案 mtime 改變時才重新 JSON.parse */
const facilityCache = new Map();

/** @type {Array<{anchoredAt: string, traceId: string, records: unknown[]}>} */
const auditAnchors = [];

/** @type {Map<string, unknown>} */
const blockchainFiles = new Map();
let blockchainBlockNumber = 1;

// ── Helpers ───────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth, X-User-Id, X-Parent-Registration-Token, X-Node-Approval-Token',
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

function tokenMatches(value) {
  if (!HIBA_RELAY_TOKEN || typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(HIBA_RELAY_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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

let syncingRelayChildren = false;
async function syncRelayChildren() {
  if (syncingRelayChildren || !HIBA_RELAY_TOKEN) return;
  syncingRelayChildren = true;
  try {
    const parents = [...nodeRegistry.entries()].filter(([, reg]) => reg.agentUrl && !reg.parentNodeId && nodeStatus(reg) === 'online');
    await Promise.all(parents.map(async ([parentNodeId, parent]) => {
      try {
        const { res, body } = await fetchJson(`${parent.agentUrl}/children/registrations`, {
          headers: { 'X-Parent-Registration-Token': HIBA_RELAY_TOKEN }, timeoutMs: 4_000,
        });
        if (!res.ok || body?.nodeId !== parentNodeId || !Array.isArray(body?.children)) return;
        for (const child of body.children) {
          if (typeof child?.nodeId !== 'string' || !child.nodeId || child.nodeId === parentNodeId || child.parentNodeId !== parentNodeId) continue;
          const existing = nodeRegistry.get(child.nodeId);
          const agentUrl = `${parent.agentUrl}/children/${encodeURIComponent(child.nodeId)}`;
          const lastSeenAt = child.status === 'online'
            ? new Date().toISOString()
            : typeof child.lastSeenAt === 'string' && Number.isFinite(Date.parse(child.lastSeenAt))
              ? child.lastSeenAt : new Date().toISOString();
          nodeRegistry.set(child.nodeId, {
            agentUrl,
            registeredAt: existing?.registeredAt ?? new Date().toISOString(),
            lastSeenAt,
            status: child.status === 'online' ? 'online' : 'offline',
            connectionId: existing?.connectionId ?? sha256Hex(`${child.nodeId}:${agentUrl}:${Date.now()}`).slice(0, 16),
            canInstall: false,
            parentNodeId,
            routeType: 'parent-relay',
            connectionStatus: existing?.connectionStatus === 'approved' ? 'approved' : 'pending_approval',
            attestationMode: ['tpm2', 'software', 'demo', 'none'].includes(child.attestationMode) ? child.attestationMode : 'none',
            tpmVerified: false,
          });
          if (Array.isArray(child.resources)) store.set(child.nodeId, child.resources);
        }
      } catch { /* parent may not support relay discovery yet */ }
    }));
  } finally {
    syncingRelayChildren = false;
  }
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
  if (reg.connectionStatus === 'pending_approval') return 'offline';
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

// ── 場域拓樸 helpers ─────────────────────────────────────────────────────────

function isValidFacilityId(id) {
  return typeof id === 'string' && FACILITY_ID_RE.test(id);
}

function facilityPath(facilityId) {
  return join(facilitiesDir, `${facilityId}.json`);
}

function listFacilityIds() {
  if (!existsSync(facilitiesDir)) return [];
  return readdirSync(facilitiesDir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .filter(isValidFacilityId);
}

function loadFacility(facilityId) {
  const path = facilityPath(facilityId);
  if (!existsSync(path)) return null;
  const mtimeMs = statSync(path).mtimeMs;
  const cached = facilityCache.get(facilityId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.doc;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  facilityCache.set(facilityId, { doc, mtimeMs });
  return doc;
}

function saveFacility(facilityId, doc) {
  doc.updatedAt = new Date().toISOString();
  const path = facilityPath(facilityId);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  facilityCache.set(facilityId, { doc, mtimeMs: statSync(path).mtimeMs });
}

function newFacilityDoc(facilityId, name, processDescription) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    facilityId,
    name,
    processDescription: processDescription ?? '',
    stations: [],
    edges: [],
    updatedAt: now,
  };
}

function facilityIndexEntries(nodeIdFilter) {
  const filterSet = nodeIdFilter && nodeIdFilter.length > 0 ? new Set(nodeIdFilter) : null;
  const entries = [];
  for (const facilityId of listFacilityIds()) {
    const doc = loadFacility(facilityId);
    if (!doc) continue;
    const stations = doc.stations.map(s => ({ stationId: s.stationId, nodeId: s.nodeId, name: s.name }));
    if (filterSet && !stations.some(s => s.nodeId && filterSet.has(s.nodeId))) continue;
    entries.push({ facilityId: doc.facilityId, name: doc.name, stations });
  }
  return entries;
}

function edgeKey(e) {
  return JSON.stringify([e.fromStationId, e.relation, e.toStationId]);
}

function findEdge(doc, input) {
  const key = edgeKey(input);
  return doc.edges.find(e => edgeKey(e) === key) ?? null;
}

function validateEdgeInput(doc, body) {
  if (typeof body?.fromStationId !== 'string' || !body.fromStationId) return '"fromStationId" is required';
  if (typeof body?.toStationId !== 'string' || !body.toStationId) return '"toStationId" is required';
  if (!TOPOLOGY_RELATIONS.includes(body?.relation)) return `"relation" must be one of ${TOPOLOGY_RELATIONS.join(', ')}`;
  if (!doc.stations.some(s => s.stationId === body.fromStationId)) return `Unknown fromStationId '${body.fromStationId}'`;
  if (!doc.stations.some(s => s.stationId === body.toStationId)) return `Unknown toStationId '${body.toStationId}'`;
  return null;
}

function upsertStation(doc, input) {
  const existing = doc.stations.find(s => s.stationId === input.stationId);
  const station = {
    stationId: input.stationId,
    name: input.name ?? existing?.name ?? input.stationId,
    nodeId: input.nodeId ?? existing?.nodeId ?? null,
    description: input.description ?? existing?.description ?? '',
    metadata: input.metadata ?? existing?.metadata ?? {},
  };
  if (existing) Object.assign(existing, station);
  else doc.stations.push(station);
  return station;
}

/** source='manual' 搭配 forcedStatus='approved' 對應舊 upsertManual()；
 *  source='audit_trail_inference' 搭配 forcedStatus=undefined 對應舊 suggest()
 *  ——已經是 approved 的邊不會被 suggest 降級回 suggested。 */
function upsertEdge(doc, input, source, forcedStatus) {
  const existing = findEdge(doc, input);
  const status = forcedStatus ?? (existing?.status === 'approved' ? 'approved' : 'suggested');
  const edge = {
    fromStationId: input.fromStationId,
    relation: input.relation,
    toStationId: input.toStationId,
    lineId: input.lineId ?? existing?.lineId ?? null,
    status,
    source,
    metadata: input.metadata ?? existing?.metadata ?? {},
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, edge);
  else doc.edges.push(edge);
  return edge;
}

function approveEdge(doc, input) {
  const existing = findEdge(doc, input ?? {});
  if (!existing) return null;
  existing.status = 'approved';
  existing.updatedAt = new Date().toISOString();
  return existing;
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
      await syncRelayChildren();
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
        parentNodeId: reg.parentNodeId ?? null,
        connectionStatus: reg.connectionStatus ?? 'approved',
        attestationMode: reg.attestationMode ?? null,
        tpmVerified: reg.tpmVerified ?? null,
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
      let agentUrl;
      try {
        agentUrl = new URL(body.agentUrl);
        if (!['http:', 'https:'].includes(agentUrl.protocol)) throw new Error('unsupported protocol');
      } catch {
        replyError(res, 400, 'REQUEST_INVALID', '"agentUrl" must be an HTTP(S) URL');
        return;
      }

      const parentNodeId = body.parentNodeId;
      const forwarded = parentNodeId !== undefined;
      const attestationMode = body.attestationMode ?? 'none';
      if (forwarded && (typeof parentNodeId !== 'string' || !parentNodeId || parentNodeId === nodeId)) {
        replyError(res, 400, 'REQUEST_INVALID', '"parentNodeId" must identify a different node');
        return;
      }
      if (forwarded && !['tpm2', 'software', 'demo', 'none'].includes(attestationMode)) {
        replyError(res, 400, 'REQUEST_INVALID', '"attestationMode" is invalid');
        return;
      }
      if (forwarded && !tokenMatches(req.headers['x-parent-registration-token'])) {
        replyError(res, HIBA_RELAY_TOKEN ? 401 : 503, HIBA_RELAY_TOKEN ? 'UNAUTHORIZED' : 'REGISTRATION_DISABLED', HIBA_RELAY_TOKEN ? 'Invalid parent registration token' : 'HIBA_RELAY_TOKEN is not configured');
        return;
      }

      const { res: healthRes, body: health } = await fetchJson(`${agentUrl.toString().replace(/\/$/, '')}/health`);
      if (!healthRes.ok) {
        replyError(res, 502, 'NODE_OFFLINE', `Node health check failed: HTTP ${healthRes.status}`);
        return;
      }
      if (health?.nodeId !== nodeId) {
        replyError(res, 409, 'NODE_IDENTITY_MISMATCH', `Node health reports '${health?.nodeId ?? 'unknown'}', expected '${nodeId}'`);
        return;
      }

      let resources = Array.isArray(body.resources) ? body.resources : null;
      let canInstall = body.canInstall === true;
      if (!resources) {
        const scripts = await fetchJson(`${agentUrl.toString().replace(/\/$/, '')}/scripts`).catch(() => null);
        if (scripts?.res.ok && Array.isArray(scripts.body?.scripts)) {
          resources = scripts.body.scripts.map(tool => ({ name: tool.name, version: tool.version ?? '1.0.0', type: 'tool' }));
          canInstall = true;
        }
      }
      if (resources) store.set(nodeId, resources);

      const channel = {
        ...openNodeChannel(nodeId, agentUrl.toString().replace(/\/$/, '')),
        canInstall,
        ...(forwarded ? {
          parentNodeId,
          connectionStatus: nodeRegistry.get(nodeId)?.connectionStatus === 'approved' ? 'approved' : 'pending_approval',
          attestationMode,
          routeType: body.routeType === 'parent-relay' ? 'parent-relay' : 'forwarded',
          // Forwarded claims are never sufficient to prove TPM ownership.
          tpmVerified: false,
        } : {}),
      };
      nodeRegistry.set(nodeId, channel);
      reply(res, 200, {
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        ...channel,
        status: nodeStatus(channel),
        health,
        endpoints: {
          heartbeat: `/api/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
          update: `/api/nodes/${encodeURIComponent(nodeId)}/update`,
        },
      });
      return;
    }

    const nodeApproveMatch = urlPath.match(/^\/api\/nodes\/([^/]+)\/approve$/);
    if (method === 'POST' && nodeApproveMatch) {
      if (!tokenMatches(req.headers['x-node-approval-token'])) {
        replyError(res, HIBA_RELAY_TOKEN ? 401 : 503, HIBA_RELAY_TOKEN ? 'UNAUTHORIZED' : 'APPROVAL_DISABLED', HIBA_RELAY_TOKEN ? 'Invalid node approval token' : 'HIBA_RELAY_TOKEN is not configured');
        return;
      }
      const nodeId = decodeURIComponent(nodeApproveMatch[1]);
      const reg = nodeRegistry.get(nodeId);
      if (!reg?.parentNodeId) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Forwarded node '${nodeId}' not registered`);
        return;
      }
      reg.connectionStatus = 'approved';
      reply(res, 200, { protocolVersion: PROTOCOL_VERSION, nodeId, ...reg, status: nodeStatus(reg) });
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
      if (reg.parentNodeId && !tokenMatches(req.headers['x-parent-registration-token'])) {
        replyError(res, 401, 'UNAUTHORIZED', 'Invalid parent registration token');
        return;
      }
      reg.lastSeenAt = new Date().toISOString();
      reg.status = 'online';
      reply(res, 200, { nodeId, ...reg, status: nodeStatus(reg) });
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
        reply(res, 200, { protocolVersion: PROTOCOL_VERSION, nodeId, ...reg, status: nodeStatus(reg), resources: store.get(nodeId) ?? [] });
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

    // GET /api/facilities?nodeIds=a,b,c → facility index / reverse lookup
    if (method === 'GET' && urlPath === '/api/facilities') {
      const params = new URLSearchParams(qs ?? '');
      const nodeIdsParam = params.get('nodeIds');
      const nodeIds = nodeIdsParam ? nodeIdsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
      reply(res, 200, facilityIndexEntries(nodeIds));
      return;
    }

    // POST /api/facilities → create a new facility file
    if (method === 'POST' && urlPath === '/api/facilities') {
      const body = await readBody(req);
      if (!isValidFacilityId(body?.facilityId)) {
        replyError(res, 400, 'REQUEST_INVALID', '"facilityId" must match ^[a-z0-9][a-z0-9_-]{0,63}$');
        return;
      }
      if (typeof body?.name !== 'string' || !body.name.trim()) {
        replyError(res, 400, 'REQUEST_INVALID', '"name" is required');
        return;
      }
      if (existsSync(facilityPath(body.facilityId))) {
        replyError(res, 409, 'RESOURCE_CONFLICT', `Facility '${body.facilityId}' already exists`);
        return;
      }
      const doc = newFacilityDoc(body.facilityId, body.name, body.processDescription);
      saveFacility(body.facilityId, doc);
      reply(res, 201, doc);
      return;
    }

    // GET /api/facilities/:facilityId?status=approved|suggested
    const facilityMatch = urlPath.match(/^\/api\/facilities\/([^/]+)$/);
    if (method === 'GET' && facilityMatch) {
      const facilityId = decodeURIComponent(facilityMatch[1]);
      const doc = loadFacility(facilityId);
      if (!doc) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Facility '${facilityId}' not found`);
        return;
      }
      const params = new URLSearchParams(qs ?? '');
      const status = params.get('status');
      if (status && status !== 'approved' && status !== 'suggested') {
        replyError(res, 400, 'REQUEST_INVALID', '"status" must be "approved" or "suggested"');
        return;
      }
      reply(res, 200, status ? { ...doc, edges: doc.edges.filter(e => e.status === status) } : doc);
      return;
    }

    // POST /api/facilities/:facilityId/stations → upsert a station
    const stationMatch = urlPath.match(/^\/api\/facilities\/([^/]+)\/stations$/);
    if (method === 'POST' && stationMatch) {
      const facilityId = decodeURIComponent(stationMatch[1]);
      const doc = loadFacility(facilityId);
      if (!doc) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Facility '${facilityId}' not found`);
        return;
      }
      const body = await readBody(req);
      if (typeof body?.stationId !== 'string' || !body.stationId.trim() || typeof body?.name !== 'string' || !body.name.trim()) {
        replyError(res, 400, 'REQUEST_INVALID', '"stationId" and "name" are required');
        return;
      }
      const station = upsertStation(doc, body);
      saveFacility(facilityId, doc);
      reply(res, 200, station);
      return;
    }

    // POST /api/facilities/:facilityId/edges → manual edge, immediately approved
    const edgeMatch = urlPath.match(/^\/api\/facilities\/([^/]+)\/edges$/);
    if (method === 'POST' && edgeMatch) {
      const facilityId = decodeURIComponent(edgeMatch[1]);
      const doc = loadFacility(facilityId);
      if (!doc) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Facility '${facilityId}' not found`);
        return;
      }
      const body = await readBody(req);
      const validationError = validateEdgeInput(doc, body);
      if (validationError) {
        replyError(res, 400, 'REQUEST_INVALID', validationError);
        return;
      }
      const edge = upsertEdge(doc, body, 'manual', 'approved');
      saveFacility(facilityId, doc);
      reply(res, 200, edge);
      return;
    }

    // POST /api/facilities/:facilityId/edges/suggest → AuditTrail-inferred edge
    const edgeSuggestMatch = urlPath.match(/^\/api\/facilities\/([^/]+)\/edges\/suggest$/);
    if (method === 'POST' && edgeSuggestMatch) {
      const facilityId = decodeURIComponent(edgeSuggestMatch[1]);
      const doc = loadFacility(facilityId);
      if (!doc) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Facility '${facilityId}' not found`);
        return;
      }
      const body = await readBody(req);
      const validationError = validateEdgeInput(doc, body);
      if (validationError) {
        replyError(res, 400, 'REQUEST_INVALID', validationError);
        return;
      }
      const edge = upsertEdge(doc, body, 'audit_trail_inference', undefined);
      saveFacility(facilityId, doc);
      reply(res, 200, edge);
      return;
    }

    // POST /api/facilities/:facilityId/edges/approve
    const edgeApproveMatch = urlPath.match(/^\/api\/facilities\/([^/]+)\/edges\/approve$/);
    if (method === 'POST' && edgeApproveMatch) {
      const facilityId = decodeURIComponent(edgeApproveMatch[1]);
      const doc = loadFacility(facilityId);
      if (!doc) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Facility '${facilityId}' not found`);
        return;
      }
      const approvedBy = req.headers['x-user-id'];
      if (!approvedBy || !String(approvedBy).trim()) {
        replyError(res, 400, 'REQUEST_INVALID', 'X-User-Id header is required');
        return;
      }
      const body = await readBody(req);
      const edge = approveEdge(doc, body);
      if (!edge) {
        replyError(res, 404, 'RESOURCE_NOT_FOUND', `Edge '${body?.fromStationId} --${body?.relation}--> ${body?.toStationId}' not found`);
        return;
      }
      saveFacility(facilityId, doc);
      reply(res, 200, { ...edge, approvedBy });
      return;
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
  void syncRelayChildren();
  setInterval(syncRelayChildren, 5_000).unref();
  console.log(`[accounting] http://localhost:${PORT}`);
  console.log(`[accounting] nodes: ${[...store.keys()].join(', ')}`);
});
