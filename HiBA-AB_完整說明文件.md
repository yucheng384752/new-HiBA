# HiBA-AB 分專案新手完整說明文件

> 目的：給「完全沒有接觸過 HiBA-AB 分專案」的人快速理解這個專案在做什麼、為什麼做、系統有哪些元件、資料如何流動、目前完成到哪裡，以及接下來要看哪些檔案。
>
> 本文件依據目前工作區與 Vault 中既有資料整理，不把尚未完成或未明確定義的項目寫成既定事實。

---

## 1. 一句話說明

HiBA-AB（Hierarchical Agent Based Architecture）是一個把「Agent」與「Tool」統一成同一種可呼叫單位的階層式 AI 代理架構。它讓 Orchestrator 可以把自然語言任務轉成 ExecutionPlan，再交給不同 Domain Agent 或邊緣節點執行，同時用 TrustRegistry、Scoped Toolbox、AuditTrail、TPM/Blockchain 等機制保護身份、權限與稽核完整性。

---

## 2. 這個分專案要解決什麼問題

### 2.1 現有 Agent 架構的痛點

目前研究文件指出，常見框架如 LangGraph、AutoGen、CrewAI 通常把 Agent 與 Tool 視為不同型別。這會造成：

1. 新增 Agent 時，Orchestrator 或頂層管理邏輯常需要額外修改。
2. 節點上的工具、腳本、模型、資源狀態可能不同，調度時需要判斷「能不能裝、要不要更新、能不能直接執行、要不要轉派」。
3. 工業場景需要稽核與責任追蹤，不能只相信 LLM 的輸出或任務結果。
4. 權限必須隨階層向下遞減，避免子 Agent 越權。

### 2.2 HiBA-AB 的核心方向

HiBA-AB 的解法是：

- 讓 `Agent` 滿足 `Tool` 介面，使 Agent 可以像 Tool 一樣被註冊、查詢、執行。
- 讓 `plan()` 只輸出結構化的 `ExecutionPlan`，再由 Runtime 決定實際動作。
- 用 `ResourceDecisionService` 判斷每個 PlanStep 要 `install`、`update`、`execute` 或 `dispatch`。
- 用 `ScopedToolbox` 強制權限遞減。
- 用 `AuditTrail` 錨定每次 ToolResult，支援投毒偵測與稽核追蹤。

---

## 3. 核心名詞

| 名詞 | 說明 |
|---|---|
| Orchestrator | 接收任務、規劃 ExecutionPlan、協調 Agent/Tool 的上層代理 |
| Agent | 可被呼叫的代理單位，在 HiBA-AB 中也視為一種 Tool |
| Tool | 最小可執行能力，包含名稱、版本、schema、權限、handler |
| Toolbox | Tool 的註冊與執行容器 |
| ScopedToolbox | 有權限範圍限制的 Toolbox，用於子 Agent 權限隔離 |
| TrustRegistry | 保存 AgentID、PublicKey、node 狀態、能力與信任資訊 |
| AuditTrail | 對 ToolResult 產生稽核紀錄、hash、proof 的服務 |
| ExecutionPlan | `plan()` 產生的結構化任務計畫，包含多個 PlanStep |
| PlanStep | 一個可執行步驟，通常包含 `toolName`、`nodeId`、`version`、`input`、`dependsOn` |
| ResourceDecisionService | 判斷 PlanStep 應 install/update/execute/dispatch 的服務 |
| Accounting Server | 中央伺服器；在目前 AB 測試規格中承載 Orchestrator、plan()、TrustRegistry、AuditTrail |
| RPi Agent / Sub-Web | Raspberry Pi 邊緣節點上的輕量服務，接收任務、執行腳本、回傳結果 |
| HiBA-B / hiba-core | 既有 Java/Netty/TPM/Blockchain 層，HiBA-AB 可透過 HTTP 與其整合 |

---

## 4. 三個公理

### A1. Tool Isomorphism Axiom：Agent IS a Tool

概念：

```text
任意 Agent 都滿足 Tool 的完整介面：
handler, inputSchema, outputSchema, permissions
```

意義：

- Agent 與 Tool 共用同一套操作介面。
- 新增 DomainAgent 只需要註冊到 registry/toolbox。
- Orchestrator 不需要為每種 Agent 寫特殊呼叫邏輯。

### A2. Permission Monotonicity Axiom：權限單調遞減

概念：

```text
child.permissions ⊆ parent.permissions
```

意義：

- 子 Agent 不能比父 Agent 擁有更多權限。
- 權限限制由 ScopedToolbox 強制。
- 越權呼叫應回傳 `TOOL_NOT_FOUND` 或相關權限錯誤，而不是進入 handler 才失敗。

### A3. Resource Decision Axiom：資源決策

概念：

```text
tool 不存在 + canInstall    -> install
tool 存在 + isStale         -> update
tool 存在 + isCurrent       -> execute
tool 不存在 + cannotInstall -> dispatch
```

意義：

- Orchestrator/Planner 不直接處理所有節點細節。
- Runtime 根據 node 能力、tool 版本、runtime 狀態做決策。
- 缺少資源時，可以安裝、更新、轉派或向上 fallback。

---

## 5. 三個定理

### T1. 遞迴深度限制

每次 Agent 委派任務時，`ToolContext.depth` 會增加。若超過 `maxDepth`，應中止並回傳 `MAX_DEPTH_EXCEEDED`。

### T2. 稽核完整性

每次透過 `Toolbox.execute()` 執行的操作，都應產生 AuditTrail 錨點。任何繞過 `Toolbox.execute()` 直接呼叫 handler 的行為，不在信任範圍內。

### T3. 自然語言決策等價

`plan()` 的輸出必須是合法的 `ExecutionPlan`。LLM 的角色是把自然語言轉成結構化計畫，不是任意產生架構外行為。

---

## 6. 系統總體架構

目前資料中，HiBA-AB 可理解為上層 AI Agent Runtime，並可與既有 HiBA-B / hiba-core 整合。

```text
使用者 / 前端
  |
  | POST /api/plan 或 POST /api/intent
  v
Accounting Server
  ├─ Orchestrator
  ├─ plan() / Planner
  ├─ Toolbox / ScopedToolbox
  ├─ ResourceDecisionService
  ├─ TrustRegistry
  └─ AuditTrail
        |
        | HTTP / dispatch / execute
        v
Domain Agents 或 Edge Nodes
  ├─ ManAgent
  ├─ MachineAgent
  ├─ MaterialAgent
  ├─ MethodAgent
  ├─ EnvAgent
  └─ RPi Sub-Web / RPi Agent
        |
        v
hiba-core / HiBA-B
  ├─ TPM
  ├─ Netty Pipeline
  ├─ Blockchain / FileProtection
  ├─ ELK
  └─ Ansible deployment
```

---

## 7. Accounting Server 與 Node 的關係

### 7.1 目前 AB 測試規格

目前資料支持的測試架構是：

```text
1 台 Accounting Server（PC + GPU）
2 台 Raspberry Pi 節點
```

Accounting Server 內含：

- Orchestrator
- plan() LLM
- Toolbox
- TrustRegistry
- AuditTrail
- SQLite：`nodes`、`tool_registry`、`audit_log`

RPi Agent / Node 負責：

- 接收任務
- 執行腳本
- 回傳結果
- 維持 heartbeat
- 暴露健康狀態與工具清單

### 7.2 不是每個 node 一個 Accounting Server

依目前資料，Accounting Server 不是每個 node 一個，而是中央式伺服器。Node 是被管理與被派工的節點。

---

## 8. 使用流程

### 8.1 節點註冊流程

1. Raspberry Pi 開機。
2. RPi 執行 announce 腳本。
3. RPi 收集 hostname、IP、MAC、publicKey、agentVersion 等資訊。
4. RPi 呼叫 `POST /api/nodes/announce`。
5. Accounting Server 將節點寫入 TrustRegistry，狀態為 `pending`。
6. Admin 在前端審核並 register。
7. Accounting Server 更新節點狀態為 `registered`。
8. RPi Agent 啟動並監聽任務。
9. Accounting Server 執行 capability probe。
10. 節點被分類為 `minimal`、`standard` 或 `capable`。
11. 節點進入 `profiled / online` 狀態。

### 8.2 任務執行流程

1. Operator 在 Dashboard 輸入自然語言任務。
2. 前端呼叫 `POST /api/plan` 或規格中的 `POST /api/intent`。
3. AgentServer 建立 `ToolContext`：
   - `agentId`
   - `traceId`
   - `depth`
   - `hibaBaseUrl`
   - `permissions`
4. `NLPlanningService` 查詢可用 node resources 與 available tools。
5. Planner / LLM 產生 `ExecutionPlan`。
6. Runtime 驗證 ExecutionPlan 是否符合 schema。
7. 使用者或系統確認執行。
8. 對每個 PlanStep，`ResourceDecisionService` 判斷動作：
   - `install`
   - `update`
   - `execute`
   - `dispatch`
9. 執行前檢查 TrustRegistry、permission、schema。
10. Tool handler 執行本地或遠端任務。
11. AuditTrail 記錄 ToolResult。
12. 回傳結果給 Dashboard。

---

## 9. Planner / LLM 的角色

### 9.1 Planner 的輸入與輸出

Planner 的任務是：

```text
自然語言任務 + resources + availableTools -> ExecutionPlan
```

在程式碼中，`NLPlanningService` 會：

1. 從 AccountingClient 取得 `NodeResourceMap`。
2. 從 Toolbox 取得可用 Tool 名稱。
3. 呼叫 LLMClient。
4. 用 Zod 驗證 LLM 回傳的 `ExecutionPlan`。

### 9.2 支援的 Planner 模式

既有文件定義三種可能：

| 模式 | 說明 |
|---|---|
| RuleEnginePlanner | 純規則，低延遲，不使用 LLM |
| LLMPlanner | 使用 Phi-3.5-mini LoRA 等模型 |
| HybridPlanner | 先跑規則，沒有匹配再交給 LLM |

### 9.3 重要限制

目前資料支持的是：LLM 產生 `ExecutionPlan JSON`。它不是任意腳本產生器。若 Tool 或腳本完全不存在，現有 A3 決策會走 `install`、`bootstrapRuntime` 或 `dispatch` 等路徑，但沒有明確資料支持「LLM 自動產生 Playwright 腳本」這類能力。

---

## 10. Tool 規格

Tool 是 HiBA-AB 的最小可執行能力。典型格式如下：

```typescript
defineTool({
  name: 'material.protectFile',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '將檔案 metadata 上鏈保護',
  inputSchema: z.object({
    filePath: z.string(),
    keepFile: z.boolean().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    txHash: z.string(),
  }),
  permissions: ['material.write'],
  timeout: 30_000,
  retryPolicy: {
    maxAttempts: 3,
    initialDelayMs: 500,
    backoffMultiplier: 2,
    retryOn: ['TOOL_TIMEOUT'],
  },
  handler: async (input, ctx) => {
    // call hiba-core or local runtime
  },
})
```

### 10.1 命名規則

| 欄位 | 規則 | 例子 |
|---|---|---|
| name | `{domain}.{verbObject}` | `machine.queryStatus` |
| domain | `man / machine / material / method / env` | `material` |
| tags[0] | domain | `material` |
| tags[1] | read/write 類別 | `write` |
| error code | SCREAMING_SNAKE_CASE | `TOOL_NOT_FOUND` |

### 10.2 ToolContext

```typescript
interface ToolContext {
  hibaBaseUrl: string
  traceId: string
  agentId: string
  depth: number
  permissions: string[]
}
```

### 10.3 常見錯誤碼

| 錯誤碼 | 說明 |
|---|---|
| `SCHEMA_VALIDATION_ERROR` | input 不符合 inputSchema |
| `TOOL_NOT_FOUND` | Tool 不在 Toolbox 中，或權限不可見 |
| `AGENT_NOT_REGISTERED` | TrustRegistry 找不到 AgentID |
| `PERMISSION_EXCEEDS_PARENT` | 子 Agent 權限超出父層 |
| `AUDIT_ANCHOR_FAILED` | AuditTrail hash 驗證失敗 |
| `TOOL_TIMEOUT` | handler 執行逾時 |
| `MAX_DEPTH_EXCEEDED` | 委派深度超過限制 |

---

## 11. Domain Agents 與預期 Tool

文件中定義五個 Domain Agent：

| 領域 | Agent | 預期工具 |
|---|---|---|
| 人 | ManAgent | loginOperator, queryShift, verifyOperatorCert, checkSkill, sendAlert |
| 機 | MachineAgent | queryStatus, calculateOee, schedulePm, listAlarms, checkCalib |
| 料 | MaterialAgent | traceLot, queryStock, fetchBom, inspectIncoming, checkExpiry |
| 法 | MethodAgent | fetchSop, validateParam, queryEcn, recordAudit, checkCompliance |
| 環 | EnvAgent | readTemperature, readHumidity, checkCleanroom, alertThreshold |

另有 Orchestrator meta tools：

- `listAgents`
- `getAuditSummary`

---

## 12. ResourceDecisionService

`ResourceDecisionService` 對每個 PlanStep 做決策。

目前程式碼中的邏輯：

```typescript
if (!toolbox.has(step.toolName)) {
  const canInstall = await checker.canInstall(step.nodeId, ctx)
  return canInstall ? 'install' : 'dispatch'
}

const isStale = await checker.isStale(
  step.nodeId,
  step.toolName,
  step.version,
  ctx,
)

return isStale ? 'update' : 'execute'
```

這對應 A3：

| 情況 | 動作 |
|---|---|
| Tool 不存在，但 node 可安裝 | `install` |
| Tool 存在但版本過期 | `update` |
| Tool 存在且版本正確 | `execute` |
| Tool 不存在且 node 不可安裝 | `dispatch` |

---

## 13. Raspberry Pi / Edge Node

### 13.1 Node 能否使用 Raspberry Pi

可以。現有 AB node spec 明確使用 2 台 Raspberry Pi 作為測試環境中的節點。

### 13.2 RPi 端最低設計

RPi 端採取「最小常駐服務」原則：

- Node.js 18 LTS
- Python 3
- Express Sub-Web
- systemd 管理
- HTTP REST，不使用 MQTT 作為必要條件
- 腳本以 `python3 scripts/*.py` 執行

### 13.3 RPi Sub-Web API

| API | 說明 |
|---|---|
| `GET /health` | 節點健康狀態 |
| `GET /scripts` | 可用腳本清單 |
| `POST /execute` | 執行指定腳本 |
| `GET /status/stream` | SSE 狀態流 |

### 13.4 節點 Profile

| Profile | 條件 | 可用能力 | 典型節點 |
|---|---|---|---|
| `minimal` | free memory < 256MB | bash | RPi Zero 或舊型嵌入式 |
| `standard` | 256MB 到 3GB | bash, python3, nodejs | RPi 4 測試節點 |
| `capable` | > 3GB + GPU | 全部 + LLM | PC Accounting Server |

---

## 14. AuditTrail 與投毒偵測

AuditTrail 是 HiBA-AB 的稽核與完整性核心。

### 14.1 基本概念

每次 Tool 執行後，系統應對 ToolResult 建立 hash / audit record，保存：

- traceId
- stepId
- toolName
- agentId
- timestamp
- inputHash
- outputHash
- success/error 狀態

### 14.2 投毒偵測

文件中的 C2 實驗是「分支樹投毒實驗」：

- 節點回傳模型或檔案結果。
- 攻擊者竄改 Node 8 回傳內容，例如 1%、5%、10%。
- AuditTrail 在聚合前做 hash 比對。
- 預期可偵測 `AUDIT_ANCHOR_FAILED`。

### 14.3 重要邊界

AuditTrail 只保證經由 `Toolbox.execute()` 的結果會被錨定。若有人繞過 Toolbox 直接呼叫 handler，依定理 T2，不在信任範圍內。

---

## 15. TrustRegistry 與身份

TrustRegistry 負責保存與查詢：

- AgentID
- PublicKey
- Node 狀態
- Node capability
- Node profile
- Tool registry metadata

身份可分為：

| 類型 | 說明 |
|---|---|
| SoftwareAgentIdentity | Node.js crypto 產生 RSA/ECDSA keypair |
| TPMAgentIdentity | 透過 TPM 做簽章與驗章，對應 HiBA-B/hiba-core |

當 Orchestrator 要派任務時，會產生 SignedTask。接收端應驗證身份與權限。

---

## 16. HiBA-AB 與 hiba-core / HiBA-B 的關係

HiBA-AB 是上層 Node.js / TypeScript Runtime；hiba-core 是既有 Java / Netty / TPM / Blockchain 系統。

兩者透過 HTTP REST 整合。

```text
HiBA-AB Node.js Runtime
  ├─ Intent Controller
  ├─ Orchestrator + plan()
  ├─ Toolbox + Handlers
  ├─ TrustRegistry SQLite
  ├─ AuditTrail SQLite
  └─ ResourceDecisionService
        |
        | HTTP port 8092
        v
hiba-core Java Runtime
  ├─ mService
  ├─ TPM service
  ├─ Blockchain Web3j
  ├─ Netty Pipeline
  └─ ELK
```

### 16.1 預期 hiba-core API

| API | 用途 |
|---|---|
| `GET /api/nodes/capabilities?nodeId={id}` | ResourceDecisionService 查詢 node 能力 |
| `POST /api/audit/anchor` | AuditTrail 將 proof 錨定到鏈上 |

---

## 17. API 現況

依現有 AgentServer 程式碼，目前已有或規劃中的 API 包含：

| API | 狀態/用途 |
|---|---|
| `GET /health` | 已實作，回傳 hiba-agent 健康狀態 |
| `GET /api/resources` | 已實作，回傳 node resources |
| `GET /api/tools` | 已實作於 AgentServer，需 toolbox configured |
| `POST /api/execute` | 已實作於 AgentServer，直接呼叫 Toolbox.execute |
| `POST /api/plan` | 已實作於 AgentServer，呼叫 NLPlanningService.plan |
| `POST /api/intent` | 規格中提到，待補齊或與 `/api/plan` 整合 |
| `GET/POST /api/agents` | 規格中待完成 |

---

## 18. 前端 / Dashboard

目前資料中前端方向包括：

- Admin 頁：ToolRegistry Browser、Agent 身份設定、節點管理。
- Operator 頁：自然語言任務輸入、ExecutionPlan 預覽、任務執行、結果顯示。
- Sub-Web 頁：節點卡片、Scripts 清單、手動執行 Tool、AuditTrail。

前端重要原則：

- 以 ToolRegistry 的 `inputSchema` / `outputSchema` 驅動表單。
- 不硬編碼 Tool 名稱與 domain 名稱。
- 新增 Tool 後，前端應能從 API 自動渲染。

---

## 19. 目前開發狀態

依 2026-05-06 的進度文件，目前大致狀態：

| 模組 | 狀態 |
|---|---|
| 理論、公理、定理 | 完成 |
| 架構規格 | 完成 |
| Runtime 實作 | 約 70%，`defineTool` / `HiBAToolbox` / `AuditTrail` / `TrustRegistry` / `ScopedToolbox` 已有基礎 |
| Tool handlers | 約 5%，`material.protectFile` stub 完成，其餘大多未完成 |
| API 層 | 約 60%，`GET /health /resources /tools`、`POST /execute /plan` 已有 |
| plan() LLM 訓練 | 約 95%，但屬 MVP 原型 |
| plan() 模型部署 | 約 85% |
| 前端 MVP | 0% 或尚未完成 |

重要備註：

- plan() 目前被描述為 MVP 原型。
- 正式版仍需 11 節點、21 Tool、A3 決策資料重訓。
- 目前不能把所有論文目標視為已實作完成。

---

## 20. 典型開發任務

### 20.1 新增一個 Tool

1. 選定 domain 與名稱，例如 `env.readTemperature`。
2. 寫 `defineTool()`：
   - name
   - version
   - tags
   - inputSchema
   - outputSchema
   - permissions
   - handler
3. 加入 Toolbox 註冊流程。
4. 補測試：
   - schema validation
   - permission
   - handler success/error
   - AuditTrail record
5. 確認 `GET /api/tools` 可回傳 metadata。

### 20.2 新增一個 Domain Agent

1. 讓 Agent 滿足 Tool 介面。
2. 設定權限。
3. 建立 ScopedToolbox。
4. 註冊到 AgentRegistry/Toolbox。
5. 確認 Orchestrator 不需要特殊 case。

### 20.3 新增一個 RPi 腳本

1. 將腳本放到 RPi 的 scripts 目錄，例如 `/opt/subweb/scripts`。
2. 更新 manifest / ToolRegistry。
3. 確認 `GET /scripts` 看得到。
4. 用 `POST /execute` 測試。
5. 確認 AuditTrail 有紀錄。

### 20.4 新增 Planner 訓練資料

1. 從 ToolRegistry 取得 Tool 定義。
2. 建立自然語言 instruction。
3. 標註期望 `ExecutionPlan JSON`。
4. 驗證輸出符合 schema。
5. 加入 Rule/LLM/Hybrid planner 評估。

---

## 21. 常見誤解

### 誤解 1：LLM 可以直接產生任何腳本

目前資料不支持。現有設計是 LLM/Planner 產生 `ExecutionPlan`，不是任意產生 Playwright、Python 或 Shell 腳本。

### 誤解 2：每個 node 都有自己的 Accounting Server

目前資料不支持。測試規格是中央 Accounting Server 管理多個 node。

### 誤解 3：AuditTrail 可以保護任何執行方式

不完全正確。AuditTrail 的完整性假設是所有 Tool 執行都經過 `Toolbox.execute()`。

### 誤解 4：Raspberry Pi 不能當 node

不正確。現有測試規格明確包含 Raspberry Pi 節點，且有邊緣節點最低規格。

---

## 22. 主要來源

本文件整理自以下現有資料：

- `files/HiBA-AB_研究構想說明書.md`
- `files/HiBA-AB_研究構想說明書_v2.md`
- `files/hiba_ab_node_spec.md`
- `files/hiba-core/packages/hiba-agent/src/server/AgentServer.ts`
- `files/hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts`
- `files/hiba-core/packages/hiba-agent/src/core/ResourceDecisionService.ts`
- `HiBA-AB-Vault/核心理論/三個公理.md`
- `HiBA-AB-Vault/核心理論/三個定理.md`
- `HiBA-AB-Vault/系統架構/整體架構總覽.md`
- `HiBA-AB-Vault/系統架構/整體架構圖與泳道圖.md`
- `HiBA-AB-Vault/系統架構/部署架構決策.md`
- `HiBA-AB-Vault/系統架構/邊緣節點最低規格.md`
- `HiBA-AB-Vault/實作規格/Tool 格式規範.md`
- `HiBA-AB-Vault/實作規格/plan() 與 LLM 選型.md`
- `HiBA-AB-Vault/實驗驗證/六項可驗證主張 C1-C6.md`
- `HiBA-AB-Vault/實驗驗證/分支樹投毒實驗.md`
- `HiBA-AB-Vault/開發進度/五階段待辦清單.md`
