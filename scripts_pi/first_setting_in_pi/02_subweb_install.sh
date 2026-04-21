#!/usr/bin/env bash
# =============================================================
# 02_subweb_install.sh — Sub-Web 安裝（Express.js）
# 執行：bash 02_subweb_install.sh
# =============================================================
set -euo pipefail

SUBWEB_DIR="/opt/hiba/subweb"
echo "[Sub-Web] 安裝 npm 依賴..."

cd "$SUBWEB_DIR"

# 建立 package.json
cat > package.json <<'EOF'
{
  "name": "hiba-subweb",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js" },
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5"
  }
}
EOF

# 建立 Sub-Web 主程式
cat > index.js <<'JSEOF'
const express = require('express');
const cors    = require('cors');
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const app        = express();
const NODE_ID    = process.env.NODE_ID    ?? 'unknown';
const SCRIPTS_DIR = process.env.SCRIPTS_DIR ?? './scripts';
const PORT       = parseInt(process.env.PORT ?? '3000');

app.use(cors());
app.use(express.json({ limit: '2mb' })); // 支援附加文件（上限 2 MB）

// ── GET /health ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    nodeId:  NODE_ID,
    status:  'online',
    uptime:  process.uptime(),
    version: '1.0.0',
    ts:      new Date().toISOString(),
  });
});

// ── GET /scripts ───────────────────────────────────────────
app.get('/scripts', (req, res) => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')
    );
    res.json({ nodeId: NODE_ID, scripts: manifest });
  } catch (e) {
    res.status(500).json({ error: 'manifest.json 讀取失敗', detail: e.message });
  }
});

// ── POST /execute ─────────────────────────────────────────
app.post('/execute', (req, res) => {
  const { scriptName, params: rawParams } = req.body;
  const params = Object.assign({}, rawParams);   // mutable copy
  const traceId = req.headers['x-trace-id'] ?? 'no-trace';
  const agentId = req.headers['x-agent-id'] ?? 'unknown';

  if (!scriptName) return res.status(400).json({ error: 'scriptName 必填' });

  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: `腳本不存在: ${scriptName}` });
  }

  // ── 附加文件處理 ───────────────────────────────────────────
  // 前端透過 params._attachment = { name, content } 傳送文件
  // 後端寫入 /tmp/hiba_uploads/ 後將路徑注入 params._filePath
  let tempFilePath = null;
  if (params._attachment) {
    try {
      const { name, content } = params._attachment;
      const safeName = path.basename(name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
      const uploadDir = '/tmp/hiba_uploads';
      fs.mkdirSync(uploadDir, { recursive: true });
      tempFilePath = path.join(uploadDir, `${traceId}_${safeName}`);
      fs.writeFileSync(tempFilePath, content, 'utf8');
      params._filePath = tempFilePath;   // Python 腳本讀取此路徑
      params._fileName = safeName;
      delete params._attachment;         // 不將原始內容傳給腳本（避免 argv 過長）
      console.log(`[${traceId}] Attachment → ${tempFilePath} (${content.length} chars)`);
    } catch (writeErr) {
      return res.status(500).json({ success: false, error: `附件寫入失敗: ${writeErr.message}` });
    }
  }

  console.log(`[${traceId}][${agentId}] Execute: ${scriptName}`, params);
  const startMs = Date.now();

  execFile('python3', [scriptPath, JSON.stringify(params ?? {})], (err, stdout, stderr) => {
    const durationMs = Date.now() - startMs;

    // ── 清除暫存附件 ───────────────────────────────────────────
    if (tempFilePath) { try { fs.unlinkSync(tempFilePath); } catch {} }

    if (err) {
      console.error(`[${traceId}] Error:`, stderr);
      return res.status(500).json({ success: false, error: stderr, durationMs });
    }
    try {
      const output = JSON.parse(stdout.trim());
      res.json({ success: true, output, executedAt: new Date().toISOString(), durationMs });
    } catch {
      res.json({ success: true, output: { raw: stdout.trim() }, executedAt: new Date().toISOString(), durationMs });
    }
  });
});

// ── POST /deploy ──────────────────────────────────────────
// type: 'script' → 寫入 SCRIPTS_DIR/{scriptName}.py，更新 manifest.json
// type: 'file'   → 寫入 SCRIPTS_DIR/ 或 DATA_DIR/，不動 manifest
app.post('/deploy', (req, res) => {
  const { type, content, overwrite } = req.body;
  const traceId = req.headers['x-trace-id'] ?? 'no-trace';

  if (!content) return res.status(400).json({ success: false, error: 'content 必填' });

  try {
    if (type === 'script') {
      // ── 腳本部署 ─────────────────────────────────────────
      const { scriptName, manifest: manifestEntry } = req.body;
      if (!scriptName || !/^[a-zA-Z0-9_]+$/.test(scriptName))
        return res.status(400).json({ success: false, error: 'scriptName 格式不正確（僅允許英數字與底線）' });

      const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
      if (fs.existsSync(scriptPath) && !overwrite)
        return res.status(409).json({ success: false, error: `腳本已存在，請勾選「允許覆蓋」` });

      fs.writeFileSync(scriptPath, content, 'utf8');
      console.log(`[${traceId}] Deploy script: ${scriptPath}`);

      // 更新 manifest.json
      let manifestUpdated = false;
      const manifestPath = path.join(SCRIPTS_DIR, 'manifest.json');
      if (manifestEntry) {
        try {
          let manifest = [];
          if (fs.existsSync(manifestPath))
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const idx = manifest.findIndex(m => m.name === scriptName);
          const entry = { name: scriptName, ...manifestEntry };
          if (idx >= 0) manifest[idx] = entry; else manifest.push(entry);
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          manifestUpdated = true;
        } catch (e) {
          console.warn(`[${traceId}] manifest 更新失敗: ${e.message}`);
        }
      }

      res.json({ success: true, type: 'script', scriptName, size: Buffer.byteLength(content, 'utf8'), manifestUpdated });

    } else if (type === 'file') {
      // ── 文件部署 ─────────────────────────────────────────
      const { fileName, targetDir } = req.body;
      if (!fileName || /[/\\<>:"|?*\x00-\x1f]/.test(fileName))
        return res.status(400).json({ success: false, error: 'fileName 含有不合法字元' });

      const DATA_DIR = process.env.DATA_DIR ?? path.join(SCRIPTS_DIR, '../data');
      const baseDir  = targetDir === 'data' ? DATA_DIR : SCRIPTS_DIR;
      fs.mkdirSync(baseDir, { recursive: true });

      const filePath = path.join(baseDir, path.basename(fileName));
      if (fs.existsSync(filePath) && !overwrite)
        return res.status(409).json({ success: false, error: `檔案已存在，請勾選「允許覆蓋」` });

      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`[${traceId}] Deploy file: ${filePath}`);

      res.json({ success: true, type: 'file', fileName: path.basename(fileName), path: filePath, size: Buffer.byteLength(content, 'utf8') });

    } else {
      res.status(400).json({ success: false, error: `未知的 type: ${type}，應為 'script' 或 'file'` });
    }
  } catch (e) {
    console.error(`[${traceId}] Deploy error:`, e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DELETE /deploy/:name ──────────────────────────────────
// 移除腳本（.py）或已部署的資料文件
app.delete('/deploy/:name', (req, res) => {
  const name = path.basename(req.params.name); // 防路徑穿越
  const traceId = req.headers['x-trace-id'] ?? 'no-trace';

  // 優先找 scripts 目錄，找不到再找 data 目錄
  const DATA_DIR = process.env.DATA_DIR ?? path.join(SCRIPTS_DIR, '../data');
  const candidates = [
    path.join(SCRIPTS_DIR, name),
    path.join(DATA_DIR, name),
  ];

  const found = candidates.find(p => fs.existsSync(p));
  if (!found) return res.status(404).json({ success: false, error: `找不到檔案: ${name}` });

  try {
    fs.unlinkSync(found);
    console.log(`[${traceId}] Removed: ${found}`);

    // 若是 .py，同步從 manifest 移除
    if (name.endsWith('.py')) {
      const scriptName = name.replace(/\.py$/, '');
      const manifestPath = path.join(SCRIPTS_DIR, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifest = manifest.filter(m => m.name !== scriptName);
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        } catch {}
      }
    }

    res.json({ success: true, removed: found });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /status/stream (SSE) ──────────────────────────────
app.get('/status/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('connected', { nodeId: NODE_ID, ts: new Date().toISOString() });

  const interval = setInterval(() => {
    send('heartbeat', { ts: new Date().toISOString(), uptime: process.uptime() });
  }, 5000);

  req.on('close', () => clearInterval(interval));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${NODE_ID}] Sub-Web running on :${PORT}`);
});
JSEOF

npm install --silent
echo "✓ Sub-Web 安裝完成"
echo "  下一步：bash 03_subweb_start.sh"
