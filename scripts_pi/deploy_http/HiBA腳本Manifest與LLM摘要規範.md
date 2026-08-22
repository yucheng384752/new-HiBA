# HiBA 腳本 Manifest 與 LLM 摘要規範

> 規範版本：1.1  
> 更新日期：2026-08-23  
> 適用範圍：所有由 Sub-Web Node 公告、Accounting 登錄、Planner 派送及 Dashboard 顯示的腳本。

## 1. 資料流

```text
Node /scripts
  → register-hiba-nodes.mjs
  → Accounting ResourceItem.metadata
  → Planner /api/summarize
  → 摘要 LLM
  → Dashboard LLM 摘要 + 可展開原始 JSON
```

摘要服務以執行結果內的 `nodeId + toolName` 尋找 Accounting resource。若任務切換節點，必須使用實際執行結果的 `nodeId`，不能使用原始 Plan 的 Node。

## 2. 必填 Manifest 欄位

每個可執行腳本必須提供：

| 欄位 | 規則 |
|---|---|
| `name` / `scriptName` | 實際腳本鍵名；依 Node runtime 使用的 manifest 格式決定 |
| `toolName` | 穩定的功能名稱，例如 `machine.queryStatus` |
| `version` | Tool 執行契約版本；目前為 `1.0.0`。只有輸入、輸出或執行行為不相容時才提升 |
| `metadataSchemaVersion` | Metadata 格式版本；目前為 `1.0` |
| `plannerVisible` | 是否提供一般 Planner 選用；遞迴建立任務鏈等 meta-tool 應設為 `false` |
| `description` | 一句話說明副作用、資料來源與主要輸出 |
| `inputSchema` | 每個輸入欄位的型別、required、enum、單位與說明 |
| `outputSchema` | 每個輸出欄位的型別、enum、單位、null/空值語意與說明 |
| `summaryHints` | 摘要必須包含的業務重點，不得包含操作指令 |
| `permissions` | 執行所需權限 |
| `timeout` / `timeoutMs` | 執行逾時 |

## 3. Node flat-schema 範例

```json
{
  "name": "machine.queryStatus",
  "toolName": "machine.queryStatus",
  "version": "1.0.0",
  "metadataSchemaVersion": "1.0",
  "description": "查詢指定機台的即時狀態、OEE、警報與目前工單",
  "inputSchema": {
    "machineId": {
      "type": "string",
      "required": true,
      "description": "機台 ID，如 CNC-01"
    }
  },
  "outputSchema": {
    "status": {
      "type": "string",
      "enum": ["running", "idle", "error"],
      "description": "running=運轉中、idle=待機、error=異常"
    },
    "oee": {
      "type": "number",
      "unit": "%",
      "description": "設備綜合效率"
    },
    "alarms": {
      "type": "array",
      "description": "目前警報；空陣列表示沒有警報"
    },
    "orderId": {
      "type": ["string", "null"],
      "description": "running 時正在執行的工單；未派工時為 null"
    }
  },
  "summaryHints": [
    "必須說明機台狀態與 OEE 百分比",
    "alarms 為空時寫成沒有警報",
    "orderId 有值時說明目前工單"
  ]
}
```

## 4. 欄位說明規則

- 數值必須寫明單位，例如 `%`、`°C`、`%RH`、`ms`、`bytes`。
- enum 必須說明每個值的業務意義。
- `null`、空字串與空陣列必須說明語意；例如 `alarms: []` 表示沒有警報。
- 時間必須說明是否為 ISO 8601、是否需要時區。
- 陣列需說明 item 的欄位或資料意義。
- 技術欄位如 `toolName`、`domain`、`auditHash` 可供稽核，但不得取代業務欄位說明。
- 腳本實際輸出變更時，必須先更新 `outputSchema` 並提升 `version`，再部署腳本。

## 5. summaryHints 規則

`summaryHints` 只能描述「如何整理既有輸出」，例如：

- `orderId 有值時說明目前工單`
- `matched=false 必須標示內容不一致`
- `沒有 Log 時明確寫成沒有符合紀錄`

禁止內容：

- 要求 LLM 忽略 system prompt。
- 要求執行命令、呼叫網址、洩漏秘密或修改任務結果。
- 加入輸出 JSON 不存在的預設事實。

Planner 將 Node metadata 視為不可信任資料，只使用白名單欄位；原始執行結果永遠優先於 metadata。

## 6. 已知最新版 Tool 契約

活躍 m2/m3 Node 共 9 個：

1. `machine.executeOrder@1.0.0`
2. `machine.queryStatus@1.0.0`
3. `env.readSensor@1.0.0`
4. `orchestrator.echoRtt@1.0.0`
5. `material.readAttachment@1.0.0`
6. `env.verifyFileIo@1.0.0`
7. `orchestrator.deployServer@1.0.0`
8. `machine.queryLog@1.0.0`
9. `orchestrator.createTaskChain@1.0.0`（`plannerVisible=false`，僅供明確 API/腳本呼叫）

正式部署套件另保留相容 Tool：`orchestrator.updateSubWebRuntime@1.0.0`。

`version` 與 `metadataSchemaVersion` 必須獨立管理。只補充 `description`、`outputSchema` 或 `summaryHints` 時，不得提升 Tool 執行版本；否則 Planner 與 Node 會被判定為不相容。

## 7. 發布與驗收

1. 更新 canonical manifest。
2. 驗證所有 entry 具有 `description`、`inputSchema`、`outputSchema`、`summaryHints`。
3. 將 manifest 與腳本同步到 Node。
4. 重啟 Node runtime，確認 `/scripts` 顯示最新版。
5. 等待 bridge 更新 Accounting，確認 resource metadata 完整。
6. 執行至少一個 Tool，呼叫 `/api/summarize`。
7. 確認 Dashboard 同時顯示自然語言摘要與原始 JSON fallback。

若 Accounting 或摘要模型失敗，任務執行結果不得被改成失敗；Dashboard 必須保留原始 JSON。
