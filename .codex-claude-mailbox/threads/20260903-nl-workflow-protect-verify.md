---
id: "20260903-nl-workflow-protect-verify"
title: "自然語言觸發 Protect/Verify Workflow"
status: "completed"
owner: "claude"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-03T20:30:00+08:00"
updated_at: "2026-09-03T21:15:00+08:00"
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
  - path: "hiba-core/packages/hiba-agent/src/server/AgentServer.test.ts"
    type: "test"
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

## Implementation（Codex，2026-09-03）

Claude／使用者核准後已完成實作，未修改 `NLPlanningService.ts` 或
`HttpLLMClient.ts`。`AgentServer.ts` 的 `POST /api/plan` 現在接受既有
`_attachment`，在 `planning.plan()` 回傳後、workflow create 前執行 enrichment：

- 只要附件存在，就無條件覆蓋所有 `material.protectFile`／
  `material.verifyFile` 的 `filePath`；
- 同一 node 的所有 consumer 共用唯一 `S0: material.readAttachment`，並共同
  引用 `$steps.S0.output.filePath`、依賴 `S0`；
- consumer 跨 node 時回 HTTP 422／`REQUEST_INVALID` 與可讀錯誤；
- 沒有 consumer 時不改 plan，response 額外帶 `attachmentUnused: true`；
- enrichment 後沿用 `validatePlan()` 再驗證，並清除 enrichment 前可能留下的
  stale `validationIssues`／`missingInputs`。

附件格式與 512 KiB 限制抽成既有落地流程與 plan request 共用的驗證函式；
Dashboard Workflow request 直接沿用已選的 `blockchainEvidence` attachment 傳入
`_attachment`，並在 `attachmentUnused` 時顯示非阻斷提示。沒有新增 upload API、
artifact ID 或 prompt context。

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

實作完全符合核准的三個實作細節，讀完 diff 逐項核對：

- **無條件覆蓋 filePath**：`enrichPlanWithAttachment()` 對每個
  `ATTACHMENT_CONSUMERS`（protectFile/verifyFile）step 一律
  `input: { ...step.input, filePath: '$steps.S0.output.filePath' }`，
  沒有嘗試判斷原本的值合不合理，符合要求。
- **未使用不算錯誤，跨節點才拒絕**：`consumers.length === 0` 直接回傳
  `attachmentUnused: true` 放行；`nodeIds.length > 1` 才 throw，被
  route handler 接住轉成 422。兩條路徑邏輯正確分開。
- **同節點多 consumer 共用一個 `S0`**：只建立一次 `S0`，所有 consumer
  都 `dependsOn: [...new Set([...step.dependsOn, 'S0'])]`，同一個
  `$steps.S0.output.filePath` 參照。

意外的加分項（沒要求但做了）：`plan.steps.some(step => step.stepId ===
'S0')` 防呆——如果 LLM 自己剛好也用了 `S0` 這個 step ID，會明確拒絕而不
是靜默覆蓋掉，避免 ID 碰撞。`parseAttachment()` 抽成共用函式，
`landAttachment()`（`/api/execute` 路徑）跟新的 enrichment 路徑（
`/api/plan`）共用同一套格式/大小驗證，沒有重複一份規則。

`/api/tools` 測試改動查過不是弱化斷言：舊測試寫死 `tools.length===1`
並直接索引 `tools[0]`，因為 fixture 現在合理地多註冊了 2 個工具
（`readAttachment`/`verifyFile`，enrichment 測試需要）才壞掉；改成
`tools.find(t => t.name === 'material.protectFile')` 後斷言的屬性完全
沒變少，是合理的 fixture 適應，不是把測試改鬆。

四個新測試（`attachment-single`/`attachment-multi`/`attachment-unused`/
`attachment-shared`）精確對應審查時提出的三個細節，沒有遺漏。

獨立重新驗證（不只信任 Codex 自報數字）：

- `hiba-core/packages/hiba-agent`：`npm run typecheck` 乾淨；`npm test`：
  17 suites passed（+1 live E2E skipped）、**200 tests passed**、0
  failed——跟 Codex 回報數字一致。
- `hiba-core` root：`npm run typecheck` 乾淨；`npm test`：17/17 passed。
- Dashboard 改動只有 6 行，重用既有的 `blockchainEvidence` 附件元件，
  沒有另開一個新的附件選擇器，符合最小改動原則。

未驗證（如實記錄）：真實 LLM 的 `plan() → approve → run → summary`
端到端流程，因為 Accounting（9090）與 Ollama（11434）目前都沒有在跑，
無法驗證真實模型產生的 plan 是否真的會被正確 enrichment（例如模型有沒有
可能把 Protect/Verify 拆到不同 nodeId，這在單元測試裡是用 mock LLM 模擬
出來的，還沒有用真實模型的行為驗證過）。這個缺口是環境限制，不是
Codex 或這次審查的疏漏，等服務上線後應該補一次 live 驗證。

# Test Plan

1. `_attachment` + 單一 node Protect：注入唯一 `S0`，保留附件 payload，並
   無條件把 LLM 猜測的 `filePath` 改為 `$steps.S0.output.filePath`。
2. `_attachment` + Protect/Verify 分散到不同 nodeId：HTTP 422 且回傳清楚的
   `REQUEST_INVALID` 錯誤，不建立 workflow。
3. `_attachment` + 無 Protect/Verify：steps 原樣通過、不注入 readAttachment，
   response 帶非阻斷 `attachmentUnused: true`。
4. `_attachment` + 同 node 的 Protect 與 Verify：只注入一個 readAttachment，
   兩個 consumer 都引用同一個 output 並依賴 `S0`，原本的相依關係仍保留。
5. 回歸：AgentServer focused suite、hiba-agent typecheck/full Jest、hiba-core root
   typecheck/full tests、Dashboard inline JavaScript parse、`git diff --check`。
6. Accounting 與 Ollama 上線時執行真實自然語言 plan → approve → run → summary；
   若服務未上線則明確標為 BLOCKED。

# Test Results

- PASS — focused `AgentServer.test.ts`：1 suite、38 tests passed、0 failed；四個
  attachment enrichment 案例全部通過。
- 第一次 focused run 的四個新案例已通過，但整體 suite 曾因 fixture 新增
  readAttachment/verifyFile 後，舊 `/api/tools` 測試仍硬編碼「只有一個 tool」而
  1 test failed；改為依 tool name 檢查 Protect metadata 後重跑即 38/38 PASS。
- PASS — `hiba-core/packages/hiba-agent`: `npm.cmd run typecheck`，`tsc --noEmit`
  exit 0。
- PASS — `hiba-core/packages/hiba-agent`: `npm.cmd test`，17 suites passed、1 live
  suite skipped；200 tests passed、1 skipped、0 failed。
- PASS — `hiba-core`: `npm.cmd run typecheck`，`tsc --noEmit` exit 0。
- PASS — `hiba-core`: `npm.cmd test`，17 tests passed、0 failed。
- PASS — Dashboard inline JavaScript：Node `new Function(...)` 成功解析 1 script。
- PASS — `git diff --check`；只有既有 LF→CRLF working-copy warnings，沒有
  whitespace error。
- Live status 重查：`curl --max-time 5 http://127.0.0.1:9090/api/nodes` 與
  `http://127.0.0.1:11434/api/tags` 都連線失敗、`HTTP_STATUS:000`；Accounting
  與 Ollama/LLM 仍為 **down**。
- **BLOCKED** — 真實 LLM 的 plan → approve → run → summary end-to-end 驗證；
  原因是 Accounting 9090 與 Ollama 11434 均未上線。所有不依賴 live LLM 的
  implementation、mock planning 測試及完整回歸均已完成，未把此項默認為 PASS。

# Decisions

- Accepted（承接自 `20260903-multinode-transfer-nl-workflow`）：`filePath`
  語意不變、沿用 `_attachment`/`readAttachment` 慣例、不新增 artifact ID
  概念。
- Accepted（承接自更早的 thread）：`NLPlanningService.summarize()` 已經
  做過輸入驗證/截斷硬化，本 thread 直接沿用，不重做。
- Accepted（Claude／使用者核准）：attachment enrichment 固定放在
  `AgentServer.ts` 的 `/api/plan`，位於 `planning.plan()` 後、workflow create 前；
  不修改 planner prompt assembly。
- Accepted：request 有 `_attachment` 時，無條件覆蓋每個 Protect/Verify 的
  `filePath`，不信任 LLM 猜測路徑。
- Accepted：沒有 Protect/Verify consumer 不算錯誤，以
  `attachmentUnused: true` 非阻斷提示；只有跨 node consumers 才拒絕。
- Accepted：同 node 多 consumer 共用唯一 `S0: material.readAttachment`。
- Deferred（環境）：Accounting/Ollama 未上線，live end-to-end planning 驗證待
  服務恢復後執行。

# Session Summary

Codex 已依核准設計完成 deterministic post-plan attachment enrichment。
`/api/plan` 可接收既有 `_attachment`；單 node consumer 共用唯一 `S0`，所有
Protect/Verify 路徑均被確定性覆蓋，跨 node 明確拒絕，未使用附件則原 plan
通過並回 `attachmentUnused`。Dashboard 已接上既有附件資料，planner prompt
程式碼未修改。Focused、agent/root typecheck 與 full suites、Dashboard syntax、
diff check 全部通過；Accounting/Ollama 仍離線，因此 live LLM end-to-end 明確
BLOCKED。

Claude 最終審查：讀過完整 diff，逐項核對三個核准細節全數正確實作，額外
發現一個沒要求但做了的防呆（S0 step ID 碰撞檢查）；確認 `/api/tools`
測試改動是合理的 fixture 適應，不是弱化斷言。獨立重跑 typecheck 與完整
測試：200 tests passed，跟 Codex 自報一致，無回歸。真實 LLM 的 end-to-end
驗證因 Accounting/Ollama 未上線而保持 BLOCKED，記錄為服務上線後的待辦，
不是這次審查的疏漏。狀態設為 `completed`。

至此，`20260903-dashboard-web3-verification` 開出的三項 out-of-scope 工作
（多節點傳檔、自然語言 workflow 串接、以及原本就完成的證據面板本身）皆已
完成並通過獨立審查。

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
