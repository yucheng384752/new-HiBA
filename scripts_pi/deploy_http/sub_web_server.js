#!/usr/bin/env node
'use strict';
/**
 * sub_web_server.js — Pi 端 Sub-Web 伺服器（完整 Tool Runtime）
 *
 * 三項關鍵 Tool 要素：
 *   ① Schema 驗證 (inputSchema) → SCHEMA_VALIDATION_ERROR
 *   ② AuditTrail SQLite (anchorResult) → audit_trail.db
 *   ③ Timeout 來自 manifest → execFile 使用 manifest.timeout
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const NODE_ID    = process.env.NODE_ID    ?? 'unknown';
const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR ?? path.join(__dirname, 'scripts'));
const PORT       = parseInt(process.env.PORT ?? '3000');

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
const scriptMap = new Map(manifest.map(s => [s.name, s]));
/** @type {Map<string, string>} toolName → scriptName */
const toolNameToScript = new Map(manifest.map(s => [s.toolName, s.name]));

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
/**
 * 依 manifest inputSchema 驗證 params
 * @returns {string[]} errors 陣列（空陣列 = 驗證通過）
 */
function validateInput(params, inputSchema) {
  if (!inputSchema) return [];
  const errors = [];
  for (const [key, def] of Object.entries(inputSchema)) {
    const val = params[key];
    // required 檢查
    if (def.required && (val === undefined || val === null || val === '')) {
      errors.push(`${key}: 必填欄位缺少`);
      continue;
    }
    // 略過未提供的選填欄位
    if (val === undefined || val === null) continue;
    // type 檢查
    if (def.type) {
      const actual = Array.isArray(val) ? 'array' : typeof val;
      if (actual !== def.type) {
        errors.push(`${key}: 型別應為 ${def.type}，實際為 ${actual}`);
      }
    }
    // enum 檢查
    if (def.enum && !def.enum.includes(val)) {
      errors.push(`${key}: 值 "${val}" 不在允許清單 [${def.enum.join(', ')}]`);
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
  const scriptName = meta.name;
  console.log(`[${traceId}] Execute: ${scriptName}`, params);

  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ success: false, error: 'TOOL_NOT_FOUND', scriptName });
  }

  const timeoutMs  = meta.timeout ?? 10000;
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
          toolName:   meta.toolName   ?? scriptName,
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
        toolName:   String(output.toolName  ?? meta.toolName   ?? scriptName),
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
      scriptName, toolName: meta.toolName, violations: validationErrors,
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
      toolName, scriptName: meta.name, violations: validationErrors,
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
        const idx = m.findIndex(e => e.name === req.body.scriptName);
        const entry = { name: req.body.scriptName, ...req.body.manifest };
        if (idx >= 0) m[idx] = { ...m[idx], ...entry };
        else m.push(entry);
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf-8');
        // 重新載入 scriptMap
        manifest.length = 0;
        m.forEach(s => { manifest.push(s); scriptMap.set(s.name, s); });
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
      const idx = manifest.findIndex(e => e.name === scriptBase);
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${NODE_ID}] Sub-Web 已啟動 :${PORT}`);
  console.log(`[Scripts]  ${SCRIPTS_DIR}`);
});
