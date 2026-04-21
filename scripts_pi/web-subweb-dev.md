# Claw ↔ Sub-Web 開發文件
> 對應白板架構：User 動作指令 → Claw → M1/M2/M3（腳本 + sub web）

---

## 零、責任分離原則

### Orchestrator（Claw 主控端）的責任
| 責任 | 說明 |
|------|------|
| 意圖分析 | LLM1/LLM2 解析使用者指令，決定派給哪個節點 / 腳本 |
| 多步驟流程編排 | 決定何時呼叫 probe（空檔驗證），何時呼叫 write（實際寫入） |
| SignedTask 建立 | 加上 taskId / traceId，確保可追蹤 |
| 結果解讀與渲染 | 讀取 `output.phase`、`output.transferOk`、`output.matched`，決定是否繼續下一步或報錯 |
| 節點健康管理 | NodeRegistry 心跳，標記 online / offline |
| 重試策略 | 判斷失敗原因後決定是否重試，Sub-Web 不做重試 |

### Sub-Web（Pi 端伺服器）的責任
| 責任 | 說明 |
|------|------|
| 請求接收與基本驗證 | 確認 `scriptName` 對應的 `.py` 檔案存在於磁碟 |
| 腳本執行 | `execFile('python3', ...)` 執行腳本，計時 `durationMs` |
| 輸出結構化回傳 | 將腳本的 stdout JSON 包裝後回傳，附上 `executedAt`、`durationMs` |
| HTTP 狀態對應 | `output.success === false` → HTTP 500，讓呼叫端能直接判斷 |
| Phase 提示提取 | 從 output 中提取 `transferOk`/`matched` 失敗狀態，附加 `hints[]` |
| **不負責** | 多步驟編排、重試邏輯、流程狀態管理 — 這些是 Orchestrator 的責任 |

---

## 一、整體架構

```
┌─────────────────────────────────────────────────────────┐
│                    主控端 (Main Web)                      │
│                                                          │
│   User Trigger ──→ Claw Controller                       │
│                      ├── LLM1（分析 / 工單排列）           │
│                      └── LLM2（VLM / 影像觸發）           │
│                                                          │
│   功能：(1) 工單集排列  (2) 派工  (3) 腳本執行  (4) Web    │
└───────────────┬─────────────────────────────────────────┘
                │  HTTP REST  (dispatch SignedTask)
      ┌─────────┼──────────────────┐
      ↓         ↓                  ↓
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Sub Web1 │ │ Sub Web2 │ │ Sub Web3 │   ← 各 Raspberry Pi
│          │ │          │ │          │
│ 腳本 1   │ │ 腳本 2   │ │ 腳本 3   │
│ M1 機台  │ │ M2 機台  │ │ M3 機台  │
└──────────┘ └──────────┘ └──────────┘
```

**核心原則**：腳本 = 各 function 動作 → 定義 function I/O & Interface → output 渲染到 Web

---

## 二、Sub-Web 標準介面規範

每個 Raspberry Pi 上的 Sub-Web 必須實作以下四個端點：

### 2.1 健康檢查
```http
GET /health
Response 200:
{
  "nodeId": "m1",
  "status": "online",
  "scripts": ["script_1", "script_2"],
  "uptime": 3600
}
```

### 2.2 取得腳本清單（對應 ToolRegistry）
```http
GET /scripts
Response 200:
{
  "nodeId": "m1",
  "scripts": [
    {
      "name": "script_1",
      "description": "工單執行腳本",
      "inputSchema": {
        "orderId": { "type": "string", "required": true },
        "quantity": { "type": "number", "required": true }
      },
      "outputSchema": {
        "success": { "type": "boolean" },
        "result": { "type": "string" }
      }
    }
  ]
}
```

### 2.3 執行腳本（核心端點）
```http
POST /execute
Headers:
  X-Trace-Id: {taskId}-{stepId}
  X-Agent-Id: {agentId}
  X-Depth:    {depth}

Body:
{
  "scriptName": "script_1",
  "params": {
    "orderId": "WO-2026-001",
    "quantity": 100
  }
}

Response 200:
{
  "success": true,
  "output": { ... },        ← 腳本執行結果
  "renderHint": "table",    ← 前端渲染提示（table / chart / status / text）
  "executedAt": "2026-04-10T10:00:00Z",
  "durationMs": 234
}
```

### 2.4 取得最新執行狀態（SSE 串流）
```http
GET /status/stream
Content-Type: text/event-stream

event: progress
data: {"step": "executing", "percent": 60}

event: done
data: {"success": true, "output": {...}}
```

---

## 三、Claw 主控端實作

### 3.1 節點登錄（啟動時自動發現）

```typescript
// node-registry.ts
interface SubWebNode {
  nodeId: string;
  url: string;          // e.g. http://192.168.1.101:3000
  scripts: ScriptMeta[];
  lastSeen: Date;
  status: 'online' | 'offline';
}

class NodeRegistry {
  private nodes = new Map<string, SubWebNode>();

  async register(nodeId: string, url: string) {
    const res = await fetch(`${url}/health`);
    const health = await res.json();
    const scripts = await this.fetchScripts(url);
    this.nodes.set(nodeId, { nodeId, url, scripts, lastSeen: new Date(), status: 'online' });
  }

  async heartbeat() {
    // 每 30 秒檢查所有節點
    for (const [id, node] of this.nodes) {
      try {
        await fetch(`${node.url}/health`, { signal: AbortSignal.timeout(3000) });
        node.status = 'online';
        node.lastSeen = new Date();
      } catch {
        node.status = 'offline';
      }
    }
  }
}
```

### 3.2 工單派工（Dispatch）

```typescript
// dispatcher.ts
async function dispatch(intent: string, params: Record<string, unknown>) {
  // Step 1: LLM1 分析意圖，決定派到哪個節點 + 哪個腳本
  const plan = await llm1.analyze({
    intent,
    availableNodes: registry.getOnlineNodes(),
  });
  // plan = { nodeId: "m1", scriptName: "script_1", params: {...} }

  // Step 2: 建立 SignedTask
  const task = {
    taskId: crypto.randomUUID(),
    nodeId: plan.nodeId,
    scriptName: plan.scriptName,
    params: plan.params,
    timestamp: Date.now(),
  };

  // Step 3: 送出到對應 Sub-Web
  const node = registry.get(plan.nodeId);
  const res = await fetch(`${node.url}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': `${task.taskId}-step-001`,
      'X-Agent-Id': 'claw-orchestrator',
      'X-Depth': '1',
    },
    body: JSON.stringify({
      scriptName: task.scriptName,
      params: task.params,
    }),
  });

  const result = await res.json();
  return result;
}
```

### 3.3 前端渲染（依 renderHint 自動切換）

```typescript
// ResultRenderer.tsx
function ResultRenderer({ result }: { result: ExecuteResult }) {
  switch (result.renderHint) {
    case 'table':
      return <DataTable data={result.output} />;
    case 'chart':
      return <LineChart data={result.output} />;
    case 'status':
      return <StatusLight value={result.output.success} />;
    default:
      return <pre>{JSON.stringify(result.output, null, 2)}</pre>;
  }
}
```

---

## 四、AuditTrail 模組（SQLite）

> 對應 [[部署架構決策]]：AuditTrail 本地儲存於 SQLite，稽核雜湊選擇性上鏈。

```typescript
// sub-web/audit-trail.ts
import Database from 'better-sqlite3';
import crypto   from 'crypto';
import path     from 'path';

const DB_PATH = path.resolve(process.env.AUDIT_DB ?? './audit_trail.db');
const db      = new Database(DB_PATH);

// 初始化：依 audit_trail.sql schema 建表（WAL 模式）
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
  CREATE INDEX IF NOT EXISTS idx_audit_trace_id  ON tool_audit_log (trace_id);
  CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON tool_audit_log (tool_name);
`);

const insertStmt = db.prepare(`
  INSERT INTO tool_audit_log
    (trace_id, agent_id, depth, tool_name, tool_domain, script_name,
     version, success, duration_ms, executed_at, error_msg, phase, audit_hash)
  VALUES
    (@traceId, @agentId, @depth, @toolName, @toolDomain, @scriptName,
     @version, @success, @durationMs, @executedAt, @errorMsg, @phase, @auditHash)
`);

export interface AuditEntry {
  traceId:    string;
  agentId:    string;
  depth:      number;
  toolName:   string;   // canonical: {domain}.{verbObject}
  toolDomain: string;
  scriptName: string;
  version:    string;
  success:    boolean;
  durationMs: number;
  executedAt: string;
  errorMsg?:  string;
  phase?:     string;
}

export function anchorResult(entry: AuditEntry): string {
  const raw  = `${entry.traceId}|${entry.toolName}|${entry.executedAt}|${entry.success}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  insertStmt.run({
    ...entry,
    success:   entry.success ? 1 : 0,
    errorMsg:  entry.errorMsg  ?? null,
    phase:     entry.phase     ?? null,
    auditHash: hash,
  });

  return hash;   // 回傳給 Orchestrator，供選擇性上鏈
}
```

---

## 五、Sub-Web 標準實作（Express.js + Node.js）

```typescript
// sub-web/index.ts — 放到每個 Raspberry Pi

import express from 'express';
import { execFile, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { anchorResult } from './audit-trail';

const app = express();
app.use(express.json());

const NODE_ID     = process.env.NODE_ID    ?? 'unknown';
const SCRIPTS_DIR = path.resolve('./scripts');

// GET /health
app.get('/health', (req, res) => {
  res.json({ nodeId: NODE_ID, status: 'online', uptime: process.uptime() });
});

// GET /scripts
app.get('/scripts', async (req, res) => {
  const manifest = await import(`${SCRIPTS_DIR}/manifest.json`, { assert: { type: 'json' } });
  res.json({ nodeId: NODE_ID, scripts: manifest.default });
});

// POST /execute
app.post('/execute', async (req, res) => {
  const { scriptName, params } = req.body;
  const traceId = req.headers['x-trace-id'] ?? 'no-trace';

  console.log(`[${traceId}] Execute: ${scriptName}`, params);

  // [Sub-Web 責任] 驗證腳本檔案是否存在（不存在立即報 404，不執行）
  const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.py`);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({
      success: false,
      error: `腳本不存在: ${scriptName}`,
      scriptName,
    });
  }

  const startMs = Date.now();

  execFile('python3', [scriptPath, JSON.stringify(params ?? {})], (err, stdout, stderr) => {
    const durationMs = Date.now() - startMs;

    // [Sub-Web 責任] 腳本 crash（exit code != 0）→ 500
    if (err) {
      return res.status(500).json({
        success: false,
        error: stderr || err.message,
        scriptName,
        durationMs,
      });
    }

    let output: Record<string, unknown>;
    try {
      output = JSON.parse(stdout);
    } catch {
      // stdout 非 JSON，包裝為 raw
      output = { raw: stdout };
    }

    // [Sub-Web 責任] 從 output 提取 phase hints，輔助 Orchestrator 解讀失敗位置
    const hints: string[] = [];
    if (output.transferOk === false) hints.push('空檔傳輸失敗（probe phase）');
    if (output.written   === false) hints.push('內容寫入失敗（write phase）');
    if (output.matched   === false) hints.push('回讀內容不一致（verify phase）');

    // [Sub-Web 責任] output.success 決定 HTTP status，讓 Orchestrator 可用 res.ok 快速判斷
    const httpStatus = output.success === false ? 500 : 200;
    const executedAt = new Date().toISOString();

    // [Sub-Web 責任] AuditTrail 錨定（對應 HiBA-AB AuditTrail.anchorResult()）
    const auditHash = anchorResult({
      traceId:    String(traceId),
      agentId:    String(req.headers['x-agent-id'] ?? 'unknown'),
      depth:      Number(req.headers['x-depth'] ?? 0),
      toolName:   String(output.toolName  ?? scriptName),   // 腳本輸出的正式 toolName
      toolDomain: String(output.domain    ?? 'unknown'),    // 腳本輸出的 domain
      scriptName,
      version:    String(output.version   ?? '1.0.0'),
      success:    output.success !== false,
      durationMs,
      executedAt,
      errorMsg:   hints.length ? hints.join('; ') : undefined,
      phase:      output.phase ? String(output.phase) : undefined,
    });

    res.status(httpStatus).json({
      success:    output.success !== false,
      output,
      hints:      hints.length ? hints : undefined,
      scriptName,
      executedAt,
      durationMs,
      auditHash,   // 回傳給 Orchestrator，供選擇性上鏈
    });
  });
});

// POST /cmd — Shell 指令執行（僅供開發 / 診斷用）
// 對應 Dashboard Curl tab 的 Shell 模式
const CMD_ALLOWLIST = [
  /^ls(\s|$)/, /^pwd$/, /^df(\s|$)/, /^du(\s|$)/,
  /^ps(\s|$)/, /^free(\s|$)/, /^uptime$/, /^uname(\s|$)/,
  /^cat\s/, /^head\s/, /^tail\s/, /^grep\s/, /^wc(\s|$)/,
  /^find\s/, /^echo(\s|$)/, /^date$/,
  /^python3\s+--version$/, /^node\s+--version$/, /^which\s/,
];

app.post('/cmd', (req, res) => {
  const { command } = req.body ?? {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, error: 'MISSING_COMMAND' });
  }

  const trimmed = command.trim();

  // 白名單安全檢查
  const allowed = CMD_ALLOWLIST.some(re => re.test(trimmed));
  if (!allowed) {
    return res.status(403).json({
      success:  false,
      error:    'COMMAND_NOT_ALLOWED',
      command:  trimmed,
      hint:     '僅允許診斷類指令（ls / df / ps / cat / grep …）',
    });
  }

  const startMs = Date.now();
  exec(trimmed, { timeout: 10000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
    const durationMs = Date.now() - startMs;
    res.json({
      success:   !err || err.code === 0,
      command:   trimmed,
      stdout:    stdout || '',
      stderr:    stderr || '',
      exitCode:  err?.code ?? 0,
      durationMs,
    });
  });
});

app.listen(3000, '0.0.0.0', () => {
  console.log(`[${NODE_ID}] Sub-Web listening on :3000`);
});
```

---

## 五、腳本格式規範

每個腳本：
- **輸入**：從 `sys.argv[1]` 讀取 JSON 字串
- **輸出**：`print(json.dumps(result))` 到 stdout
- **錯誤**：`sys.exit(1)` + 訊息到 stderr

```python
# scripts/script_1.py — 工單執行腳本範例
import sys, json

def main():
    params = json.loads(sys.argv[1])
    order_id = params["orderId"]
    quantity = params["quantity"]

    # 執行邏輯...
    result = {
        "success": True,
        "orderId": order_id,
        "processed": quantity,
        "renderHint": "table"
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()
```

```json
// scripts/manifest.json — 腳本清單（對應 ToolRegistry 概念）
[
  {
    "name": "script_1",
    "description": "工單執行腳本",
    "inputSchema": {
      "orderId": { "type": "string", "required": true },
      "quantity": { "type": "number", "required": true }
    },
    "outputSchema": {
      "success": { "type": "boolean" },
      "processed": { "type": "number" }
    },
    "renderHint": "table"
  }
]
```

---

## 六、網路與部署規劃

```
Claw 主控端         Sub-Web (各 Pi)
port 8080      ←→   port 3000

192.168.1.100       192.168.1.101  (M1)
                    192.168.1.102  (M2)
                    192.168.1.103  (M3)
```

### 環境變數（.env）
```bash
# Claw 端
SUB_NODES=m1:http://192.168.1.101:3000,m2:http://192.168.1.102:3000,m3:http://192.168.1.103:3000
LLM1_ENDPOINT=http://localhost:11434/api/generate
LLM1_MODEL=phi3.5

# Sub-Web 端（各 Pi）
NODE_ID=m1
SCRIPTS_DIR=./scripts
PORT=3000
```

---

## 七、與 HiBA-AB 的對應關係

| Claw/Sub-Web 概念 | HiBA-AB 概念 |
|-----------------|-------------|
| Claw Controller | Orchestrator Agent |
| Sub-Web | DomainAgent（機 Agent） |
| 腳本 manifest.json | ToolRegistry |
| POST /execute | toolbox.execute() |
| X-Trace-Id header | AuditTrail traceId |
| renderHint | outputSchema `ui:widget` |
| NodeRegistry heartbeat | A3 canInstall() 前置判斷 |
