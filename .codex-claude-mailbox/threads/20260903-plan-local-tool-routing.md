---
id: "20260903-plan-local-tool-routing"
title: "plan() 無法正確規劃本機專屬工具（nodeId='local'）"
status: "draft"
owner: "codex"
reviewer: "claude"
priority: "high"
created_by: "claude"
created_at: "2026-09-03T21:40:00+08:00"
updated_at: "2026-09-03T22:00:00+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/planning/HttpLLMClient.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/planning/validatePlan.ts"
    type: "file"
---

# Goal

修正 `plan()` 完全無法正確規劃「只在 hiba-agent 本機可執行、Accounting
沒有對應線上節點掛載」的工具（例如 `material.protectFile`/`verifyFile`/
`readAttachment`）——這是在 `20260903-nl-workflow-protect-verify` 完成後
做 live 驗證時發現的既有缺口，不是那個 thread 的實作問題，是更底層、更
早就存在的 `plan()`/prompt 缺陷，會影響任何需要本機工具的自然語言任務。

# Success Criteria

- 自然語言任務明確或隱含需要本機工具時（例如「保護這份附件檔案並驗證
  完整性」，沒有指定節點），`plan()` 產生的 `ExecutionPlan` 能正確使用
  `nodeId: 'local'`，通過 `validatePlan()`，不再出現
  `AGENT_NOT_REGISTERED`。
- 不能靠犧牲既有行為換取這個修正：目前能正確規劃到真實線上節點（例如
  之前 session 測過的 `machine.queryStatus` on `node1`）的任務，修正後
  必須維持正確，不能因為新增了「local」選項而讓模型開始亂猜。
- 修正範圍盡量小，優先考慮不需要改 `validatePlan()`（已經支援
  `nodeId==='local'` 的特殊處理，見下方 Current Context）。

# Current Context

**已用 live 服務（Ollama `hiba-planner:v1-optimized`、Accounting、
hiba-agent 三者都實際啟動）驗證過，不是理論推測**：

- 送出真實任務「保護這份附件檔案並驗證完整性」+ 附件，`POST /api/plan`
  回傳 `error: "Plan validation failed: ... No online node can execute
  'material.protectFile@1.0.0'"`（`AGENT_NOT_REGISTERED`）。這發生在
  `NLPlanningService.plan()` 內部驗證階段，比
  `20260903-nl-workflow-protect-verify` 新增的 attachment enrichment
  （在 `AgentServer.ts` 的 `/api/plan` handler 裡，`plan()` 回傳**之後**
  才執行）還早，enrichment 邏輯根本沒有機會執行到。
- 直接重建當次的真實 system prompt（`tools/print-system-prompt.ts`）
  逐行核對，確認根因：
  - `HttpLLMClient.ts` 的 `buildDefaultSystemPrompt()` 產生的 Rules
    區塊明確寫「`nodeId` must be an online node from Live Node
    Descriptors」（第 150 行附近），且 worked example 也只示範真實節點
    ID（如 `node1`），**完全沒有提到 `local` 是合法選項**。
  - Accounting 目前的 5 個預設節點（`node-1`~`node-5`）全部
    `status=offline`，也沒有一個掛載 `material.*` 工具——`material.
    protectFile`/`verifyFile`/`readAttachment` 只出現在 system prompt
    獨立的「Available Tools」清單裡，從未被關聯到任何 nodeId。
  - 這代表：無論 Accounting 節點狀態如何，**LLM 從 prompt 裡拿不到任何
    「這個工具可以用 nodeId='local' 執行」的訊號**，只能照 Rules 字面
    意思去找一個 online 節點，但沒有一個對得上。
- **好消息（已查證，不是猜測）**：`validatePlan.ts` 第 59 行——
  `if (step.nodeId !== 'local' && !hasExecutableNode(step, nodes))`——
  已經對 `nodeId==='local'` 做了特殊處理，會跳過「必須是 online 節點」
  的檢查。也就是說**執行與驗證層已經完整支援 `local`，唯一缺的是 LLM
  規劃階段從未被告知這個選項存在**——這是一個範圍很集中的 prompt/context
  層修正，不需要動 `validatePlan()` 或 `OrchestratorRunner.ts`
  （`dispatchStep()` 本來就有 `if (step.nodeId === 'local')` 的分支，
  執行端也已經支援）。
- `NLPlanningService.plan()` 目前送給 LLM 的 `nodes`/`resources` 完全
  來自 `this.accounting.listNodeResources()`/`listNodes()`——沒有任何
  地方合成一個代表「hiba-agent 本機自己」的虛擬節點。

# Codex Notes

## 調查與提案（Codex，2026-09-03；透過 `/codex:result` 手動補寫進 thread）

> 這次 Codex 執行環境本身回報「workspace is read-only，apply_patch 被拒絕」，
> 沒辦法自己把結果寫回這個檔案，調查內容是由 Claude 從 `/codex:result` 的
> 輸出手動轉貼進來的，不是 Codex 自己寫的——內容本身已經是 Codex 完成調查後
> 的產出，只是寫入管道這次失敗了。

**已用 live 服務重現問題**：Ollama `11434`、Accounting `9090`、hiba-agent
`8090` 都回 HTTP 200；實際送 `/api/plan` 重現出跟 Claude 一樣的結果——
`material.protectFile@1.0.0` 回傳空 `steps` + `AGENT_NOT_REGISTERED`。
根因確認跟 Claude 的 Current Context 一致：prompt 只允許 online 節點，
但 `validatePlan()`／`OrchestratorRunner` 已經支援 `nodeId: "local"`。

**建議採方向 2（明確 prompt 規則），不建議方向 1（合成虛擬節點描述）**：

- 合成虛擬 `local` 節點描述會把完整的 37-tool 目錄複製一份塞進 Live
  Node Descriptors 區塊（估算每個 capability list ~1030 字元），大幅
  改變 prompt 形狀，且有風險讓原本該用真實節點的任務被誤導去用 `local`。
- 改採方向 2：(a) 調整 `nodeId` 的 placeholder 文字；(b) 擴充 Rule 3——
  「沒有指定節點的任務，只有在沒有任何 online 節點能執行/安裝該工具時，
  才使用 `local`」。這是對既有 prompt 結構改動最小的做法。

**提議的驗證計畫**（尚未執行）：本機單/多步驟案例、既有已知案例
（如 `node1` 路由）修正後維持不變、明確指定但不可用節點時的行為、
prompt 長度前後對照、以及比照 production 形狀的 A/B benchmark。

（實作前仍需 Claude／使用者核准這個方向，且需要重新確認 Codex 這次的
寫入環境問題不會在實作階段又發生——見下方 Claude Notes。）

# Claude Notes

Live 驗證過程與根因定位記錄於上方 Current Context，逐行讀過
`HttpLLMClient.ts`、`validatePlan.ts`、`OrchestratorRunner.ts` 相關程式碼
後確認：這是 prompt 層級的資訊缺口，不是驗證或執行邏輯的 bug，執行端
已經完整支援 `local`。

## 提案審查（Claude，2026-09-03）——核准方向 2，補寫入環境注意事項

**核准方向 2（明確 prompt 規則），不採方向 1**。Codex 的理由站得住腳：
方向 1 把 37 個工具的完整目錄複製進 Live Node Descriptors，等於同一份
資訊在 prompt 裡重複兩次，對 prompt 大小跟形狀的影響遠比方向 2 大，跟
這個 session 已經確立的「盡量減少對這個模型 prompt 形狀的擾動」原則
不符。方向 2 只加一句 Rule 文字，改動面小很多，是對的選擇。

驗證計畫（本機案例／既有案例不受影響／明確指定不可用節點／prompt 長度
對照／A/B benchmark）涵蓋了我原本要求的風險評估，沒有遺漏，核准直接
照這個做，不需要再補細節。

**環境注意事項**：這次 Codex 的執行環境回報「workspace is read-only」
導致寫不回這個檔案，跟這個對話 session 稍早在訓練那條線上踩過的沙箱
寫入限制（`plan_LLM_訓練清單.md` §二十）性質類似但範圍不同——那次是
完全無法寫任何暫存檔，這次是能完成調查、只是寫不回這個特定檔案，且
Codex 在同一個 session 稍早才成功寫過其他 thread 檔案，判斷比較像是
暫時性問題，不是這個檔案／路徑本身有結構性障礙。實作階段重新派工時，
如果又遇到同樣的唯讀錯誤，不要重複嘗試超過一次，直接回報，改由 Claude
接手把 Codex 給的內容手動寫入（就像這次一樣）。

# Review Findings

（尚未審查——本 thread 還沒有 Codex 實作可供審查）

# Test Plan

（等 Open Question 的修正方向定案後，Codex 應該補上具體測試計畫，至少要
包含：(1) 本機工具任務能正確產生 `nodeId:'local'` 並通過驗證；(2) 既有
「任務指定真實線上節點」的行為不受影響，用真實或 mock LLM 對照都要驗證
過；(3) 如果修正涉及 system prompt 文字改動，需要比照
`plan_LLM_訓練清單.md` §十五-§十七 的方法論，用 `benchmark_quality.py`
或至少手動對照幾個既有案例，確認沒有讓模型整體變得更容易誤判節點。）

# Decisions

（尚未指派）

# Session Summary

本 thread 尚未開始實作。已用真實 Ollama/Accounting/hiba-agent 三個 live
服務驗證出這個缺口的存在與確切根因（system prompt 從未提及 `local` 是
合法 nodeId，即使執行/驗證層都已支援），下一步交給 Codex investigate 並
提案修正方式。

# Open Questions

- **修正方向未定案，Codex 應該提案而非直接實作**：至少兩個候選方向，
  1. 讓 `NLPlanningService.plan()` 合成一個代表 hiba-agent 本機的虛擬
     `NodeDescriptor`（例如 `nodeId: 'local', status: 'online'`，
     `resources` 帶入本機 toolbox 的完整工具清單），塞進送給 LLM 的
     `nodes`/`resources`，讓它自然出現在「Live Node Descriptors」裡，
     不需要改 Rules 文字本身。
  2. 在 `buildDefaultSystemPrompt()` 的 Rules 或另一個區塊明確加一句
     「沒有掛載在任何線上節點上的工具，使用 `nodeId: 'local'`」，不用
     合成假節點，直接講規則。
  - 兩者都會改變 LLM 實際看到的 prompt 內容——**這正是這個 session 已經
    證實過的高風險區域**（§十五-§十七 的縮減工具目錄教訓），Codex 應該
    在提案裡明講風險評估：哪個方向對既有 prompt 結構改動較小、較不容易
    讓模型對其他既有案例（已經測過會正確用真實節點 ID 的那些任務）
    產生非預期的行為改變。不確定風險大小時，應該建議搭配
    `benchmark_quality.py` 或至少手動跑幾個既有已知案例做前後對照，
    不要只憑直覺判斷「應該不會有影響」。
  - **已解決**：Codex 提案方向 2（擴充 Rule 3 文字 + 調整 nodeId
    placeholder），Claude 已核准，見上方 Claude Notes。可以進入實作。
