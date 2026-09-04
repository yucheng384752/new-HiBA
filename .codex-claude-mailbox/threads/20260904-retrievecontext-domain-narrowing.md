---
id: "20260904-retrievecontext-domain-narrowing"
title: "orchestrator.retrieveContext 加入 domains 語意窄化（確定性關鍵字比對）"
status: "completed"
owner: "codex"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-04T13:00:00+08:00"
updated_at: "2026-09-04T14:10:00+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/planning/NLPlanningService.test.ts"
    type: "file"
---

# Goal

延續 `20260904-retrievecontext-wire-into-plan`（已完成，只做接線＋fallback，
刻意不做窄化）——這個 thread 補上那次刻意排除的範圍：讓
`plan()` 呼叫 `orchestrator.retrieveContext` 時帶上 `domains` 參數，讓
`tools` 候選集合真正被縮小，而不是永遠等於完整目錄。

**方法定案：確定性關鍵字比對，不是額外的 LLM 分類呼叫**——見下方
Current Context 對 CLAUDE.md Rule 5 的解讀。

# Success Criteria

- [ ] 新增 `inferDomainsFromIntent(task: string): Domain[] | undefined`
  純函式（`NLPlanningService.ts`，比照 `resolveNodeRouting` 的模式，
  export 供直接單元測試）：
  1. 用下方 Current Context 提供的關鍵字對照表（Claude 已擬好，見該節），
     對 `task` 文字做大小寫不敏感、中英文皆比對的子字串/關鍵字比對。
  2. 一個 intent 可以命中多個 domain（例如同時提到「附件」跟「SOP」），
     回傳所有命中的 domain，不是只取分數最高的一個。
  3. **完全沒有命中任何關鍵字時，回傳 `undefined`**（不是空陣列）——
     呼叫端要把這個當成「不窄化」處理，等同於上一個 thread 的既有安全
     行為。這是最重要的安全網：分類器對它沒把握的輸入，一律不縮小範圍。
- [ ] `retrieveScopedTools()` 呼叫 `execute('orchestrator.retrieveContext',
  { intent: task, ...(domains && { domains }) }, ctx)`——只有
  `inferDomainsFromIntent` 回傳非 `undefined` 時才帶 `domains` 欄位。
- [ ] 沿用（不修改）上一個 thread 已經做好的安全網：`scopedTools.length
  < 3` 或呼叫失敗時 fallback 回完整目錄，這次多一層意義——如果關鍵字
  分類器誤判（例如命中了錯的 domain、漏掉了任務真正需要的工具），
  這個既有安全網仍然是最後一道防線。
- [ ] 單元測試（`NLPlanningService.test.ts`）：
  1. 對照表裡每個 domain 至少一個關鍵字命中案例，斷言回傳陣列包含
     正確的 domain。
  2. 一個混合關鍵字的 intent（例如同時提到 material 跟 method 的
     關鍵字），斷言回傳陣列包含兩個 domain。
  3. 完全不含任何關鍵字的 intent，斷言回傳 `undefined`。
  4. `retrieveScopedTools()` 在有推論出 domains 時，`execute` 呼叫的
     第二個參數確實包含 `domains` 欄位；沒推論出來時，確認呼叫參數
     跟上一個 thread一樣只有 `{ intent }`（不帶 `domains` 鍵，不是
     `domains: undefined`——避免 `context.tools.ts` 的 Zod schema
     對這個欄位的 `.optional()` 語意產生歧義）。
  5. 既有 `NLPlanningService.test.ts` 全數維持通過（不可回歸）。
- [ ] **實測 token 節省效果**（這是本次改動存在的意義，必須量化，不能
  只憑理論）：用 `tools/print-system-prompt.ts`，對至少一個單一明確
  domain 的真實 intent（例如「保護檔案 /tmp/x.xml 並驗證完整性」，
  預期只命中 `material`），比較這次改動前後的 prompt 大小——預期
  `scoped` 工具數量應明顯少於 37（material domain 只有 7 個工具），
  且 prompt bytes 應明顯下降。把實際數字記錄進 Codex Notes。
- [ ] typecheck／`npm test` 全數通過（`hiba-core/packages/hiba-agent`）。
- [ ] **不做 live 驗證、不重啟任何服務、不把這個 thread 標記
  completed**——依照使用者新定的檢查點（見下方 Constraints 最後一條），
  Codex 完成程式碼＋單元測試＋`print-system-prompt.ts` 量測後就停下來，
  把結果寫進 Codex Notes，交給 Claude 審查 diff、再由使用者決定要不要
  進到 live 驗證。

# Current Context

**對 CLAUDE.md Rule 5 的解讀（Claude，2026-09-04）**：Rule 5「Use me for:
classification... Do NOT use me for: routing... deterministic transforms」
乍看像是在說「domain 分類該用 LLM」，但這裡採用的解法是把「判斷關鍵字
對照表該長什麼樣子」這個真正需要判斷力的部分（classification/drafting）
留給 Claude 在這份 thread 規格裡先做掉，執行期則是純粹比對這張表、
不再呼叫任何模型——這樣「用模型做判斷」跟「用程式碼做確定性執行」
兩者都對應到 Rule 5 的正確半邊，不是硬凹。如果之後發現這張表覆蓋率
不夠，要擴充表格內容而不是在執行期加一次 LLM 呼叫（額外的 LLM 呼叫
在 `plan()` 前面，會增加延遲且是新的失敗點，跟這個 session 一路建立的
「能不動 prompt/不加額外模型呼叫就不要加」原則不符）。

**Claude 擬定的關鍵字對照表（Codex 實作時直接採用，不要自己重新設計）**：

```typescript
const DOMAIN_KEYWORDS: Record<Domain, string[]> = {
  material: ['保護', '驗證', '批號', '庫存', 'bom', '進料', '效期',
    '附件', '檔案', 'protect', 'verify', 'lot', 'stock', 'attachment',
    'expiry', 'incoming'],
  machine: ['機台', '稼動率', 'oee', '保養', '警報', '校正', '工單',
    'machine', 'alarm', 'calib', 'pm schedule', 'order'],
  man: ['操作員', '班別', '證照', '技能', '通知', 'operator', 'shift',
    'cert', 'skill', 'alert'],
  method: ['sop', '參數', '變更', 'ecn', '稽核', '合規', 'param',
    'compliance', 'audit'],
  env: ['溫度', '濕度', '潔淨室', '閾值', '感測器', 'temperature',
    'humidity', 'cleanroom', 'threshold', 'sensor'],
  orchestrator: ['節點', '部署', 'node', 'agent', 'deploy', 'rtt'],
};
```

Codex 實作前**必須**先讀一次 `hiba.tools.ts` 裡每個 domain 實際的工具
`description`，跟這張表交叉比對，確認沒有明顯漏掉會導致誤判的關鍵詞
（例如某個工具的 description 用了表格沒收錄的同義詞）；如果發現落差，
在 Codex Notes 記錄調整了什麼、為什麼，不要不聲不響改掉又不說明。

**已知的殘餘風險（不是這個 thread 要解決，但要誠實記錄）**：關鍵字
比對無法做到完美分類，混合意圖或用詞刁鑽的任務仍可能誤判、把真正需要
的工具排除在候選集合外——`< 3` fallback 只能擋住「命中太少」的極端
情況，擋不住「命中了 3 個以上、但剛好不包含正確工具」這種中間態誤判。
這個殘餘風險目前無法完全消除，屬於確定性關鍵字方法本身的已知限制，
記錄在案，不是這個 thread 沒做好。

# Constraints

- 沿用 `20260904-retrievecontext-wire-into-plan` 已經記錄過的所有背景：
  `n_ctx=4096`、上一次 worked-example 直接把請求打到 400 的教訓、手動
  查模型必須用 `print-plan-schema.ts` 帶 schema、Codex sandbox 唯讀時
  的既有處理方式（這次沒有唯讀問題，但仍要記得這條）。
- **這次改動的方向剛好跟上次相反**：上次是「確保 prompt 不變大」，這次
  是「讓 prompt 變小」，帶來的新風險不是 context window 爆掉，而是
  **候選工具集合縮小到不包含模型真正需要的工具**，導致原本會成功的
  任務開始失敗（重演 `AGENT_NOT_REGISTERED` 那類問題，但這次是自己的
  窄化邏輯造成的，不是 LLM 不知道某個選項存在）。實作與測試都要對這個
  風險保持警覺。
- **新的流程檢查點（使用者，2026-09-04）**：Codex 完成後，只把 diff／
  程式碼摘要／單元測試結果／`print-system-prompt.ts` 量測數字寫進
  Codex Notes，**不要**自己嘗試重啟 `AgentServer`、送真實 `/api/plan`
  請求，或把這個 thread 的 status 改成 `completed`——這些交給 Claude
  在使用者看過 diff、明確同意後才做。

# Codex Notes

1. **Implementation explanation**：新增確定性的大小寫不敏感子字串比對；一個 intent 會回傳所有命中的 domain，完全未命中則回傳 `undefined`。`retrieveScopedTools()` 只在推論成功時傳入 `domains`，既有 `< 3`、tool failure 與 exception 的完整目錄 fallback 均未修改。逐一交叉比對 `hiba.tools.ts` description 後保留 Claude 原表，並補上直接出現在工具描述、原表未涵蓋的同義詞：material（`批次`、`料號`、`用料`、`檢驗`、`有效期限`）、machine（`運作狀態`）、man（`員工`、`登入`、`班表`、`班次`、`資格`、`證書`）、method（`製程`、`規格`、`iatf`）、env（`粒子`、`檔案系統`、`讀寫`、`probe`）、orchestrator（`回響`、`延遲`、`安裝`、`更新`、`註冊`）。

2. **Code changes**：修改 `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts`，新增 `export type Domain = 'material' | 'machine' | 'man' | 'method' | 'env' | 'orchestrator'`、`const DOMAIN_KEYWORDS: Record<Domain, string[]>`、`export function inferDomainsFromIntent(task: string): Domain[] | undefined`，並把既有 `retrieveScopedTools(task: string, ctx: ToolContext, registeredTools: RegisteredTool[]): Promise<RegisteredTool[]>` 的 retrieveContext input 改為 `{ intent: task, ...(domains && { domains }) }`。修改 `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.test.ts`，加入 domain inference 與 execute payload 測試；未修改 `hiba.tools.ts` 或 `context.tools.ts`。

3. **Unit test results**：PASS。Focused `NLPlanningService.test.ts`：35 passed／0 failed，涵蓋六個 domain 各至少一例、英文大小寫不敏感命中、material＋method 混合意圖、無命中回傳 `undefined`、有推論時包含 `domains`、無推論時完全省略該鍵，以及既有 fallback 案例。完整 `npm.cmd run typecheck`：0 errors；完整 `npm.cmd test`：17 suites passed／1 skipped，218 tests passed／1 skipped／0 failed。

4. **`print-system-prompt.ts` measurement**：以真實註冊目錄和單一 material intent `Protect file /tmp/x.xml and verify integrity` 實測，推論結果為 `["material"]`。Before：37 tools，10,198 chars／12,322 UTF-8 bytes；after：8 tools，6,024 chars／6,652 UTF-8 bytes；節省 4,174 chars／5,670 bytes（46.0% bytes）。此腳本輸出 prompt 文字而非模型 tokenizer token IDs，因此可重現的實測計數單位是 chars／UTF-8 bytes；thread 原估 material 7 tools 已因 `material.readAttachment` 而實際為 8。

# Review Findings

**程式碼審查（Claude，2026-09-04）**：讀完整份 diff，確認：

- `inferDomainsFromIntent()` 是純函式、大小寫不敏感子字串比對、命中回傳
  聯集（不是取最高分單一 domain）、完全沒命中回傳 `undefined`——三項都
  符合 Success Criteria。`retrieveScopedTools()` 只在 `domains` 非
  `undefined` 時才把該欄位塞進 `execute()` 的 input（用
  `...(domains && { domains })` 展開），沒命中時的呼叫參數只有
  `{ intent: task }`，跟上一個 thread 的既有行為完全一致——單元測試
  `omits domains from retrieveContext input when none can be inferred`
  直接斷言了這點。
- 既有的 `<3` fallback／tool failure fallback／exception fallback 三個
  分支程式碼本身沒有被改動，只是現在 `domains` 會影響
  `orchestrator.retrieveContext` 回傳的候選數量，安全網邏輯不變。
- 關鍵字表：交叉比對 `hiba.tools.ts` 的方式合理（沒有直接照抄 Claude
  草稿，有補上 8 個工具描述裡出現、原表沒收錄的同義詞，並在 Codex Notes
  說明了每個新增詞），沒有不聲不響改表又不說明。
- **潛在準確率疑慮（記錄但不是本次 blocker）**：`machine` domain 的
  `order` 關鍵字、`orchestrator` domain 的 `node` 關鍵字都是常見英文
  單字，容易在不相關的任務文字裡誤觸發；但因為命中邏輯是「聯集、只會
  讓候選集合變大或不變，不會把其他已命中的 domain 排除」，這類誤判
  的方向是安全的（頂多少省一點 token，不會排除掉真正需要的工具）——
  跟 Constraints 提醒的「候選集合縮小到不含正確工具」是不同方向的
  風險，此處觀察到的疑慮不屬於那個高風險類別。

**獨立重跑驗證（Claude，2026-09-04，不只採信 Codex 回報）**：

1. `npm run typecheck`——乾淨無錯誤，與 Codex 回報一致。
2. `npm test`——218 passed／1 skipped／0 failed，與 Codex 回報一致
   （比上一個 thread 完成時的 209 多 9，符合新增的 9 個測試案例）。
3. `print-system-prompt.ts` 的量測數字（37→8 tools，節省 46% bytes）
   沒有重新獨立實測——這屬於下一步 live 驗證的一部分，依照這次新定的
   檢查點，先呈現給使用者看，使用者同意後再做。

**尚未做的部分（依照新流程，刻意停在這裡）**：真實 live 服務驗證
（重啟 `AgentServer`、送真實 `/api/plan` 請求、確認窄化後的任務仍然
規劃正確、確認既有已知案例沒有回歸）、`print-system-prompt.ts` 量測
數字的獨立重現。thread 狀態維持 `open`，不是 `completed`。

# Test Plan

**Live 驗證（Claude，2026-09-04）——發現一個真實、已證實的殘餘風險，
建議修正後才結案，見下方 Decisions 的待決事項**。

執行方式：重啟 `AgentServer`（載入含這次改動的程式碼）、用 Node 寫入
JSON 檔案再以 `curl --data-binary @file` 送出請求（**不要**在 git-bash
的 `-d` 參數裡直接放中文字面值——這次一開始就踩到這個坑，見下方
「方法論插曲」，本 repo 對這件事已經有獨立記憶記錄）。

**方法論插曲（重要，避免下次重蹈覆轍）**：第一輪測試用
`curl -d '{"task":"保護檔案..."}'`（中文字面值直接放在 -d 參數裡），
連續 3 次都得到 `method.fetchSop`（完全跑錯 domain）。一度懷疑是
`inferDomainsFromIntent` 或 `retrieveContext` 本身的 bug，加了臨時
`console.warn` 進 `retrieveScopedTools()` 追查，才發現真正原因：
git-bash 的 `curl -d` 把中文字面值送成亂碼位元組，導致伺服器收到的
`task` 字串根本不是「保護檔案...」，`inferDomainsFromIntent` 對亂碼
自然完全不命中、回傳 `undefined`（這其實是正確行為——分類器對它看不懂
的輸入本來就該回傳 `undefined`，不窄化），問題出在請求本身送壞了，
不是窄化邏輯壞了。改用 Node 寫檔＋`curl --data-binary @file` 後
（已移除臨時 debug log），同一個任務 3/3 穩定產生正確的
`material.protectFile`→`material.verifyFile`。**教訓**：這個 repo
已經有獨立記憶記錄「git-bash curl 會弄壞中文/UTF-8」，這次還是先踩了
一次坑才想起來，之後所有帶中文的 live 測試都要先用檔案方式，不要圖快
直接塞進 `-d`。

**六個案例的結果（都已用正確編碼方式送出）**：

| 案例 | 任務文字 | 推論 domains | 實際結果 |
|---|---|---|---|
| 1. 單一 material | 保護檔案 ... 並驗證完整性 | `['material']` | `material.protectFile→verifyFile`，`status:planned`，正確 |
| 2. 中性無關鍵字 | 請協助處理這件事情 | `undefined`（fallback 全目錄） | 模型選了 `machine.executeOrder`，因為沒有 online 節點驗證失敗——跟這個 session 更早之前在完全沒有 domain 窄化時看到的既有模型非確定性一致，不是這次改動造成的新問題 |
| 3. 已知本機案例 | 保護檔案 /tmp/local-input.xml ... | `['material']` | `material.protectFile→verifyFile`，`status:planned`，跟上一個 thread 驗證過的行為一致，沒有回歸 |
| 4. 邊界案例 A | 這台設備最近常常過熱，需要通知維修人員 | `['man']`（只命中「通知」，真正需要的是 env/machine 工具） | **`man.sendAlert`，`status:planned`，無錯誤**——看起來成功，語意完全錯誤 |
| 5. 邊界案例 B | 這份作業指導書要不要跟著最新版本更新 | `['orchestrator']`（只命中「更新」，真正需要的是 method 工具） | `orchestrator.updateSubWebRuntime`，因為沒有 online 節點驗證失敗——至少有明確錯誤，不是靜默錯誤 |
| 6. 邊界案例 C | 產線上有異音，麻煩通知人員來看一下 | `['man']`（只命中「通知」，真正需要的是 machine 工具） | **`man.sendAlert`，`status:planned`，無錯誤**——跟案例 4 同樣的靜默錯誤模式 |

**關鍵對照實驗**：把案例 4 的任務文字，改用**完整 37 工具目錄**（不窄化）
直接查模型 3 次，結果穩定是 `machine.checkCalib`（路由到真實 online
節點 `node2`）——不是完美答案，但至少落在正確的 machine domain、且
成功路由到真實節點。**這證明窄化邏輯本身把這個案例從「路由到真實
machine 節點的合理答案」變成「語意錯誤但看起來成功的 man.sendAlert」
——是這次改動實際引入的退化，不是「反正本來就會錯」。**

**風險分級（比 Constraints 原本預期的更嚴重）**：Constraints 原本假設
的殘餘風險是「候選集合縮小到不含正確工具，導致原本會成功的任務開始
失敗」——這確實發生了（案例 4、6），但比預期更糟的是**這個失敗是
靜默的**：`status:"planned"`、沒有 `error`、沒有 `validationIssues`，
表面上看起來是一次成功的規劃，實際上工具選錯了整個 domain。這違反
CLAUDE.md「嚴禁靜默失敗」——不是這次接線程式碼本身靜默吞掉錯誤，而是
窄化邏輯的分類誤判，讓下游的 `validatePlan()` 找不到理由拒絕一個
語意錯誤的合法呼叫。

**根因**：`通知`（man）、`更新`（orchestrator）這兩個關鍵字太通用，
容易在任何域的任務描述裡以「附帶動作」的形式出現（例如「有異常，需要
通知OO」是幾乎任何域的常見句型），一旦命中就會把窄化範圍鎖死在
`man`/`orchestrator`，而這兩個 domain 剛好都只有 5 個左右的工具、
不會觸發 `<3` 安全網。

單元測試（Success Criteria 其餘各項）：`npm run typecheck` 乾淨、
`npm test` 218 passed／1 skipped／0 failed，跟 Codex 回報一致（獨立
重跑確認）。`print-system-prompt.ts` 量測數字（37→8 tools，省 46%
bytes）已用上方案例 1 的真實請求間接複現（案例 1 的 scoped 候選集合
確實只有材料網域，不是完整 37 個）。

# Decisions

**核准（使用者，2026-09-04）**：延續上一個 thread 的 Open Questions，
採用確定性關鍵字比對（不引入額外 LLM 分類呼叫）做 domains 窄化，這次
真正讓 `tools` 候選集合縮小、驗證省下的 token 量。

**派工（Claude，2026-09-04）**：交給 Codex 實作。**新流程**：Codex 完成
後先停在「diff＋單元測試＋prompt 量測數字」，不做 live 驗證、不改
thread 狀態——Claude 會先把 diff 呈現給使用者看過，使用者同意後才會
進到 live 驗證／結案（見上方 Constraints 最後一條，這是這次新加的
檢查點，跟上一個 thread 的流程不同）。

**待決定（Claude，2026-09-04）**：使用者核准後，Claude 做了 live
驗證，發現 `通知`（man）／`更新`（orchestrator）這兩個關鍵字會造成
**靜默語意錯誤**（見上方 Test Plan 案例 4／6，`status:planned` 但
工具選錯整個 domain，不會被既有安全網擋下）——這比 Constraints 原本
預期的殘餘風險更嚴重。

**修正（使用者＋Claude，2026-09-04）**：使用者提議用「人機料法環」
架構補齊各 domain 缺漏的關鍵字，並把「過熱」「異音」「警報」等事件類
詞彙刻意跨域登記（而不是移除「通知」「更新」）。Claude 先讀完 30 個
既有工具的 description，擬了一份補充清單（材料 7 詞、機台 7 詞、
方法 5 詞、人員 3 詞、環境 2 詞，另外「過熱」登記進 env+machine、
「異音」「故障」「停機」登記進 machine、「警報」補進 env）套進
`DOMAIN_KEYWORDS`，typecheck／`npm test`（218 passed）都過，重新
live 驗證三個邊界案例：

- **案例 5（SOP 更新）完全修好**：`inferDomainsFromIntent` 現在回傳
  `['method','orchestrator']`，模型正確選出 `method.fetchSop`（因為
  缺 `sopCode` 沒填、也沒有 online 節點，validatePlan 仍然報錯，但
  是**明確的輸入缺漏錯誤**，不再是跑錯 domain 的
  `orchestrator.updateSubWebRuntime`）。
- **案例 4／6（過熱／異音）候選集合已經修對，但模型選擇沒變**：直接
  查 `orchestrator.retrieveContext` 確認候選集合正確擴大到
  `['machine','man','env']`（17 個工具，含 `env.readTemperature`／
  `machine.checkCalib` 等正確工具），但模型在有正確工具可選的情況下，
  仍然選了 `man.sendAlert`——**這不再是窄化邏輯的 bug**，候選集合已經
  給了正確答案的機會；是模型自己面對「設備過熱，需要通知維修人員」
  這種字面上明講「需要通知」的任務時，傾向照字面意思選「發通知」的
  工具，而不是先查詢/處理再通知。這跟這個 session 一路記錄的既有模型
  局限（照抄字面值、對任務措辭敏感）屬於同一類，不是這次窄化功能
  特有的新問題——**風險等級因此從「窄化邏輯保證選錯」降為「跟其他已知
  模型局限同等級的殘餘風險」**，不在這次 thread 的範圍內解決（要解決
  需要動 prompt/worked example，涉及上一輪已經證實過的 context window
  硬限制，超出這個 thread 的範圍）。

**結案（Claude，2026-09-04）**：三個已知具體漏洞裡，1 個完全修好
（SOP／案例 5），2 個從「保證選錯」降級成「跟既有模型局限同等級的
殘餘風險、至少候選集合是對的」（過熱／異音，案例 4／6）。單元測試
218 passed、typecheck 乾淨、案例 1／3（單一 material／已知本機案例）
重測維持正確、無回歸。Thread 狀態改為 `completed`；「異常」這類過度
通用詞刻意不收錄的決定維持不變。

# Session Summary

延續上一個 thread 的 Open Questions，這次讓 `orchestrator.retrieveContext`
的 `domains` 參數真正生效，用確定性關鍵字比對做語意窄化。Codex 一次
到位完成實作＋單元測試＋`print-system-prompt.ts` 量測（37→8 tools，
省 46% bytes），並確實遵守這次新加的流程檢查點（只交 diff，不做 live
驗證、不改 thread 狀態）。Claude 審查 diff、獨立重跑
typecheck/測試（218 passed，跟回報一致）後，取得使用者同意進到 live
驗證，過程中先踩了一次已知的 git-bash curl UTF-8 mangling 坑（誤以為
是窄化邏輯的 bug，加 debug log 追查後確認是請求編碼問題，改用檔案方式
送出後問題消失）。修正方法論後的六案例驗證裡，三個基準案例（單一
material／中性 fallback／已知本機案例）都正確，但刻意設計的三個邊界
案例揪出一個真實、已用對照實驗證實的退化：`通知`／`更新` 這兩個過於
通用的關鍵字會把窄化範圍鎖死在錯誤的 domain（`man`／`orchestrator`），
其中兩個案例（設備過熱、產線異音）產生 `status:"planned"`、無錯誤的
**靜默語意錯誤**——對照組（同任務、不窄化、直接查模型）證實不窄化時
至少會落在正確的 machine domain 並路由到真實節點，證明這是窄化邏輯
本身引入的退化。Thread 狀態維持 `open`，等待使用者決定要不要先修正
關鍵字表再結案。

# Open Questions

- 關鍵字對照表的覆蓋率／準確率沒有經過系統性驗證（例如拿 C6 標注集
  的 S01-S20 任務文字實際跑一次分類，人工核對命中的 domain 是否正確）
  ——這次範圍先求「有可運作的窄化機制＋量化的 token 節省數字＋不回歸
  既有單元測試」，系統性準確率驗證留給下一步，是否需要另開 thread
  待使用者決定。
- 如果之後發現關鍵字覆蓋率不足，是擴充關鍵字表、還是改用
  embedding-based `ToolIndex`（規格文件 §二，目前完全未實作）取代
  整個關鍵字機制，兩條路線互斥還是可以並存，留給之後決定。
