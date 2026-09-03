---
id: "20260903-nl-workflow-protect-verify"
title: "自然語言觸發 Protect/Verify Workflow"
status: "draft"
owner: "codex"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T20:30:00+08:00"
updated_at: "2026-09-03T20:50:00+08:00"
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

## 設計提案（Codex，2026-09-03；proposal written, awaiting review）

**建議採方案 (a) 的低風險變體：在既有 `/api/plan` 邊界做 deterministic
post-plan enrichment，不讓 LLM 規劃附件傳輸細節。** Dashboard 將已選附件以
既有 `_attachment: {name, content}` 欄位隨 plan request 帶入；
`NLPlanningService.plan()` 仍只處理原始自然語言並產生 Protect/Verify 業務步驟。
LLM plan 回來後、workflow 被保存及回傳前，由 `/api/plan` 呼叫端確定性地：

1. 在實際執行 Protect/Verify 的同一 `nodeId` 前置一個
   `material.readAttachment` step（例如 `S0`），其 input 使用既有
   `_attachment`；
2. 將該節點上的 `material.protectFile`／`material.verifyFile` 的 `filePath`
   設為 `$steps.S0.output.filePath`，並把 `S0` 加入 `dependsOn`；
3. enrichment 後重新驗證完整 plan，再交給既有 approve/run/store 流程。

這不是 artifact-ID 或新上傳協定：附件仍由目標執行節點的既有
`AgentServer.landAttachment()` 落地，`filePath` 仍只代表該節點自己的本機
路徑。附件內容與暫存路徑都不應送進 LLM prompt。第一版若 LLM 將同一附件的
Protect/Verify 分散到不同 node，應回傳可讀的規劃錯誤要求使用者選定單一節點，
不要靜默複製附件或猜測目標。

### Code evidence

- `NLPlanningService.ts:202-218`：`plan(task, _ctx)` 的 `_ctx` 完全未使用；它只
  取得 resources/nodes/tools，然後把 `task` 交給 `generateNormalizedPlan()`。
  `NLPlanningService.ts:269-272` 建立的 `LLMPayload` 只有 `task`、resources、
  nodes、tools、requestedAt，沒有附件欄位。因此目前已選附件不可能自行被 LLM
  感知。
- `HttpLLMClient.ts:39-45`：`complete()` 用 catalog/time 建 system prompt，並把
  `payload.task` 原樣當 user message；OpenAI 路徑在 `85-89` 行、Ollama 路徑在
  `108-111` 行都沒有其他動態附件 context。
- `HttpLLMClient.ts:334-348`：default system prompt 要求最少步驟，且明確禁止在
  使用者未要求時自行加入 attachment/material helper。其 worked example
  (`319-323`) 只示範既有 `filePath`，沒有「已選附件」語意。單改 prompt 仍沒有
  可提供的附件資料來源，也會把 transport concern 推給不確定的模型輸出。
- `AgentServer.ts:506-520`：`POST /api/plan` 現在只解析 `{task, ctx}` 並直接呼叫
  `planning.plan(body.task, ctx)`；`521-529` 隨即保存 workflow。因此 enrichment
  最合適的位置是 plan 回來後、workflow create 前，而不是改
  `plan()` 的核心 prompt assembly。
- 現有執行契約已支援這個 enrichment：`material.readAttachment` 的 output 含
  `filePath`（`hiba.tools.ts:834-877`），`OrchestratorRunner.ts:532-549` 已解析
  `$steps.<id>.output.filePath`，而前一 thread 已驗證 `_attachment` 隨 remote
  `/api/execute` 到目標節點後由該節點落地。

### 兩個原候選方案的取捨

- 原方案 (a) 若要求 LLM 自己產生 `readAttachment`，仍必須把附件存在性塞進
  task/system prompt，並依賴模型正確產生 step ID、reference、dependsOn 與同一
  nodeId。改成 deterministic enrichment 後，這些 transport invariant 由程式
  保證，且不需修改 `plan()` 核心 prompt assembly，風險較低。
- 不建議方案 (b)「先落地再把 path 寫進 task」：規劃前就必須先知道目標節點，
  但節點可能正是規劃結果；它也在人工 approve 前產生遠端寫檔副作用，讓 TTL
  暫存路徑面臨 plan/approve 間失效，並要求 LLM 正確抄寫不透明的本機路徑。
  這比在已核准 plan 的第一步沿用 `readAttachment` 更脆弱。

### Live service status and blocked verification

- 2026-09-03 17:02（Asia/Taipei）實際執行
  `curl --max-time 5 http://127.0.0.1:9090/api/nodes`：連線失敗，
  `HTTP_STATUS:000`；Accounting **down**。
- 同時實際執行 `curl --max-time 5 http://127.0.0.1:11434/api/tags`：連線失敗，
  `HTTP_STATUS:000`；Ollama/LLM **down**。
- 因兩者未上線，本次無法執行 Accounting-backed `/api/plan` 或 live LLM
  生成品質驗證；這兩項明確 **BLOCKED**。本次只完成程式碼調查與設計提案，
  沒有修改任何 implementation code、沒有進行假裝的 live 測試。

Thread status 保持 `draft`，語意為「proposal written, awaiting review」；待
Claude／使用者核准設計後才進入實作。

# Claude Notes

## 設計提案審查（Claude，2026-09-03）——方向核准，補三個實作細節

提案本身是好的，比原本我列的兩個候選方向都更好——**完全不動 `plan()`
核心 prompt 組裝**這點特別重要：這個對話 session 稍早花了很長篇幅（見
`plan_LLM_訓練清單.md` §十五-§十七）證實部署中的模型對 prompt 形狀
異常敏感，縮減工具目錄這種相對單純的改動都一度造成正確率從 89% 崩到
0%（後來查出是方法論問題才平反，但過程證明這個模型真的很脆弱）。
deterministic enrichment 完全不碰 LLM 看到的東西，風險特性跟這個已知
教訓一致，是對的判斷。

**核准這個方向**，但逐項推演後發現提案沒明講三個實作時會卡住的細節，
補在這裡，Codex 實作時直接照這個做，不用再等一輪來回：

1. **什麼時候要覆蓋 `filePath`，什麼時候不要**：LLM 不知道附件存在，
   遇到 Protect/Verify 任務時大概率會自己編一個看似合理的 `filePath`
   （跟已知的「幻覺工具名」是同一類失敗模式，只是這次是幻覺路徑）。
   規則訂為：**只要 `/api/plan` 這次 request 帶了 `_attachment`，就無條件
   覆蓋**該次 plan 裡所有 Protect/Verify step 的 `filePath`，不用嘗試判斷
   「LLM 原本填的是不是已經合理」——使用者既然透過 Dashboard 附件選擇器
   夾檔案，就是要用這個檔案，不需要保留 LLM 猜的路徑。
2. **附件跟 Protect/Verify 分散到不同 nodeId 時才報錯，沒有 Protect/
   Verify step 時不要報錯**：提案已經處理了「分散到不同節點」要報可讀
   錯誤，但沒講清楚「附件給了、但這次任務根本不需要 Protect/Verify」
   （例如使用者只是想查機台狀態，附件選了但沒用到）——這種情況**不是
   錯誤**，附件就是單純沒被用到，不需要注入任何 `readAttachment` step，
   也不用擋掉這次 plan。可以在回傳結果加一個非阻斷的提示欄位（例如
   `attachmentUnused: true`）讓 UI 決定要不要顯示，但不能是硬錯誤。
3. **同一節點多個 Protect/Verify step 共用同一個 `readAttachment`**：
   如果 LLM 產生的 plan 裡，同一個 nodeId 上有多個 step 都要用到這個
   附件（例如同節點先 Protect 再 Verify），只注入**一個** `S0:
   readAttachment`，所有消費它的 step 都把 `S0` 加進自己的
   `dependsOn`、都引用同一個 `$steps.S0.output.filePath`——不要每個
   消費 step 各自插一個 `readAttachment`，會造成同一份內容重複落地、
   浪費暫存空間，也違反前一個 thread 定的「filePath 就是本機路徑」單一
   事實來源精神。

以上三點屬於「怎麼把已經核准的方向做對」的實作細節，不是要重新開一輪
設計討論，可以直接照這個進入實作。

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
  - **已解決**：Codex 提案「deterministic post-plan enrichment」（不動
    `plan()` prompt，在 `/api/plan` 回傳前用程式碼確定性插入
    `readAttachment` step），Claude 已核准方向，並補了三個實作細節
    （無條件覆蓋 filePath／附件未用到不算錯誤／同節點多 step 共用同一個
    `readAttachment`），見上方 Claude Notes。可以直接進入實作。
