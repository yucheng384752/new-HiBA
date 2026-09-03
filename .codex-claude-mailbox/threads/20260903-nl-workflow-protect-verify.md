---
id: "20260903-nl-workflow-protect-verify"
title: "自然語言觸發 Protect/Verify Workflow"
status: "draft"
owner: "codex"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T20:30:00+08:00"
updated_at: "2026-09-03T20:30:00+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/server/AgentServer.ts"
    type: "file"
  - path: "scripts_pi/claw-dashboard.html"
    type: "file"
---

# Goal

延續 `20260903-dashboard-web3-verification` 與
`20260903-multinode-transfer-nl-workflow`（皆已完成）留下的最後一項
out-of-scope 工作：讓 Protect/Verify 能透過自然語言 `plan() → approve →
run` 觸發並拿到 LLM 摘要，而不是只有 Dashboard 上手動點的證據面板/節點
selector。

# Success Criteria

- 自然語言任務（例如「保護 node2 上的這個檔案，驗證後給我摘要」）能經
  `plan() → approve → run` 產生 Protect/Verify 依賴鏈，正確對應到使用者
  選定的節點。
- 執行結果能透過既有 `NLPlanningService.summarize()` 拿到 LLM 摘要——這個
  函式已經在別的地方做過輸入驗證/截斷硬化（見
  `plan_LLM_訓練清單.md`），**不需要重做**，直接沿用。
- Accounting／LLM 服務上線後才能實測，本 thread 不負責啟動這些服務。

# Current Context

- 直接查證過（2026-09-03 20:xx）：`Accounting (9090)`、`Ollama/LLM
  (11434)` 目前都**沒有**在跑；`hiba-agent AgentServer (8090)` 有在跑
  （PID 55508）。沒有 live LLM 服務可測時，Codex 應該先把能做的部分
  （程式邏輯、mock LLM 的單元/整合測試）做完，並在 Test Results 裡誠實
  記錄「live 驗證因服務未上線而未執行」，不要假裝測過。
- `20260903-multinode-transfer-nl-workflow` 已完成：Dashboard 現在有
  節點 selector，遠端 Protect/Verify 走 `readAttachment → protectFile/
  verifyFile` 兩步驟 plan，POST 到 `/api/run`，`filePath` 語意維持
  「執行節點自己的本機路徑」不變，這個 thread 應該沿用同一套慣例，不要
  另外發明一套。
- `AgentServer.ts` 的 `POST /api/plan`（約 506 行起）目前只接受
  `{ task, ctx }`，呼叫 `this.planning.plan(body.task, ctx)`——**沒有任何
  欄位可以帶入「使用者已經選好的附件」**，查過整份 `NLPlanningService.ts`
  也確認沒有現成的附件相關機制。這是本 thread 最大的未決設計問題，見下方
  Open Questions，不要自己假設一個答案就動工。

# Codex Notes

（尚未實作——見下方 Open Questions，這是本 thread 唯一但關鍵的設計問題，
需要先investigate 並把提案寫回這裡，經 Claude/使用者過目後才實作，不要
直接動手改 `NLPlanningService.ts` 的 prompt 組裝邏輯。）

# Claude Notes

（尚未審查）

# Review Findings

（尚未審查——本 thread 還沒有 Codex 實作可供審查）

# Test Plan

（等 Open Question 的設計方向定案後，Codex 應該在 Codex Notes 補上具體
測試計畫，不要照抄前兩個 thread 的 Test Plan——這個 thread 的核心風險在
「附件如何進到 LLM 產生的 plan 裡」，測試要優先覆蓋這一段，而非只是重複
前兩輪已經測過的 remote dispatch 機制本身。）

# Decisions

- Accepted（承接自 `20260903-multinode-transfer-nl-workflow`）：`filePath`
  語意不變、沿用 `_attachment`/`readAttachment` 慣例、不新增 artifact ID
  概念。
- Accepted（承接自更早的 thread）：`NLPlanningService.summarize()` 已經
  做過輸入驗證/截斷硬化，本 thread 直接沿用，不重做。

# Session Summary

本 thread 尚未開始實作。已確認 Accounting/LLM 目前都未上線，且查過
`AgentServer.ts`/`NLPlanningService.ts` 確認「已上傳的附件如何讓 NL
plan() 知道並正確引用」目前完全沒有設計——這是本 thread 唯一但關鍵的
開放問題，Codex 接手後第一步應該先investigate 並提案，不要直接實作。

# Open Questions

- **附件如何進到 LLM 產生的 plan 裡，這是本 thread 的核心設計問題**：
  使用者在 Dashboard 選好檔案後輸入自然語言任務，LLM 本身看不到附件
  內容，需要某種方式讓產生出來的 `ExecutionPlan` 正確包含
  `material.readAttachment` 步驟（或等效機制）。至少有兩個候選方向，
  Codex 應該讀過 `NLPlanningService.plan()` 與
  `HttpLLMClient.buildDefaultSystemPrompt()` 的實際 prompt 組裝邏輯後，
  評估哪個更符合現有架構、風險較低，寫成提案：
  1. **呼叫端自動注入**：`plan()` 的呼叫方（`/api/plan` 或 Dashboard）
     如果偵測到有已選定的附件，在 LLM 產生的 plan 前面自動插入一個
     `readAttachment` step，並且要讓 LLM 知道「有個附件會在
     `$steps.S0.output.filePath` 可用」，這樣它產生的 Protect/Verify
     step 才會正確引用這個路徑，而不是自己編一個 `filePath` 或留空。
     需要修改 system prompt 或 `LLMPayload`，讓 LLM 知道附件的存在——
     這塊 §RAG/拓樸設計文件裡討論過 `orchestrator.retrieveContext` 之類
     的動態 context 注入模式，可能可以參考類似做法，但這個 thread的
     需求比較單純，不確定是否需要整套 retrieveContext 機制才能解決，
     還是有更輕量的做法。
  2. **先落地再規劃**：附件在使用者輸入自然語言任務之前，先透過既有的
     `_attachment` 機制落地到某個節點（哪個節點？如果任務本身要指定
     節點，這裡有雞生蛋蛋生雞的問題，需要一併想清楚），拿到具體
     `filePath` 後，把這個路徑直接寫進送給 LLM 的 task 文字裡（例如
     「保護 node2 上路徑 X 的檔案」），LLM 不需要知道附件機制，只要
     正確抄這個路徑到它產生的 plan 裡。
  - **這題不要自己選一個就動工**，先把兩個方向的分析、以及讀過
    `NLPlanningService.ts`／`HttpLLMClient.ts` 後發現的任何其他限制，
    寫回這個 Open Questions 或新增一節，讓 Claude 過目後再決定要不要
    修改到需要動 `plan()` 核心 prompt 組裝邏輯的地步。
