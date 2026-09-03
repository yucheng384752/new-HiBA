---
id: "20260903-multinode-transfer-nl-workflow"
title: "多節點檔案傳輸"
status: "completed"
owner: "claude"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T18:10:00+08:00"
updated_at: "2026-09-03T20:15:00+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/server/OrchestratorRunner.test.ts"
    type: "test"
  - path: "scripts_pi/claw-dashboard.html"
    type: "file"
---

# Goal

延續 `20260903-dashboard-web3-verification`（已完成）留下的 out-of-scope
工作：讓 FileProtection 檔案能傳給非 hiba-agent 本機的其他節點。

> 範圍已縮小（2026-09-03 使用者決定）：原本這個 thread 也想一併做「自然語言
> plan → approve → run 觸發 Protect/Verify」，已拆出去，這輪只做多節點檔案
> 傳輸。自然語言 workflow 串接留待 Accounting/LLM 確認上線後另開新 thread。

# Success Criteria

- 至少兩個已註冊節點能各自完成一次「上傳 → Protect」，不依賴 Windows/Linux
  絕對路徑跨機傳遞（`hibaFileRequest` 目前是 `readFile(filePath)` 直接讀
  hiba-agent process 所在機器的本機路徑，見前一個 thread 的 Review
  Findings）。
- OrchestratorRunner 對這類步驟的 trace/audit 記錄能對應到實際執行節點。
- Accounting 服務上線後才能實測多節點派送，不是本 thread 自己起服務；沒有
  上線時至少要能用兩個本機啟動的 AgentServer 模擬兩個節點驗證傳輸邏輯本身。

# Current Context

- 前一個 thread 完成後，`material.protectFile`/`verifyFile` 已經是穩定
  `protectionId` 契約，`AgentServer` 已有 `_attachment`/`_filePath` 落地
  邏輯（512 KiB、白名單副檔名、UUID 儲存路徑、TTL 清除）——這條路徑目前
  只把檔案落地在 hiba-agent 本機，還沒有「轉送到其他節點」這一段。
- `docs/HiBA-AB` 的既有派送機制：`OrchestratorRunner` 對 `dispatched:
  'remote'` 的步驟是打對方節點的 `/api/execute`（HTTP JSON body），目前
  沒有檔案內容的傳輸通道，只有結構化 JSON input。
- Accounting（`9090`）、LLM（`11434`）在前一個 thread 記錄時未啟動，是否
  已上線需要重新確認。

# Codex Notes

**Open Question resolution（Codex，2026-09-03，實作前確認）**：
`AgentServer.ts` 已提供 `POST /api/run`，request body 接受
`{ plan: ExecutionPlan, ctx?: Partial<ToolContext> }`，會直接呼叫
`this.options.orchestrator.run(body.plan, ctx)` 並同步回傳 `RunResult`。這已足以
支援 Dashboard 以一份 `ExecutionPlan` 執行 Web3 Verification：本機選項可
繼續走既有 `/api/execute`；非本機選項則把 `_attachment` 放進
`material.readAttachment` step，以所選 `nodeId` 為 target，後續
Protect/Verify step 使用 `$steps.S1.output.filePath`，整份 plan POST 到 planning agent 的
`/api/run`。`OrchestratorRunner` 會查 `nodeAddresses`／Accounting
`/api/nodes`，再把原始 `step.input` 送到目標 AgentServer 的
`/api/execute`，因此會產生 `dispatched: 'remote'` 與 `DATA_TRANSFERRED`
紀錄。現有 API 沒有缺口，不需要新增或擴充端點；唯一部署前提是 planning
AgentServer 已注入 `orchestrator`，且所選 nodeId 可由它的靜態或 Accounting
節點目錄解析。

**Implementation（Codex，2026-09-03）**：Dashboard Web3 Verification 面板已
新增由 Accounting `NodeDescriptor` 資料產生的節點 selector。選 `local` 時保留
既有 `/api/execute` 流程；選遠端節點時，組成兩步驟 plan（遠端落地 attachment，
再於同一 nodeId Protect/Verify）送到 `/api/run`。這樣 `filePath` 始終是執行
節點自己的路徑，且實際走過 OrchestratorRunner remote dispatch 與 audit 路徑。
`AgentServer.ts`、`OrchestratorRunner.ts` 均不需修改。

（以下保留 Claude 定案後提供的原始實作起點；Codex 已依上方 Implementation
完成並驗證。）

**方向已定案（2026-09-03，使用者核准）**：採方案 (a)，沿用既有
`_attachment` 機制，不新增下載 API。理由：讀過
`OrchestratorRunner.ts` 的 `remoteDispatch()`（約 315-320 行）後發現，
它已經把 `step.input` 原封不動 POST 到目標節點的 `/api/execute`，而
`AgentServer.ts` 的 `/api/execute` handler 已經對每個進來的 `input` 呼叫
`landAttachment()`——也就是說**轉送機制本身已經打通，不需要改
`OrchestratorRunner` 的派送邏輯**。真正要做的事：

1. **`filePath` 語意維持不變，不新增 artifact 識別碼概念**：`filePath`
   永遠是「實際執行 Protect/Verify 那個節點自己的本機路徑」。多節點情境
   下，建立 Plan 的一方（目前是 Dashboard，之後可能是 NL plan()）要在
   目標節點是 remote 的 step 裡放 `input._attachment = {name, content}`
   而不是預先算好的 `filePath`——目標節點收到後，自己的
   `landAttachment()` 會產生它自己機器上的 `_filePath` 並注入，跟現在
   單機版的行為完全一致，只是這次是在遠端節點上跑一次同樣的邏輯。
2. **Dashboard 的 Web3 Verification 面板**（`claw-dashboard.html`）目前
   只會對 hiba-agent 本機發 `/api/execute`，需要加節點選擇（沿用既有
   `NodeDescriptor`/`/api/nodes` 資料），選了非本機節點時，改成組
   `ExecutionPlan` 交給 `OrchestratorRunner.run()`（或現有對應的 API
   路由，需確認 AgentServer 是否已有直接跑單一 plan 的端點，不確定的話
   要先查），而不是直接打 `/api/execute`——這樣才能讓
   `dispatched: 'remote'` 這條路徑被實際使用到，也才有 trace/audit 對應
   （Success Criteria 第二項）。
3. **512 KiB 上限維持不動**：既有的 `ATTACHMENT_MAX_BYTES`/
   `ATTACHMENT_BODY_MAX_BYTES` 沿用，不因為多節點而放寬——維持這個上限
   跟「內容直接塞進 request body」這個決定是一致的，沒有衝突需要處理。

# Claude Notes

方向定案過程：跟使用者核對兩個開放問題後（見下方 Decisions），選定方案
(a)，並在確認前先讀過 `OrchestratorRunner.ts` 的實際派送邏輯，確認「不需要
新設計傳輸通道」這個判斷有程式碼依據，不是憑空推測。

# Review Findings

實作品質好，沒有找到阻斷性問題（跟上一個 thread 的 `protectionId` 缺口
不同，這次沒有類似等級的落差）。逐項核對：

- **`readAttachment → protectFile/verifyFile` 兩步驟設計，而非把
  `_attachment` 直接塞進同一個 Protect step**：一開始懷疑是不是多餘的
  間接層，查過 `material.readAttachment` 的真實實作（`hiba.tools.ts`
  835 行起）後確認合理——它現在是真的實作（不是 `notImplemented`），
  `outputSchema` 已經有 `filePath` 欄位，兩步驟設計讓落地結果透過既有的
  `$steps.S1.output.filePath` 參照機制明確傳遞，比隱式依賴同一 step 內
  `_attachment`→`_filePath` 的轉換更清楚，是合理的設計選擇。
- **`renderBlockchainNodeOptions()` 的節點過濾邏輯正確**：只列出
  `status === 'online'` 且同時具備 `readAttachment`/`protectFile`/
  `verifyFile` 三個工具的節點，不會讓使用者選到辦不到的節點。
- **`executeRemoteMaterial()` 有防呆**：`dispatched !== 'remote' ||
  nodeId !== target` 會丟錯——這點做得比我原始設計起點更仔細，防止
  `OrchestratorRunner` 的 failover 機制（原本是為了容錯設計）在這個
  「使用者明確選定驗證節點」的情境下靜默切到別的節點，破壞驗證證據的
  節點對應性。
- **本機路徑完全沒動**（`protectBlockchainFile`/`verifyBlockchainFile`
  的 `local` 分支維持原邏輯），只新增 remote 分支，改動面小、風險低。
- **`workflowPlanningUrl` 沿用既有設定值**（`localhost:8090`，Workflow
  分頁本來就有的設定），沒有另開一個新的設定輸入。

獨立重新驗證（不是只信任 Codex 自報數字）：

- `hiba-core/packages/hiba-agent`：`npm run typecheck` 乾淨；`npm test`：
  17 suites passed（+1 live E2E skipped）、**196 tests passed**、0
  failed——跟 Codex 回報數字一致。
- `hiba-core` root：`npm run typecheck` 乾淨；`npm test`：17/17 passed。
- 讀過完整 diff（`OrchestratorRunner.test.ts`、`claw-dashboard.html`），
  確認 `AgentServer.ts`／`OrchestratorRunner.ts` 真的沒被動到，跟 Codex
  Notes 的宣稱一致。
- 清掉了 4 個訓練那條線殘留、跟本次改動無關的 GPU telemetry 暫存
  CSV 檔案（`gpu-watch-v1c*.csv`），避免混進這次的 commit。

未驗證（如實記錄，不是遺漏）：Accounting 動態節點發現（Test Plan #3）
因為 `localhost:9090` 未上線，這次沒有 live 驗證，Codex 已在 Decisions
裡誠實記錄為 Deferred，不是隱藏起來的落差。

# Test Plan

1. 至少兩個本機啟動的 AgentServer（不同 port，模擬兩個節點）：對「本機」
   node 的 Protect 沿用現有行為（回歸測試，不應該壞）；對「遠端」
   node 使用 `material.readAttachment → material.protectFile` plan，驗證
   `_attachment` 有正確送達目標 AgentServer、內容在目標落地，且
   `material.protectFile` 在同一目標節點上正常執行。
2. `dispatched: 'remote'` 的 `StepResult`／`DATA_TRANSFERRED` audit 事件
   能對應到實際目標 `nodeId`（沿用 `OrchestratorRunner.test.ts` 既有的
   trace/audit 斷言模式）。
3. Accounting 上線時，額外驗證動態節點發現（`accountingUrl`）路徑下的
   多節點傳檔一樣正常，不是只靠靜態 `nodeAddresses` 才work。

# Test Results

- `hiba-core`: `npm.cmd run typecheck` → PASS（`tsc --noEmit`，exit 0）。
- `hiba-core`: `npm.cmd test` → PASS（17 tests，17 pass，0 fail，exit 0）。
- `hiba-core/packages/hiba-agent`: `npm.cmd run typecheck` → PASS
  （`tsc --noEmit`，exit 0）。
- `hiba-core/packages/hiba-agent`: `npm.cmd test` → PASS（17 suites passed、
  1 suite skipped；196 tests passed、1 skipped、0 failed；exit 0）。輸出確認測試時
  AgentServer 分別啟動於 `localhost:18200` 與 `localhost:18203`。
- Focused integration: `npm.cmd test -- --runInBand src/server/OrchestratorRunner.test.ts`
  → PASS（1 suite、28 tests、0 failed）。新增案例確認遠端內容為
  `remote proof`、Protect StepResult 為 `nodeId: node-remote`／
  `dispatched: remote`，且 `DATA_TRANSFERRED.metadata.nodeId` 為
  `node-remote`。
- Dashboard inline JavaScript：以 Node `new Function(...)` parse → PASS。
- `git diff --check` → PASS；只有 Git 的 LF→CRLF working-copy warnings。
- Accounting live check：`curl.exe --silent --show-error --max-time 3
  http://localhost:9090/api/nodes` → 未執行動態整合，實際輸出為
  `curl: (7) Failed to connect to localhost port 9090 ... Could not connect to server`。
- 實作中第一次 focused run 曾因 test fixture 重複註冊
  `material.readAttachment` 而失敗；移除重複註冊並把 target tool 放到遠端
  fixture 後，上述 focused 與 full suite 均通過。

# Decisions

- Accepted（使用者，2026-09-03）：多節點傳檔採方案 (a)——沿用
  `_attachment` 內容隨 request body 傳送，不新增下載 API，不新增跨節點
  認證機制。
- Accepted（使用者，2026-09-03）：自然語言 workflow 串接拆出去，不在本
  thread 範圍內，等 Accounting/LLM 確認上線後另開新 thread。
- Accepted（承接自前一個 thread）：`filePath` 欄位語意不變（永遠是
  執行節點的本機路徑），不新增 artifact ID 概念。
- Accepted（Codex 實作）：沿用既有 `/api/run`，不新增 API；遠端 Web3 操作
  使用同一 nodeId 的 `readAttachment → Protect/Verify` 兩步驟 plan，避免把
  planning node 的本機路徑傳給 target node。
- Deferred（環境）：Accounting `localhost:9090` 未上線，因此動態發現的 live
  驗證未執行；既有 dynamic discovery 測試與完整 agent suite 已通過。

# Session Summary

Codex 已完成多節點傳檔與 Dashboard 節點 selector：遠端 Web3 操作透過既有
`/api/run` 將 `_attachment` 落在目標 AgentServer，再以該節點自己的
`filePath` 執行 Protect/Verify。兩個本機 AgentServer 的 integration test、
root 與 agent 的 typecheck/full suite 均通過；Accounting 未上線的 live 動態
發現驗證已明確記錄。

Claude 最終驗證：讀過完整 diff、獨立重跑 typecheck 與完整測試（196 tests
passed，跟 Codex 自報一致），確認 `AgentServer.ts`/`OrchestratorRunner.ts`
真的沒被改動。沒有找到阻斷性問題——`executeRemoteMaterial()` 對
dispatched/nodeId 的防呆比原始設計起點更仔細，`readAttachment` 兩步驟
設計有確認過對應到真實已實作的 tool 契約，不是憑空假設。狀態設為
`completed`。

# Open Questions

- 已解決：使用既有 `POST /api/run`；不需新增或擴充 AgentServer API。解析與
  部署前提記錄於上方 Codex Notes。
