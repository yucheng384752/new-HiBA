---
id: "20260903-multinode-transfer-nl-workflow"
title: "多節點檔案傳輸"
status: "draft"
owner: "none"
reviewer: "none"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T18:10:00+08:00"
updated_at: "2026-09-03T19:30:00+08:00"
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

（尚未實作，方向已定案，下面是 Claude 定案後給的實作起點，Codex 接手時
應該先自行確認程式碼現狀跟這裡描述的是否一致，可能已有其他改動）

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

（尚未審查——本 thread 還沒有 Codex 實作可供審查）

# Test Plan

1. 至少兩個本機啟動的 AgentServer（不同 port，模擬兩個節點）：對「本機」
   node 的 Protect 沿用現有行為（回歸測試，不應該壞）；對「遠端」
   node 的 Protect，驗證 `_attachment` 有正確送達目標 AgentServer 並落地
   成功，`material.protectFile` 在目標節點上正常執行。
2. `dispatched: 'remote'` 的 `StepResult`／`DATA_TRANSFERRED` audit 事件
   能對應到實際目標 `nodeId`（沿用 `OrchestratorRunner.test.ts` 既有的
   trace/audit 斷言模式）。
3. Accounting 上線時，額外驗證動態節點發現（`accountingUrl`）路徑下的
   多節點傳檔一樣正常，不是只靠靜態 `nodeAddresses` 才work。

# Decisions

- Accepted（使用者，2026-09-03）：多節點傳檔採方案 (a)——沿用
  `_attachment` 內容隨 request body 傳送，不新增下載 API，不新增跨節點
  認證機制。
- Accepted（使用者，2026-09-03）：自然語言 workflow 串接拆出去，不在本
  thread 範圍內，等 Accounting/LLM 確認上線後另開新 thread。
- Accepted（承接自前一個 thread）：`filePath` 欄位語意不變（永遠是
  執行節點的本機路徑），不新增 artifact ID 概念。

# Session Summary

本 thread 尚未開始實作。方向已跟使用者核對定案：多節點傳檔沿用既有
`_attachment` 機制（`OrchestratorRunner` 的轉送邏輯已經打通，不需要改），
自然語言 workflow 串接拆到未來的新 thread，本輪範圍收斂為「Dashboard 能
對遠端節點做 Protect/Verify」。

# Open Questions

- Dashboard 選了遠端節點後，前端要改成呼叫哪個既有/新的 API 端點來組
  `ExecutionPlan` 並丟給 `OrchestratorRunner.run()`——需要先確認
  `AgentServer.ts` 現有的 `/api/run`（或類似端點）能不能直接支援這個
  單步驟即時執行的用法，還是需要小幅擴充，Codex 接手時第一步應該先查
  清楚，不確定就先回報而不是自己猜。
