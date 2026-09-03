---
id: "20260903-plan-local-tool-routing"
title: "plan() 無法正確規劃本機專屬工具（nodeId='local'）"
status: "draft"
owner: "codex"
reviewer: "claude"
priority: "high"
created_by: "claude"
created_at: "2026-09-03T21:40:00+08:00"
updated_at: "2026-09-03T23:45:00+08:00"
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

## Worked-example 修正提案（Codex，2026-09-03；文字提案，未寫檔/未跑 apply_patch）

依照使用者核准的派工要求（見上方 Open Questions「已決定」），Codex 針對
方向 A（換掉 Example 2 字面值）與方向 B（新增 local worked example）
各自提出具體草稿與風險評估，這次沒有嘗試寫檔案，內容由 Claude 手動
轉貼進本 thread。

**總結建議**：先單獨評估方向 A。如果 A 就能修好 local 路由且沒有回歸，
只上 A，不需要 B。如果 A 不夠，再評估 A+B 一起上。不建議單獨上 B。
A 跟 B 是互補關係，不是互斥：A 移除誤導性的既有字面值範例、擾動最小；
B 補一個正面的 local 範例，但有讓模型把 `material.*` 操作過度導向
`local` 的風險；如果保留舊的 `node1` Example 2 又加上 B，會讓同一個
工具家族出現兩個互相競爭的範例。

**方向 A — 替換 Example 2 字面值**

具體 diff：把 Example 2 的 task 文字與字面值換成描述性 placeholder
（`<TASK_NODE_ID>`、`<TASK_FILE_PATH>`），JSON 範例裡的 `nodeId`／
`filePath` 也同步換成這兩個 placeholder，並在 Example 2 標題註記
「replace `<...>` from the task」。Codex 特別說明：選描述性
placeholder（而非泛用的 `<NODE>`/`<FILE>`）是刻意的，因為更容易被
模型正確理解成「要替換」而非「照抄」。

長度影響：約 +89 字元/+89 UTF-8 bytes（約 20-30 token，需用實際
tokenizer 或 Ollama `prompt_eval_count` 確認），範例數量、順序、
工具名稱、依賴結構、JSON 形狀都不變——是三個候選裡擾動最小的。

風險評估：低到中。緩解因素：Example 1、Example 3 仍保留真實 `node1`
範例；Example 2 仍然示範「明確指定的節點要傳遞到每個相依步驟」這個
教訓；Rule 3 仍然禁止用 local 取代明確指定的節點。具體風險：(1) 模型
可能把 placeholder 字面值（`<TASK_NODE_ID>` 等）原樣輸出，驗證時必須
把這種洩漏視為失敗；(2) 拿掉 `material.verifyFile→protectFile` 唯一
範例裡的具體 `node1`，可能弱化這條 material 工作流程本身的真實節點
路由能力；(3) A 有可能因為只是移除壞錨點、沒提供正面的 local 範例，
仍然修不好 local case。

**方向 B — 新增專屬 local worked example**

具體草稿：在 Example 2 後面插入新的「Example 2b」（用 2b 是為了不用
重新編號 Example 3 及其引用），情境是「保護檔案 /uploads/report.xml」
（未指定節點）、Available Tools 只有 `material.protectFile`、沒有
online 節點掛載或可安裝，正確輸出是單一步驟、`nodeId:"local"`。
Codex 特別指出：刻意選用目前正在失敗的 `material.protectFile` 當
範例工具，是為了直接對抗目前觀察到的照抄行為；換成別的工具雖然能
降低「同工具」偏誤，但可能沒辦法真正克服 live 驗證看到的那種照抄。

長度影響：約 +566 字元/+604 UTF-8 bytes（約 130-170 token），worked
example 從 3 個增加到 4 個，且是同一個 `material.protectFile` 工具
的第二個範例、還帶一個具體 `nodeId:"local"` 輸出——比 A 的 prompt
形狀改動明顯更大。

風險評估：中到高。具體風險：(1) 因為觀察到的模型會積極照抄同工具
範例，可能導致原本應該路由到真實節點的 `material.protectFile`／
`verifyFile` 任務被誤導去用 `local`；(2) 可能過度泛化，只要任務沒
指定節點就傾向用 `local`，即使其實有 online 可執行或可安裝的節點；
(3) 可能連 `/uploads/report.xml` 這個範例路徑本身都被照抄（NL
workflow 的 attachment enrichment 在某些流程可能會蓋掉這個問題，
但必須額外檢查模型的原始輸出，不能只看 enrichment 後的結果）；
(4) 範例放在 Example 2 之後會有「鄰近效應／同工具定錨」，如果之後
想改放別的位置，那本身又是另一個要單獨驗證的 prompt 形狀變數，
不該和第一輪實驗混在一起做。

**組合策略（建議順序）**：1. 先 benchmark 目前已 commit 的 Rule-3
基準版本；2. 單獨 benchmark A；3. 如果 A 通過所有驗收門檻，就停在
A，不需要 B；4. 如果 A 仍無法修好 local 路由，再 benchmark A+B；
5. B 單獨的版本可以測、僅供診斷用途，不建議單獨上線。A+B 預期會比
單獨 B 更穩：A 移除同一個 material 工作流程裡衝突的具體 `node1`
範例，B 補上缺少的具體 local 範例；代價是更長的 prompt 跟更高的
local 過度路由風險。

**驗證計畫**：
1. 每個候選版本（baseline／A／B(僅診斷)／A+B）都必須完全透過
   `tools/print-system-prompt.ts` 重建正式生產 prompt，用同一組真實
   `resources`/`nodes`/`tools`/`requestedAt`（沿用當初失敗請求的
   那組），比對字元數/UTF-8 bytes/tokenizer 或 Ollama
   `prompt_eval_count`，確認除了提案改動之外沒有其他差異，也沒有
   context 被截斷。特別提醒：`benchmark_quality.py` 是吃 JSONL 裡
   已經存好的 `system` 文字，每個候選版本都要透過
   `build_c6_scenarios.py`/`print-system-prompt.ts` 重新產生資料集，
   不能沿用舊的 JSONL，否則根本沒測到候選 prompt。
2. 針對 local case，先用 `temperature=0` 直接查 Ollama 拿原始輸出，
   再測真實 `/api/plan`：(a) 沒有可用 online 節點時「保護檔案
   /tmp/local-input.xml」——預期單一 `material.protectFile` 步驟、
   `nodeId:"local"`、路徑跟任務裡的完全一致；(b) 兩步驟 local
   鏈「先驗證 /tmp/local-input.xml，通過後再保護」——預期
   `verifyFile→protectFile` 都在 local、`dependsOn` 正確、沒有照抄
   範例路徑；(c) 原本失敗的附件工作流程「保護這份附件檔案並驗證
   完整性」——預期都在 local、`/api/plan` 通過驗證、attachment
   enrichment 正確替換路徑。只要原始輸出出現 `node1`、`a.xml`、
   `<TASK_NODE_ID>`、`<TASK_FILE_PATH>`，或（沒有在任務裡出現過的）
   B 範例路徑，就判定該候選版本不合格。
3. 真實節點路由回歸案例：「查詢 node1 的機台狀態」預期路由到
   `node1`；明確指定 `node8` 的 material 兩步驟鏈，兩步都要留在
   `node8`；明確指定某個掛載該工具的 online 節點時，`material.
   protectFile` 要用那個節點、絕不是 local；沒指定節點但有 online
   節點掛載該工具時，要用那個 online 節點、不是 local；沒指定節點、
   工具沒掛載但有 online 且 `canInstall=true` 的節點時，要維持現有
   的可安裝節點路由、不是 local。
4. 明確指定節點的安全案例：明確指定不存在的節點（沿用既有 C6 S13）、
   明確指定離線節點且沒有合法 delegation 對象、明確指定節點但要求
   一個本機可執行的 material 工具——每個案例都要斷言模型不會偷偷
   換成 local，錯誤/拒絕/既有 delegation 行為才是可接受結果（比照
   目前的 gold 標準）。
5. 完整 prompt-shape benchmark：`python
   training/data/build_c6_scenarios.py` 接著 `python
   benchmark_quality.py hiba-planner:v1-optimized --dataset
   training/data/hiba-c6-scenarios.jsonl --schema-format`，每個候選
   版本都要用各自重新產生的 JSONL，特別關注 C6 裡的 material/
   明確節點案例（S01、S04、S08、S10、S16、S19）以及整體節點路由
   分數。

**驗收門檻**：所有 targeted local case 都選到 local、通過
`validatePlan()`、工具/輸入/依賴都正確；所有明確指定節點的案例都
用到要求/預期的真實節點、絕不是 local；沒有任何原本正確的 C6 案例
因此新增節點路由失敗；整體節點分數與 exact-match 分數不能低於
baseline；原本那個真實失敗的 live request，在真實 AgentServer 重啟
後要能成功；獲勝候選版本的 targeted case 要重複跑三次，不能只憑一次
prompt 字串層級的單元測試當證據。如果 A 通過所有門檻，只上 A；如果
A 沒修好 local 路由但 A+B 通過所有門檻，上 A+B；如果 A+B 造成任何
「明確指定節點卻被路由到 local」的回歸，B 要打回，重新設計範例，
不要反過來削弱 Rule 3。

## 實作派工與再次唯讀錯誤（Codex，2026-09-03）

方向 2 核准後重新派工實作，Codex 這次同樣回報「workspace is read-only」，
`apply_patch` 被拒絕。依照上面環境注意事項的指示（遇到同樣錯誤不要重複
嘗試超過一次），Codex 沒有再重試，改成直接把準備好的完整內容（程式碼
patch、測試、Test Results/Decisions/Session Summary 文字）輸出在回應
文字裡，交給 Claude 手動套用。Codex 這邊的驗證是在記憶體內模擬完成的，
不是對真正落地的檔案跑的，這點很重要，見下一節。

## Claude 實際套用並用真實 live 環境重新驗證（2026-09-03，非 Codex 的記憶體內模擬）

Codex 沒有寫入權限，但 Claude 對這個 repo 有正常寫入權限，所以由 Claude
把 Codex 準備好的內容手動套用到實際檔案，並重新做一次完整的 live 驗證
（不是只信任 Codex 回報的「模擬通過」）：

**套用的變更**（`HttpLLMClient.ts`，尚未 commit）：
- `nodeId` 的 placeholder 說明文字，從
  `"<an online node from Live Node Descriptors>"` 改成
  `"<an online node from Live Node Descriptors, or local per Rule 3>"`。
- Rule 3 從「`nodeId` must be an online node that advertises the tool,
  or an online node with `canInstall=true`」，擴充成額外一段：「若任務
  沒有指定節點，且 Available Tools 裡列出的某個工具，找不到任何 online
  節點能執行/安裝，就用 `nodeId: "local"` 在 hiba-agent 本機 toolbox
  執行；但如果任務明確指定了某個節點，不能因為這個規則就改用 `local`
  取代」。
- `HttpLLMClient.test.ts` 新增一個測試，斷言重建出來的 system prompt
  裡確實包含上述新文字——這個測試**通過**（`npm test`：201 passed，
  比之前多 1 個，0 failed），但這個測試只驗證「新文字有沒有被塞進
  prompt 字串」，不驗證「模型看到這段文字後會不會真的照做」，這正是
  下面發現問題的地方。

**驗證步驟與結果（依序執行）**：
1. `npm run typecheck`（`hiba-core/packages/hiba-agent`）——乾淨無錯誤。
2. `npm test`——201 passed / 1 skipped / 0 failed。
3. 重啟真實 `AgentServer`（砍掉舊 PID，`npm run start:env` 重新啟動，
   確認新的 process 有在 8090 port 回應），確保改動真的被載入。
4. 重送原本失敗的那次真實 `/api/plan` 請求（保護附件檔案的任務）——
   **結果跟修正前完全一樣**，仍然是 `AGENT_NOT_REGISTERED`
   （`No online node can execute 'material.protectFile@1.0.0'`）。
5. 用 `tools/print-system-prompt.ts` 重建當次送出的真實 prompt，
   grep 確認新的 Rule 3 文字**確實存在**於送給模型的 prompt 裡
   （排除「修正沒被載入」這個可能性）。
6. 換一個更簡單的任務（「保護這個檔案」）——同樣失敗。
7. 繞過 `NLPlanningService`/`validatePlan`，直接用 `temperature=0`
   把同一份真實 prompt 送給 Ollama，拿模型的原始輸出：
   ```
   {"toolName":"material.protectFile","nodeId":"node1","input":{"filePath":"a.xml",...}}
   ```
8. grep 整份 prompt，找到根因：prompt 裡的「Example 2」（一個
   `material.verifyFile` → `protectFile` 兩步驟 worked example，剛好
   就是同一個工具）使用了字面值 `nodeId:"node1"`、`filePath:"a.xml"`。
   模型完全照抄這個範例的字面值，無視新加的 Rule 3 文字。

**結論修正（推翻上面「核准方向 2，可以進入實作」的結論）**：

方向 2 的最小 prompt 規則修改，經過真實 live 環境重新驗證，**不足以
解決問題**。根因不是「模型不知道 local 是合法選項」這麼單純——這段
新規則文字確實有被送進 prompt，但 worked example 裡的字面值範例對
這個模型的「照抄範例」拉力，強過抽象規則文字的約束力。這跟這個
session 前面已經確立的「這個模型對 prompt 形狀/worked example 特別
敏感」的發現（`plan_LLM_訓練清單.md` §十五-§十七）是同一種現象，只是
這次影響的是最簡單的單步驟案例，不是原本 Codex 提案裡當作邊角案例
看待的「異質工作流程」情境。

Codex 回報的「記憶體內模擬通過」跟這次真實 live 驗證的結果不一致——
差別在於 Codex 的模擬顯然沒有真的重建含 worked examples 的完整生產
prompt 去問真正的模型，只驗證了新文字有沒有被組進去。這是本 thread
到目前為止唯一一次出現「Codex 自我回報通過」跟「Claude 獨立 live 驗證」
結果矛盾的案例，記錄下來避免下次重蹈覆轍：**這類 prompt 行為修正，
"prompt 裡有沒有這段文字" 跟 "真的送真實模型會不會照做" 是兩件必須
分開驗證的事，只驗證前者不能宣稱修正完成。**

要真正解決，範圍會比原本核准的「只加一句 Rule 文字」大：至少需要
處理 worked example 本身，例如（1）把 Example 2 的字面值換成更明顯是
「範例佔位符」而非可照抄真實值的形式，或（2）額外加一個示範 `local`
用法的 worked example，讓模型有具體樣式可以照抄，而不是只靠抽象規則
文字對抗另一個範例的字面值拉力。這是比目前核准範圍更大的 prompt 形狀
改動，需要重新討論／核准，不能直接沿用方向 2 的核准繼續做。

`HttpLLMClient.ts`/`HttpLLMClient.test.ts` 目前的改動維持不 revert
（規則文字本身語意正確，之後處理 worked example 時仍然需要這個基礎），
但視為「必要但不足夠」的中間增量，會用誠實的 commit message 說明，
本 thread 狀態繼續維持非 completed，不進 review_requested。

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

已用真實 Ollama/Accounting/hiba-agent 三個 live 服務，驗證出這個缺口的
存在與確切根因（system prompt 從未提及 `local` 是合法 nodeId，即使
執行/驗證層都已支援）。Codex 提案並實作了方向 2（擴充 Rule 3 文字），
Claude 核准後把 Codex 準備的內容手動套用到真實檔案（Codex 沙箱唯讀，
無法自己寫入），typecheck／單元測試都過。但接著用真實 live 環境
（重啟 AgentServer + 重送原本失敗的請求 + 直接對 Ollama 做
`temperature=0` 原始查詢）重新驗證，發現**方向 2 不足以解決問題**：
prompt 裡「Example 2」worked example 的字面值（`node1`/`a.xml`）對這個
模型的照抄拉力，強過新加的抽象規則文字，模型仍然產生會觸發
`AGENT_NOT_REGISTERED` 的計畫。Codex 記憶體內模擬回報的「通過」跟這次
真實 live 驗證結果矛盾，根因是模擬沒有用含完整 worked examples 的真實
生產 prompt 去問真正的模型。目前 `HttpLLMClient.ts`/`.test.ts` 的改動
保留但不 commit 為「已解決」，thread 繼續維持非 completed 狀態，等待
下一步方向（處理 worked example 本身）重新討論／核准。

# Open Questions

- ~~修正方向未定案~~ **方向 2 已核准並實作，但 live 驗證證實不足夠**
  （見上方「Claude 實際套用並用真實 live 環境重新驗證」）。
- **待決定（新）**：如何處理 worked example 本身對模型的字面值拉力，
  至少兩個候選方向，尚未討論／核准，需要使用者/Claude 一起決定：
  1. 把 Example 2（`material.verifyFile`→`protectFile`）裡的
     `nodeId:"node1"`、`filePath:"a.xml"` 換成更明顯是佔位符、不該被
     直接照抄的形式（例如更醒目的 placeholder 語法），降低字面值拉力，
     同時不新增 prompt 長度。
  2. 額外加一個示範 `nodeId:"local"` 用法的 worked example，讓模型有
     具體的「照抄樣式」可用，但這會增加 prompt 長度，且是這個 session
     已經證實過的高風險區域（worked example 對這個模型的影響力極大），
     需要比照 §十五-§十七 的方法論，用 `benchmark_quality.py` 或至少
     手動跑幾個既有已知案例（含真實線上節點路由案例）做前後 A/B 對照，
     確認沒有讓模型整體變得更容易誤判節點，才能核准。
  - 這是比原本核准範圍更大的 prompt 形狀改動，在有新方向核准前，不要
    再直接派工實作。
  - **已決定（使用者，2026-09-03）**：兩個方向都要 Codex 先提案（含
    具體改法 + 風險評估），不要直接實作，由 Claude/使用者核准後才進入
    實作階段。派工要求 Codex：
    1. 針對方向 1（換掉 Example 2 字面值）與方向 2（新增 local worked
       example），各自給出具體修改內容草稿。
    2. 每個方向都要評估對 prompt 長度/形狀的影響，以及是否可能讓既有
       已知會正確路由到真實節點（如 `node1`）的案例跑偏。
    3. 明確建議兩者是否該一起做、或先做哪一個、或彼此互斥，並說明理由。
    4. **不要在這次派工中直接寫檔案或跑 apply_patch**——先前兩次都遇到
       workspace read-only，這次先只要求文字提案，避免重複踩雷；提案
       內容確認方向後，再開下一輪派工做實作。
  - **提案已收到**：見上方「Worked-example 修正提案」小節。Codex 建議
    先單獨評估方向 A、A 不夠再上 A+B、不建議單獨上 B。等待使用者/
    Claude 核准要不要照這個順序實作，以及是否要求先跑 A 的
    `benchmark_quality.py` A/B 對照再決定要不要繼續做 B。
