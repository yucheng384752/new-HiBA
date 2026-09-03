---
id: "20260903-multinode-transfer-nl-workflow"
title: "多節點檔案傳輸與自然語言 Workflow 串接"
status: "draft"
owner: "none"
reviewer: "none"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T18:10:00+08:00"
updated_at: "2026-09-03T18:10:00+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.tools.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/server/AgentServer.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/server/OrchestratorRunner.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts"
    type: "file"
  - path: "scripts_pi/claw-dashboard.html"
    type: "file"
---

# Goal

延續 `20260903-dashboard-web3-verification`（已完成）留下的兩項 out-of-scope
工作：(1) 讓 FileProtection 檔案能傳給非 hiba-agent 本機的其他節點；(2) 讓
Protect/Verify 能透過自然語言 plan → approve → run 觸發，而不是只有
Dashboard 上手動點的證據面板。

# Success Criteria

- 至少兩個已註冊節點能各自完成一次「上傳 → Protect」，不依賴 Windows/Linux
  絕對路徑跨機傳遞（`hibaFileRequest` 目前是 `readFile(filePath)` 直接讀
  hiba-agent process 所在機器的本機路徑，見前一個 thread 的 Review
  Findings）。
- OrchestratorRunner 對這類步驟的 trace/audit 記錄能對應到實際執行節點。
- 自然語言任務（例如「保護 node2 上的某檔案，驗證後給我摘要」）能經
  `plan() → approve → run` 產生依賴鏈並拿到 LLM 摘要，沿用既有
  `NLPlanningService.summarize()`（已在別的 thread 做過輸入驗證/截斷硬化，
  見 `plan_LLM_訓練清單.md` 相關記錄，不需重做）。
- Accounting／LLM 服務上線後才能實測，不是本 thread 自己起服務。

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

（尚未指派，等 owner 確認方向後填寫）

預先列出前一個 thread 就發現、但故意留到這裡的設計問題，供實作前參考：

- 多節點傳檔的候選方案至少有兩種，需要在動工前選定：(a) 沿用
  `_attachment` 的 base64/文字內容欄位，讓 `OrchestratorRunner` 對
  `dispatched: 'remote'` 的 Protect/Verify 步驟時，把已經落地的檔案內容
  一併塞進 `/api/execute` 的 request body（簡單，但大檔案會讓 JSON body
  變大）；(b) 目標節點回頭用某種下載端點主動拉檔案（需要新設計一個檔案
  下載 API，並處理跨節點認證）。兩者對「512 KiB 上限」這個既有限制的影響
  不同，需要一併決定。
- 目前 `material.protectFile`/`verifyFile` 的 `filePath` 欄位語意是
  「hiba-agent 本機路徑」，多節點情境下語意會變成「目標執行節點的本機
  路徑」還是「一個可以被任何節點解析的 artifact 識別碼」，需要先講清楚，
  不要讓兩種語意混用。

# Claude Notes

（尚未審查）

# Review Findings

（尚未審查）

# Test Plan

（尚未指派）

# Decisions

（尚未指派）

# Session Summary

本 thread 尚未開始實作，先記錄目標與前一個 thread 遺留的設計問題。

# Open Questions

- 多節點傳檔採 (a) 附件內容隨 request body 傳送，還是 (b) 目標節點主動
  拉取，尚未決定，需要使用者先選一個方向再讓 Codex 動工。
- `filePath` 語意在多節點情境下如何調整，尚未決定。
- 自然語言 workflow 這段是否要跟多節點傳檔同一輪做，還是拆成兩個更小的
  thread，尚未決定。
