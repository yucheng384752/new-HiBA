#!/usr/bin/env python3
"""
system.deployServer.py — Sub-Web 伺服器自部署腳本
將 sub_web_server.js 嵌入此 .py 內，單一檔案即可完成部署

使用方式（兩種情境皆適用）：

  [新系統] 剛跑完 00_setup.sh，或尚未有 node 服務：
    sudo python3 system.deployServer.py

  [舊系統加裝] 透過 Dashboard → Deploy → Script 模式推送此檔，
    再到 Scripts 分頁執行 system.deployServer（無需 sudo，
    若 /opt/hiba 已由 pi 所有則有寫入權限）：
    POST /execute { "scriptName": "system.deployServer", "params": {} }

輸入（選填）：
  { "hibaRoot": "/opt/hiba" }    ← 自訂安裝根目錄，預設 /opt/hiba

輸出：
  { "success": true, "steps": [...], "serverPath": "...", ... }
"""
import sys, json, os, subprocess, shutil

# ═══════════════════════════════════════════════════════════════
#  嵌入的 sub_web_server.js 內容
#  使用原始字串（r-string）避免反斜線跳脫問題
# ═══════════════════════════════════════════════════════════════
SERVER_JS = r"""#!/usr/bin/env node
'use strict';
/**
 * sub_web_server.js — Pi 端 Sub-Web 伺服器（完整 Tool Runtime）
 *
 * 三項關鍵 Tool 要素：
 *   ① Schema 驗證 (inputSchema) → SCHEMA_VALIDATION_ERROR
 *   ② AuditTrail SQLite (anchorResult) → audit_trail.db
 *   ③ Timeout 來自 manifest → execFile 使用 manifest.timeout
 *
 * 安裝依賴：npm install express better-sqlite3
 * 啟動：NODE_ID=m1 SCRIPTS_DIR=./scripts node sub_web_server.js
 */

const express    = require('express');
const { execFile, exec } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.warn('[AuditTrail] better-sqlite3 未安裝，執行: npm install better-sqlite3');
}

const app        = express();
app.use(express.json());

const NODE_ID     = process.env.NODE_ID    ?? 'unknown';
const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR ?? path.join(__dirname, 'scripts'));
const PORT        = parseInt(process.env.PORT ?? '3000');

// ── 啟動時確保必要目錄存在（新/舊系統皆安全）──
const DATA_DIR = path.resolve(SCRIPTS_DIR, '..', 'data');
for (const dir of [SCRIPTS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Init] 自動建立目錄: ${dir}`);
  }
}

// ── Manifest 載入 ──
const manifestPath = path.join(SCRIPTS_DIR, 'manifest.json');
let manifest = [];
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`[Manifest] 載入 ${manifest.length} 個 script`);
} catch (e) {
  console.warn(`[Manifest] 無法載入 ${manifestPath}:`, e.message);
}
const scriptMap = new Map(manifest.map(s => [s.name, s]));

// ── AuditTrail SQLite ──
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
  console.log(`[AuditTrail] SQLite 已就緒`);
}

function anchorResult(entry) {
  if (!insertAudit) return null;
  const raw  = `${entry.traceId}|${entry.toolName}|${entry.executedAt}|${entry.success}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  insertAudit.run({
    ...entry,
    success:   entry.success ? 1 : 0,
    errorMsg:  entry.errorMsg ?? null,
    phase:     entry.phase    ?? null,
    auditHash: hash,
  });
  return hash;
}

function validateInput(params, inputSchema) {
  if (!inputSchema) return [];
  const errors = [];
  for (const [key, def] of Object.entries(inputSchema)) {
    const val = params[key];
    if (def.required && (val === undefined || val === null || val === '')) {
      errors.push(`${key}: 必填欄位缺少`);
      continue;
    }
    if (val === undefined || val === null) continue;
    if (def.type) {
      const actual = Array.isArray(val) ? 'array' : typeof val;
      if (actual !== def.type) errors.push(`${key}: 型別應為 ${def.type}，實際為 ${actual}`);
    }
    if (def.enum && !def.enum.includes(val))
      errors.push(`${key}: 值 "${val}" 不在允許清單 [${def.enum.join(', ')}]`);
  }
  return errors;
}

// GET /health
app.get('/health', (_req, res) => {
  res.json({ nodeId: NODE_ID, status: 'online', uptime: process.uptime(),
             scripts: [...scriptMap.keys()], auditDb: db ? 'ready' : 'unavailable' });
});

// GET /scripts
app.get('/scripts', (_req, res) => {
  res.json({ nodeId: NODE_ID, scripts: manifest });
});

// POST /execute
app.post('/execute', (req, res) => {
  const { scriptName, params = {} } = req.body ?? {};
  const traceId = String(req.headers['x-trace-id'] ?? 'no-trace');
  const agentId = String(req.headers['x-agent-id'] ?? 'unknown');
  const depth   = Number(req.headers['x-depth']   ?? 0);
  console.log(`[${traceId}] Execute: ${scriptName}`);
  const meta = scriptMap.get(scriptName);
  if (!meta) return res.status(404).json({ success: false, error: 'TOOL_NOT_FOUND', scriptName });
  const validationErrors = validateInput(params, meta.inputSchema);
  if (validationErrors.length > 0)
    return res.status(400).json({ success: false, error: 'SCHEMA_VALIDATION_ERROR',
                                  scriptName, toolName: meta.toolName, violations: validationErrors });
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  if (!fs.existsSync(scriptPath))
    return res.status(404).json({ success: false, error: 'TOOL_NOT_FOUND', scriptName });
  const timeoutMs  = meta.timeout ?? 10000;
  const startMs    = Date.now();
  const executedAt = new Date().toISOString();
  execFile('python3', [scriptPath, JSON.stringify(params)],
    { timeout: timeoutMs, maxBuffer: 1024 * 512 },
    (err, stdout, stderr) => {
      const durationMs = Date.now() - startMs;
      if (err) {
        const isTimeout = err.killed || err.signal === 'SIGTERM';
        const errCode   = isTimeout ? 'TOOL_TIMEOUT' : 'EXECUTION_ERROR';
        const auditHash = anchorResult({ traceId, agentId, depth,
          toolName: meta.toolName ?? scriptName, toolDomain: meta.tags?.[0] ?? 'unknown',
          scriptName, version: meta.version ?? '1.0.0',
          success: false, durationMs, executedAt, errorMsg: errCode });
        return res.status(500).json({ success: false, error: errCode, scriptName,
                                      stderr: stderr || err.message, durationMs, auditHash });
      }
      let output;
      try { output = JSON.parse(stdout); } catch { output = { raw: stdout }; }
      const hints = [];
      if (output.transferOk === false) hints.push('空檔傳輸失敗（probe phase）');
      if (output.written    === false) hints.push('內容寫入失敗（write phase）');
      if (output.matched    === false) hints.push('回讀內容不一致（verify phase）');
      const ok = output.success !== false;
      const auditHash = anchorResult({ traceId, agentId, depth,
        toolName:   String(output.toolName  ?? meta.toolName  ?? scriptName),
        toolDomain: String(output.domain    ?? meta.tags?.[0] ?? 'unknown'),
        scriptName, version: String(output.version ?? meta.version ?? '1.0.0'),
        success: ok, durationMs, executedAt,
        errorMsg: hints.length ? hints.join('; ') : null,
        phase:    output.phase ? String(output.phase) : null });
      res.status(ok ? 200 : 500).json({ success: ok, output,
        hints: hints.length ? hints : undefined,
        scriptName, executedAt, durationMs, auditHash });
    });
});

// POST /deploy
app.post('/deploy', (req, res) => {
  const { type, content, overwrite = false } = req.body ?? {};
  if (!content) return res.status(400).json({ success: false, error: 'MISSING_CONTENT' });
  let destPath;
  if (type === 'script') {
    const rawName = req.body.scriptName;
    if (!rawName) return res.status(400).json({ success: false, error: 'MISSING_SCRIPT_NAME' });
    const safeName = path.basename(rawName.replace(/[^a-zA-Z0-9_]/g, '_'));
    destPath = path.join(SCRIPTS_DIR, `${safeName}.py`);
  } else {
    const rawName  = req.body.fileName;
    if (!rawName) return res.status(400).json({ success: false, error: 'MISSING_FILE_NAME' });
    const safeName  = path.basename(rawName);
    const tdRaw = req.body.targetDir ?? 'scripts';
    let baseDir;
    if (tdRaw === 'data') {
      baseDir = DATA_DIR;
    } else if (tdRaw === 'subweb') {
      baseDir = __dirname;
    } else {
      baseDir = SCRIPTS_DIR;
    }
    if (!fs.existsSync(baseDir)) {
      try { fs.mkdirSync(baseDir, { recursive: true }); }
      catch (e) { return res.status(500).json({ success: false, error: 'MKDIR_FAILED', detail: e.message }); }
    }
    destPath = path.join(baseDir, safeName);
  }
  const allowedRoot = path.resolve(SCRIPTS_DIR, '..');
  if (!destPath.startsWith(allowedRoot) && !destPath.startsWith(__dirname))
    return res.status(403).json({ success: false, error: 'PATH_TRAVERSAL_BLOCKED' });
  if (fs.existsSync(destPath) && !overwrite)
    return res.status(409).json({ success: false, error: 'FILE_EXISTS', path: destPath });
  try {
    fs.writeFileSync(destPath, content, 'utf-8');
    const stat = fs.statSync(destPath);
    console.log(`[Deploy] 寫入 ${destPath} (${stat.size} bytes)`);
    if (type === 'script' && req.body.manifest) {
      try {
        const m   = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const idx = m.findIndex(e => e.name === req.body.scriptName);
        const entry = { name: req.body.scriptName, ...req.body.manifest };
        if (idx >= 0) m[idx] = { ...m[idx], ...entry }; else m.push(entry);
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf-8');
        manifest.length = 0;
        m.forEach(s => { manifest.push(s); scriptMap.set(s.name, s); });
      } catch (e) { console.warn('[Deploy] manifest 更新失敗:', e.message); }
    }
    res.json({ success: true, path: destPath, sizeBytes: stat.size });
  } catch (e) {
    res.status(500).json({ success: false, error: 'WRITE_FAILED', detail: e.message });
  }
});

// DELETE /deploy/:name
app.delete('/deploy/:name', (req, res) => {
  const safeName = path.basename(decodeURIComponent(req.params.name));
  const candidates = [
    path.join(SCRIPTS_DIR, safeName),
    path.join(SCRIPTS_DIR, `${safeName}.py`),
    path.join(DATA_DIR, safeName),
  ];
  const target = candidates.find(p => fs.existsSync(p));
  if (!target) return res.status(404).json({ success: false, error: 'FILE_NOT_FOUND', name: safeName });
  try {
    fs.unlinkSync(target);
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

// POST /cmd
const CMD_ALLOWLIST = [
  /^ls(\s|$)/, /^pwd$/, /^df(\s|$)/, /^du(\s|$)/,
  /^ps(\s|$)/, /^free(\s|$)/, /^uptime$/, /^uname(\s|$)/,
  /^cat\s/,    /^head\s/,     /^tail\s/,  /^grep\s/,
  /^wc(\s|$)/, /^find\s/,     /^echo(\s|$)/, /^date$/,
  /^python3\s+--version$/, /^node\s+--version$/, /^which\s/,
  /^systemctl\s+status\s/,
];
app.post('/cmd', (req, res) => {
  const { command } = req.body ?? {};
  if (!command || typeof command !== 'string')
    return res.status(400).json({ success: false, error: 'MISSING_COMMAND' });
  const trimmed = command.trim();
  if (!CMD_ALLOWLIST.some(re => re.test(trimmed)))
    return res.status(403).json({ success: false, error: 'COMMAND_NOT_ALLOWED',
                                  command: trimmed, hint: '僅允許診斷類唯讀指令' });
  const startMs = Date.now();
  exec(trimmed, { timeout: 10000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
    res.json({ success: !err || err.code === 0, command: trimmed,
               stdout: stdout || '', stderr: stderr || '',
               exitCode: err?.code ?? 0, durationMs: Date.now() - startMs });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${NODE_ID}] Sub-Web 已啟動 :${PORT}`);
  console.log(`[Scripts]  ${SCRIPTS_DIR}`);
  console.log(`[Data]     ${DATA_DIR}`);
});
"""

# ═══════════════════════════════════════════════════════════════
#  package.json 內容
# ═══════════════════════════════════════════════════════════════
PACKAGE_JSON = """{
  "name": "hiba-subweb",
  "version": "1.0.0",
  "main": "sub_web_server.js",
  "scripts": { "start": "node sub_web_server.js" },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^9.4.3"
  }
}"""

# ═══════════════════════════════════════════════════════════════
#  systemd service 模板
# ═══════════════════════════════════════════════════════════════
SYSTEMD_UNIT = """[Unit]
Description=HiBA-AB Sub-Web Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory={subweb_dir}
EnvironmentFile={subweb_dir}/.env
ExecStart=/usr/bin/node {subweb_dir}/sub_web_server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:{hiba_root}/logs/subweb.log
StandardError=append:{hiba_root}/logs/subweb-err.log

[Install]
WantedBy=multi-user.target
"""

def run(cmd, cwd=None, timeout=120):
    """執行 shell 指令，回傳 (ok, stdout, stderr)"""
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout.strip(), r.stderr.strip()
    except Exception as e:
        return False, '', str(e)

def main():
    params    = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    hiba_root = params.get('hibaRoot', '/opt/hiba')

    subweb_dir  = os.path.join(hiba_root, 'subweb')
    scripts_dir = os.path.join(hiba_root, 'scripts')
    data_dir    = os.path.join(hiba_root, 'data')
    logs_dir    = os.path.join(hiba_root, 'logs')
    server_path = os.path.join(subweb_dir, 'sub_web_server.js')
    pkg_path    = os.path.join(subweb_dir, 'package.json')
    env_path    = os.path.join(subweb_dir, '.env')
    service_path = '/etc/systemd/system/hiba-subweb.service'

    steps   = []
    warnings = []

    # ── 1. 建立目錄 ─────────────────────────────────────────
    for d in [subweb_dir, scripts_dir, data_dir, logs_dir]:
        if not os.path.exists(d):
            os.makedirs(d, exist_ok=True)
            steps.append(f'mkdir {d}')
        else:
            steps.append(f'exist {d} ✓')

    # ── 2. 寫入 sub_web_server.js ───────────────────────────
    js_content = SERVER_JS.lstrip('\n').replace('\r\n', '\n')
    with open(server_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(js_content)
    steps.append(f'write {server_path} ({len(js_content)} bytes)')

    # ── 3. 寫入 package.json ────────────────────────────────
    with open(pkg_path, 'w', encoding='utf-8') as f:
        f.write(PACKAGE_JSON)
    steps.append(f'write {pkg_path}')

    # ── 4. npm install ──────────────────────────────────────
    ok, out, err = run(['npm', 'install', '--omit=dev', '--silent'], cwd=subweb_dir, timeout=180)
    if ok:
        steps.append('npm install ✓')
    else:
        warnings.append(f'npm install FAILED: {err}')
        steps.append('npm install FAILED (手動執行: npm install --omit=dev)')

    # ── 5. .env（若不存在才建，不覆蓋既有設定）──────────────
    node_id = params.get('nodeId', os.environ.get('NODE_ID', 'm1'))
    claw_url = params.get('clawUrl', os.environ.get('CLAW_URL', 'http://192.168.1.100:8080'))
    if not os.path.exists(env_path):
        with open(env_path, 'w') as f:
            f.write(f"NODE_ID={node_id}\n")
            f.write(f"CLAW_URL={claw_url}\n")
            f.write(f"SCRIPTS_DIR={scripts_dir}\n")
            f.write(f"DATA_DIR={data_dir}\n")
            f.write(f"AUDIT_DB={subweb_dir}/audit_trail.db\n")
            f.write(f"PORT=3000\n")
            f.write(f"LOG_DIR={logs_dir}\n")
        steps.append(f'write {env_path}')
    else:
        steps.append(f'exist {env_path} ✓ (未覆蓋)')

    # ── 6. systemd 服務（需要 root）──────────────────────────
    try:
        unit_content = SYSTEMD_UNIT.format(subweb_dir=subweb_dir, hiba_root=hiba_root)
        with open(service_path, 'w') as f:
            f.write(unit_content)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', 'hiba-subweb'])
        ok2, _, _ = run(['systemctl', 'is-active', 'hiba-subweb'])
        if ok2:
            run(['systemctl', 'restart', 'hiba-subweb'])
            steps.append('systemctl restart hiba-subweb ✓')
        else:
            run(['systemctl', 'start', 'hiba-subweb'])
            steps.append('systemctl start hiba-subweb ✓')
    except PermissionError:
        warnings.append('systemd 需要 root 權限，請手動執行: sudo systemctl restart hiba-subweb')
        steps.append('systemd: 跳過（無 root）')
    except Exception as e:
        warnings.append(f'systemd: {e}')

    print(json.dumps({
        "success":    True,
        "steps":      steps,
        "warnings":   warnings,
        "serverPath": server_path,
        "scriptsDir": scripts_dir,
        "dataDir":    data_dir,
        "nodeId":     node_id,
        "toolName":   "orchestrator.deployServer",
        "domain":     "orchestrator",
        "renderHint": "table",
    }, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
