#!/usr/bin/env node
'use strict';
/**
 * sub_web_server.js — Pi 端 Sub-Web 伺服器（完整 Tool Runtime）
 *
 * 三項關鍵 Tool 要素：
 *   ① Schema 驗證 (inputSchema) → SCHEMA_VALIDATION_ERROR
 *   ② AuditTrail SQLite (anchorResult) → audit_trail.db
 *   ③ Timeout 來自 ToolSpec → execFile 使用 timeoutMs
 *
 * 安裝依賴：
 *   npm install express better-sqlite3
 *
 * 啟動：
 *   NODE_ID=m1 SCRIPTS_DIR=./scripts node sub_web_server.js
 */

const express    = require('express');
const { execFile, exec } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

// ── better-sqlite3（選用，缺少時 AuditTrail 降級為 console.warn）──
let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.warn('[AuditTrail] better-sqlite3 未安裝，執行: npm install better-sqlite3');
}

// ── 設定 ──────────────────────────────────────────────────────────
const app        = express();
app.use(express.json());

// CORS: allow requests from file:// and any origin (dashboard runs as local HTML)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth, X-Registration-Token');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const NODE_ID    = process.env.NODE_ID    ?? 'unknown';
const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR ?? path.join(__dirname, 'scripts'));
const PORT       = parseInt(process.env.PORT ?? '3000');
const ACCOUNTING_URL = (process.env.ACCOUNTING_URL ?? '').replace(/\/$/, '');
const AGENT_URL = (process.env.AGENT_URL ?? '').replace(/\/$/, '');
const CHILD_REGISTRATION_TOKEN = process.env.CHILD_REGISTRATION_TOKEN ?? '';
const HIBA_RELAY_TOKEN = process.env.HIBA_RELAY_TOKEN ?? '';
const PARENT_URL = (process.env.PARENT_URL ?? '').replace(/\/$/, '');
const ATTESTATION_MODE = process.env.ATTESTATION_MODE ?? 'none';
const CHILD_POLL_MS = 15_000;
const CHILD_TASK_TIMEOUT_MS = 28_000;
const childSessions = new Map();
const pendingChildTasks = new Map();

function childTokenMatches(value) {
  if (!CHILD_REGISTRATION_TOKEN || typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(CHILD_REGISTRATION_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function childAuthorized(req, res) {
  if (childTokenMatches(req.get('X-Registration-Token'))) return true;
  res.status(CHILD_REGISTRATION_TOKEN ? 401 : 503).json({
    success: false,
    errorCode: CHILD_REGISTRATION_TOKEN ? 'UNAUTHORIZED' : 'REGISTRATION_DISABLED',
    error: CHILD_REGISTRATION_TOKEN ? 'Invalid registration token' : 'CHILD_REGISTRATION_TOKEN is not configured',
  });
  return false;
}

// ── 啟動時確保必要目錄存在 ────────────────────────────────────────
// 同時處理：新系統（00_setup.sh 剛跑完）與舊系統加裝（目錄可能缺）
const DATA_DIR = path.resolve(SCRIPTS_DIR, '..', 'data');
for (const dir of [SCRIPTS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Init] 自動建立目錄: ${dir}`);
  }
}

// ── Manifest 載入（啟動時讀一次，快速查詢）───────────────────────
const manifestPath = path.join(SCRIPTS_DIR, 'manifest.json');
let manifest = [];
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`[Manifest] 載入 ${manifest.length} 個 script`);
} catch (e) {
  console.error(`[Manifest] 無法載入 ${manifestPath}:`, e.message);
}
/** @type {Map<string, object>} scriptName → manifest entry */
const scriptMap = new Map(manifest.map(s => [s.scriptName, s]));
/** @type {Map<string, string>} toolName → scriptName */
const toolNameToScript = new Map(manifest.map(s => [s.name, s.scriptName]));

// ── ① AuditTrail SQLite ──────────────────────────────────────────
let db = null;
let insertAudit = null;

if (Database) {
  const dbPath = process.env.AUDIT_DB ?? path.resolve('./audit_trail.db');
  db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tool_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id    TEXT    NOT NULL,
      agent_id    TEXT    NOT NULL,
      depth       INTEGER DEFAULT 0,
      tool_name   TEXT    NOT NULL,
      tool_domain TEXT    NOT NULL,
      script_name TEXT    NOT NULL,
      version     TEXT    DEFAULT '1.0.0',
      success     INTEGER NOT NULL,
      duration_ms INTEGER,
      executed_at TEXT    NOT NULL,
      error_msg   TEXT,
      phase       TEXT,
      audit_hash  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_trace ON tool_audit_log (trace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_tool  ON tool_audit_log (tool_name);
  `);
  insertAudit = db.prepare(`
    INSERT INTO tool_audit_log
      (trace_id,agent_id,depth,tool_name,tool_domain,script_name,
       version,success,duration_ms,executed_at,error_msg,phase,audit_hash)
    VALUES
      (@traceId,@agentId,@depth,@toolName,@toolDomain,@scriptName,
       @version,@success,@durationMs,@executedAt,@errorMsg,@phase,@auditHash)
  `);
  console.log(`[AuditTrail] SQLite 已就緒：${dbPath}`);
}

function anchorResult(entry) {
  if (!insertAudit) {
    console.warn('[AuditTrail] 跳過錨定（better-sqlite3 未安裝）');
    return null;
  }
  const raw  = `${entry.traceId}|${entry.toolName}|${entry.executedAt}|${entry.success}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  insertAudit.run({
    ...entry,
    success:  entry.success ? 1 : 0,
    errorMsg: entry.errorMsg ?? null,
    phase:    entry.phase    ?? null,
    auditHash: hash,
  });
  return hash;
}

// ── ① Schema 驗證 ─────────────────────────────────────────────────
function validateInput(params, schema) {
  if (!schema) return [];
  if (schema.type === 'object' && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    return ['input: 型別應為 object'];
  }

  const errors = [];
  const required = new Set(schema.required ?? []);
  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    const value = params[key];
    if (required.has(key) && (value === undefined || value === null || value === '')) {
      errors.push(`${key}: 必填欄位缺少`);
      continue;
    }
    if (value === undefined || value === null) continue;

    if (def.type) {
      const actual = Array.isArray(value) ? 'array' : typeof value;
      const allowed = Array.isArray(def.type) ? def.type : [def.type];
      const integer = actual === 'number' && allowed.includes('integer') && Number.isInteger(value);
      if (!allowed.includes(actual) && !integer) {
        errors.push(`${key}: 型別應為 ${def.type}，實際為 ${actual}`);
      }
    }
    if (def.enum && !def.enum.includes(value)) {
      errors.push(`${key}: 值 "${value}" 不在允許清單 [${def.enum.join(', ')}]`);
    }
  }
  return errors;
}

// ── 端點實作 ──────────────────────────────────────────────────────

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    nodeId:  NODE_ID,
    status:  'online',
    uptime:  process.uptime(),
    scripts: [...scriptMap.keys()],
    auditDb: db ? 'ready' : 'unavailable',
  });
});

// GET /scripts
app.get('/scripts', (_req, res) => {
  res.json({ nodeId: NODE_ID, scripts: manifest });
});

// The child only opens outbound HTTP requests. Accounting sees this parent relay URL.
app.post('/children/connect', async (req, res) => {
  if (!childAuthorized(req, res)) return;
  if (!AGENT_URL || !HIBA_RELAY_TOKEN) {
    res.status(503).json({ success: false, errorCode: 'RELAY_DISABLED', error: 'AGENT_URL and HIBA_RELAY_TOKEN are required' });
    return;
  }
  const { nodeId, scripts = [], attestationMode = 'none' } = req.body ?? {};
  if (typeof nodeId !== 'string' || !nodeId.trim() || nodeId === NODE_ID || !Array.isArray(scripts)) {
    res.status(400).json({ success: false, errorCode: 'REQUEST_INVALID', error: 'nodeId and scripts are required' });
    return;
  }
  if (!['tpm2', 'software', 'demo', 'none'].includes(attestationMode)) {
    res.status(400).json({ success: false, errorCode: 'REQUEST_INVALID', error: 'attestationMode is invalid' });
    return;
  }
  const resources = scripts.map(tool => ({
    name: tool.name ?? tool.toolName,
    version: tool.version ?? '1.0.0',
    type: 'tool',
    ...(tool.metadata ? { metadata: tool.metadata } : {}),
  })).filter(tool => tool.name);
  const previous = childSessions.get(nodeId);
  const session = {
    nodeId, scripts, resources, attestationMode,
    lastSeenAt: Date.now(), lastHeartbeatAt: 0,
    queue: previous?.queue ?? [], waiter: null,
  };
  if (previous?.waiter) {
    clearTimeout(previous.waiter.timer);
    previous.waiter.res.json({ task: null, reconnect: true });
  }
  childSessions.set(nodeId, session);

  res.status(202).json({ success: true, nodeId, parentNodeId: NODE_ID, routeType: 'parent-relay', connectionStatus: 'pending_approval', tpmVerified: false });
});

app.get('/children/registrations', (req, res) => {
  const supplied = String(req.get('X-Parent-Registration-Token') ?? '');
  const expected = Buffer.from(HIBA_RELAY_TOKEN);
  const actual = Buffer.from(supplied);
  if (!HIBA_RELAY_TOKEN || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    res.status(401).json({ success: false, errorCode: 'UNAUTHORIZED', error: 'Invalid relay token' });
    return;
  }
  res.json({
    nodeId: NODE_ID,
    children: [...childSessions.values()].map(child => ({
      nodeId: child.nodeId,
      parentNodeId: NODE_ID,
      routeType: 'parent-relay',
      relayUrl: `${AGENT_URL}/children/${encodeURIComponent(child.nodeId)}`,
      status: Date.now() - child.lastSeenAt < 35_000 ? 'online' : 'offline',
      lastSeenAt: new Date(child.lastSeenAt).toISOString(),
      attestationMode: child.attestationMode,
      tpmVerified: false,
      resources: child.resources,
    })),
  });
});

app.post('/children/poll', (req, res) => {
  if (!childAuthorized(req, res)) return;
  const session = childSessions.get(req.body?.nodeId);
  if (!session) {
    res.status(409).json({ success: false, errorCode: 'SESSION_NOT_FOUND', error: 'Child must register again' });
    return;
  }
  session.lastSeenAt = Date.now();
  if (session.queue.length) {
    res.json({ task: session.queue.shift() });
    return;
  }
  if (session.waiter) {
    clearTimeout(session.waiter.timer);
    session.waiter.res.json({ task: null, replaced: true });
  }
  const timer = setTimeout(() => {
    if (session.waiter?.res === res) session.waiter = null;
    res.json({ task: null });
  }, CHILD_POLL_MS);
  session.waiter = { res, timer };
  res.on('close', () => {
    if (!res.writableEnded && session.waiter?.res === res) {
      clearTimeout(timer);
      session.waiter = null;
    }
  });

});

app.post('/children/result', (req, res) => {
  if (!childAuthorized(req, res)) return;
  const { nodeId, taskId, statusCode = 200, body } = req.body ?? {};
  const pending = pendingChildTasks.get(taskId);
  if (!pending || pending.nodeId !== nodeId) {
    res.status(404).json({ success: false, errorCode: 'TASK_NOT_FOUND', error: 'Relay task is no longer pending' });
    return;
  }
  clearTimeout(pending.timer);
  pendingChildTasks.delete(taskId);
  pending.res.status(Number.isInteger(statusCode) ? statusCode : 200).json(body);
  res.json({ success: true, taskId });
});

app.get('/children/:nodeId/health', (req, res) => {
  const session = childSessions.get(req.params.nodeId);
  if (!session) {
    res.status(404).json({ nodeId: req.params.nodeId, status: 'offline', parentNodeId: NODE_ID });
    return;
  }
  res.json({ nodeId: session.nodeId, status: Date.now() - session.lastSeenAt < 35_000 ? 'online' : 'offline', parentNodeId: NODE_ID, routeType: 'parent-relay' });
});

app.get('/children/:nodeId/scripts', (req, res) => {
  const session = childSessions.get(req.params.nodeId);
  if (!session) { res.status(404).json({ nodeId: req.params.nodeId, scripts: [] }); return; }
  res.json({ nodeId: session.nodeId, scripts: session.scripts, parentNodeId: NODE_ID });
});

function relayChildPost(path) {
  return (req, res) => {
  const session = childSessions.get(req.params.nodeId);
  if (!session || Date.now() - session.lastSeenAt >= 35_000) {
    res.status(503).json({ success: false, errorCode: 'NODE_OFFLINE', error: `Child '${req.params.nodeId}' has no active reverse channel`, retryable: true });
    return;
  }
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    path,
    body: req.body,
    headers: {
      'X-Agent-Id': req.get('X-Agent-Id') ?? 'parent-relay',
      'X-Trace-Id': req.get('X-Trace-Id') ?? `relay-${taskId}`,
      'X-Step-Id': req.get('X-Step-Id') ?? '',
      'X-Depth': req.get('X-Depth') ?? '0',
    },
  };
  const timer = setTimeout(() => {
    if (!pendingChildTasks.delete(taskId)) return;
    res.status(504).json({ success: false, errorCode: 'TOOL_TIMEOUT', error: `Child '${session.nodeId}' did not return task '${taskId}'`, retryable: true });
  }, CHILD_TASK_TIMEOUT_MS);
  pendingChildTasks.set(taskId, { nodeId: session.nodeId, res, timer });
  res.on('close', () => {
    const pending = pendingChildTasks.get(taskId);
    if (!res.writableEnded && pending?.res === res) { clearTimeout(timer); pendingChildTasks.delete(taskId); }
  });
  if (session.waiter) {
    clearTimeout(session.waiter.timer);
    const waiter = session.waiter;
    session.waiter = null;
    waiter.res.json({ task });
  } else {
    session.queue.push(task);
  }
  };
}

app.post('/children/:nodeId/api/execute', relayChildPost('/api/execute'));
app.post('/children/:nodeId/execute', relayChildPost('/execute'));

// ── 核心執行邏輯（/execute 與 /api/execute 共用）──────────────────
/**
 * @param {object} meta      manifest entry（已驗證存在）
 * @param {object} params    輸入參數（已通過 schema 驗證）
 * @param {string} traceId
 * @param {string} agentId
 * @param {number} depth
 * @param {import('express').Response} res
 */
function doExecute(meta, params, traceId, agentId, depth, res) {
  const scriptName = meta.scriptName;
  console.log(`[${traceId}] Execute: ${scriptName}`, params);

  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ success: false, error: 'TOOL_NOT_FOUND', scriptName });
  }

  const timeoutMs  = meta.timeoutMs ?? 10000;
  const startMs    = Date.now();
  const executedAt = new Date().toISOString();

  execFile(
    'python3',
    [scriptPath, JSON.stringify(params)],
    { timeout: timeoutMs, maxBuffer: 1024 * 512 },
    (err, stdout, stderr) => {
      const durationMs = Date.now() - startMs;

      if (err) {
        const isTimeout = err.killed || err.signal === 'SIGTERM';
        const errCode   = isTimeout ? 'TOOL_TIMEOUT' : 'EXECUTION_ERROR';
        const auditHash = anchorResult({
          traceId, agentId, depth,
          toolName:   meta.name       ?? scriptName,
          toolDomain: meta.tags?.[0]  ?? 'unknown',
          scriptName, version: meta.version ?? '1.0.0',
          success: false, durationMs, executedAt,
          errorMsg: errCode,
        });
        return res.status(500).json({
          success: false, error: errCode, scriptName,
          stderr: stderr || err.message, durationMs, auditHash,
        });
      }

      let output;
      try { output = JSON.parse(stdout); }
      catch { output = { raw: stdout }; }

      const hints = [];
      if (output.transferOk === false) hints.push('空檔傳輸失敗（probe phase）');
      if (output.written    === false) hints.push('內容寫入失敗（write phase）');
      if (output.matched    === false) hints.push('回讀內容不一致（verify phase）');

      const ok = output.success !== false;
      const auditHash = anchorResult({
        traceId, agentId, depth,
        toolName:   String(output.toolName  ?? meta.name       ?? scriptName),
        toolDomain: String(output.domain    ?? meta.tags?.[0]  ?? 'unknown'),
        scriptName, version: String(output.version ?? meta.version ?? '1.0.0'),
        success: ok, durationMs, executedAt,
        errorMsg: hints.length ? hints.join('; ') : null,
        phase:    output.phase ? String(output.phase) : null,
      });

      res.status(ok ? 200 : 500).json({
        success: ok, output,
        hints:   hints.length ? hints : undefined,
        scriptName, executedAt, durationMs, auditHash,
      });
    }
  );
}

// POST /execute — 原始格式（scriptName + params）
app.post('/execute', (req, res) => {
  const { scriptName, params = {} } = req.body ?? {};
  const traceId = String(req.headers['x-trace-id'] ?? 'no-trace');
  const agentId = String(req.headers['x-agent-id'] ?? 'unknown');
  const depth   = Number(req.headers['x-depth']   ?? 0);

  const meta = scriptMap.get(scriptName);
  if (!meta) {
    return res.status(404).json({ success: false, error: 'TOOL_NOT_FOUND', scriptName });
  }
  const validationErrors = validateInput(params, meta.inputSchema);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      success: false, error: 'SCHEMA_VALIDATION_ERROR',
      scriptName, toolName: meta.name, violations: validationErrors,
    });
  }
  doExecute(meta, params, traceId, agentId, depth, res);
});

// POST /api/execute — AgentServer/OrchestratorRunner 格式（toolName + input）
app.post('/api/execute', (req, res) => {
  const { toolName, input = {} } = req.body ?? {};
  const traceId = String(req.headers['x-trace-id'] ?? 'no-trace');
  const agentId = String(req.headers['x-agent-id'] ?? 'unknown');
  const depth   = Number(req.headers['x-depth']   ?? 0);

  if (!toolName) {
    return res.status(400).json({ success: false, errorCode: 'MISSING_TOOL_NAME' });
  }
  const scriptName = toolNameToScript.get(toolName);
  const meta = scriptName ? scriptMap.get(scriptName) : null;
  if (!meta) {
    return res.status(404).json({
      success: false, errorCode: 'TOOL_NOT_FOUND',
      error: `No script registered for toolName '${toolName}'`,
    });
  }
  const validationErrors = validateInput(input, meta.inputSchema);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      success: false, errorCode: 'SCHEMA_VALIDATION_ERROR',
      toolName, scriptName: meta.scriptName, violations: validationErrors,
    });
  }
  doExecute(meta, input, traceId, agentId, depth, res);
});

// ── /deploy 端點 ──────────────────────────────────────────────────
// POST /deploy — 接收腳本或資料檔案，自動建立目標目錄
app.post('/deploy', (req, res) => {
  const { type, content, overwrite = false } = req.body ?? {};

  if (!content) {
    return res.status(400).json({ success: false, error: 'MISSING_CONTENT' });
  }

  let destPath;
  if (type === 'script') {
    // Script 模式：寫入 SCRIPTS_DIR
    const rawName  = req.body.scriptName;
    if (!rawName) return res.status(400).json({ success: false, error: 'MISSING_SCRIPT_NAME' });
    const safeName = path.basename(rawName.replace(/[^a-zA-Z0-9_]/g, '_'));
    destPath = path.join(SCRIPTS_DIR, `${safeName}.py`);
  } else {
    // File 模式：依 targetDir 決定目錄
    const rawName   = req.body.fileName;
    if (!rawName) return res.status(400).json({ success: false, error: 'MISSING_FILE_NAME' });
    const safeName  = path.basename(rawName);
    // targetDir 支援：scripts / data / subweb
    const tdRaw  = req.body.targetDir ?? 'scripts';
    let baseDir;
    if (tdRaw === 'data') {
      baseDir = DATA_DIR;
    } else if (tdRaw === 'subweb') {
      baseDir = __dirname;   // sub_web_server.js 所在目錄 (/opt/hiba/subweb)
    } else {
      baseDir = SCRIPTS_DIR; // 預設 scripts/
    }
    // 確保目錄存在（自動 mkdir）
    if (!fs.existsSync(baseDir)) {
      try { fs.mkdirSync(baseDir, { recursive: true }); }
      catch (e) {
        return res.status(500).json({ success: false, error: 'MKDIR_FAILED', detail: e.message });
      }
    }
    destPath = path.join(baseDir, safeName);
  }

  // 防止路徑穿越（允許根目錄下所有合法子目錄）
  const allowedRoot = path.resolve(SCRIPTS_DIR, '..');
  if (!destPath.startsWith(allowedRoot) && !destPath.startsWith(__dirname)) {
    return res.status(403).json({ success: false, error: 'PATH_TRAVERSAL_BLOCKED' });
  }

  if (fs.existsSync(destPath) && !overwrite) {
    return res.status(409).json({ success: false, error: 'FILE_EXISTS', path: destPath });
  }

  try {
    fs.writeFileSync(destPath, content, 'utf-8');
    const stat = fs.statSync(destPath);
    console.log(`[Deploy] 寫入 ${destPath} (${stat.size} bytes)`);

    // Script 模式：同步更新 manifest（若有附帶 manifest entry）
    if (type === 'script' && req.body.manifest) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const idx = m.findIndex(e => e.scriptName === req.body.scriptName);
        const entry = { ...req.body.manifest, scriptName: req.body.scriptName };
        if (idx >= 0) m[idx] = { ...m[idx], ...entry };
        else m.push(entry);
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf-8');
        // 重新載入 scriptMap
        manifest.length = 0;
        scriptMap.clear();
        toolNameToScript.clear();
        m.forEach(s => {
          manifest.push(s);
          scriptMap.set(s.scriptName, s);
          toolNameToScript.set(s.name, s.scriptName);
        });
      } catch (e) {
        console.warn('[Deploy] manifest 更新失敗:', e.message);
      }
    }

    res.json({ success: true, path: destPath, sizeBytes: stat.size });
  } catch (e) {
    res.status(500).json({ success: false, error: 'WRITE_FAILED', detail: e.message });
  }
});

// DELETE /deploy/:name — 移除腳本或資料檔案
app.delete('/deploy/:name', (req, res) => {
  const safeName = path.basename(decodeURIComponent(req.params.name));
  // 嘗試 scripts/ 和 data/ 兩個位置
  const candidates = [
    path.join(SCRIPTS_DIR, safeName),
    path.join(SCRIPTS_DIR, `${safeName}.py`),
    path.join(path.resolve(SCRIPTS_DIR, '..', 'data'), safeName),
  ];
  const target = candidates.find(p => fs.existsSync(p));
  if (!target) {
    return res.status(404).json({ success: false, error: 'FILE_NOT_FOUND', name: safeName });
  }
  try {
    fs.unlinkSync(target);
    console.log(`[Deploy] 刪除 ${target}`);
    // 若為腳本，從 scriptMap 移除
    const scriptBase = path.basename(target, '.py');
    if (scriptMap.has(scriptBase)) {
      scriptMap.delete(scriptBase);
      const idx = manifest.findIndex(e => e.scriptName === scriptBase);
      if (idx >= 0) manifest.splice(idx, 1);
    }
    res.json({ success: true, path: target });
  } catch (e) {
    res.status(500).json({ success: false, error: 'DELETE_FAILED', detail: e.message });
  }
});

// POST /cmd — Shell 診斷指令（白名單限制）
const CMD_ALLOWLIST = [
  /^ls(\s|$)/, /^pwd$/, /^df(\s|$)/, /^du(\s|$)/,
  /^ps(\s|$)/, /^free(\s|$)/, /^uptime$/, /^uname(\s|$)/,
  /^cat\s/,    /^head\s/,    /^tail\s/,  /^grep\s/,
  /^wc(\s|$)/, /^find\s/,    /^echo(\s|$)/, /^date$/,
  /^python3\s+--version$/, /^node\s+--version$/, /^which\s/,
  /^systemctl\s+status\s/,
];

app.post('/cmd', (req, res) => {
  const { command } = req.body ?? {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, error: 'MISSING_COMMAND' });
  }
  const trimmed = command.trim();
  const allowed = CMD_ALLOWLIST.some(re => re.test(trimmed));
  if (!allowed) {
    return res.status(403).json({
      success: false, error: 'COMMAND_NOT_ALLOWED',
      command: trimmed, hint: '僅允許診斷類唯讀指令',
    });
  }
  const startMs = Date.now();
  exec(trimmed, { timeout: 10000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
    res.json({
      success:  !err || err.code === 0,
      command:  trimmed,
      stdout:   stdout || '',
      stderr:   stderr || '',
      exitCode: err?.code ?? 0,
      durationMs: Date.now() - startMs,
    });
  });
});

// ── 啟動 ──────────────────────────────────────────────────────────
async function runReverseChannel() {
  let registered = false;
  while (true) {
    try {
      if (!registered) {
        const response = await fetch(`${PARENT_URL}/children/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Registration-Token': CHILD_REGISTRATION_TOKEN },
          body: JSON.stringify({ nodeId: NODE_ID, scripts: manifest, attestationMode: ATTESTATION_MODE }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`register HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        registered = true;
        console.log(`[Relay] registered ${NODE_ID} through ${PARENT_URL}`);
      }

      const poll = await fetch(`${PARENT_URL}/children/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Registration-Token': CHILD_REGISTRATION_TOKEN },
        body: JSON.stringify({ nodeId: NODE_ID }),
        signal: AbortSignal.timeout(CHILD_POLL_MS + 5_000),
      });
      if (poll.status === 409) { registered = false; continue; }
      if (!poll.ok) throw new Error(`poll HTTP ${poll.status}`);
      const { task } = await poll.json();
      if (!task) continue;

      let statusCode = 500;
      let body = { success: false, errorCode: 'HANDLER_EXECUTION_FAILED', error: 'Child execution failed' };
      try {
        const local = await fetch(`http://127.0.0.1:${PORT}${task.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(task.headers ?? {}) },
          body: JSON.stringify(task.body ?? {}),
          signal: AbortSignal.timeout(CHILD_TASK_TIMEOUT_MS),
        });
        statusCode = local.status;
        const text = await local.text();
        try { body = text ? JSON.parse(text) : {}; }
        catch { body = { success: false, errorCode: 'HANDLER_EXECUTION_FAILED', error: text.slice(0, 2_000) }; }
      } catch (error) {
        body.error = error.message;
      }
      const result = await fetch(`${PARENT_URL}/children/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Registration-Token': CHILD_REGISTRATION_TOKEN },
        body: JSON.stringify({ nodeId: NODE_ID, taskId: task.taskId, statusCode, body }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok && result.status !== 404) throw new Error(`result HTTP ${result.status}`);
    } catch (error) {
      console.warn(`[Relay] ${error.message}; retrying`);
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
}

async function registerWithAccounting() {
  if (!ACCOUNTING_URL || !AGENT_URL) return;
  try {
    const response = await fetch(`${ACCOUNTING_URL}/api/nodes/${encodeURIComponent(NODE_ID)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentUrl: AGENT_URL,
        canInstall: true,
        resources: manifest.map(tool => ({ name: tool.name, version: tool.version ?? '1.0.0', type: 'tool' })),
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`[Accounting] registered at ${ACCOUNTING_URL}`);
  } catch (error) {
    console.warn(`[Accounting] registration failed: ${error.message}`);
  }
}

async function heartbeatAccounting() {
  if (!ACCOUNTING_URL) return;
  try {
    const response = await fetch(`${ACCOUNTING_URL}/api/nodes/${encodeURIComponent(NODE_ID)}/heartbeat`, { method: 'POST' });
    if (response.status === 404) await registerWithAccounting();
  } catch { /* next heartbeat retries */ }
}

app.listen(PORT, '0.0.0.0', () => {
  if (PARENT_URL) {
    void runReverseChannel();
  } else {
    void registerWithAccounting();
    setInterval(heartbeatAccounting, 10_000).unref();
  }
  console.log(`[${NODE_ID}] Sub-Web 已啟動 :${PORT}`);
  console.log(`[Scripts]  ${SCRIPTS_DIR}`);
});
