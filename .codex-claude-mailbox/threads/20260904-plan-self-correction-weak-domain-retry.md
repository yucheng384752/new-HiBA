---
id: "20260904-plan-self-correction-weak-domain-retry"
title: "plan() 生成後自我修正：man/orchestrator 單獨作答但任務涉及其他 domain 時重試一次"
status: "completed"
owner: "codex"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-04T15:00:00+08:00"
updated_at: "2026-09-04T15:40:00+08:00"
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

延續 `20260904-retrievecontext-domain-narrowing`（已完成）驗證出的殘餘
風險：候選工具集合已經正確包含 `env`/`machine` 等相關 domain 的工具，
但模型在任務文字明講「需要通知」時，仍然只選 `man.sendAlert` 這種
純通知動作，沒有先做診斷/查詢——這是**工具選擇**問題，不是候選集合
窄化的問題（候選集合已經是對的）。

這個 thread 要做的是規格文件 §一之3「生成-驗證自我修正迴圈」的一個
具體、範圍限定的實例：**plan() 產生的結果通過驗證、但只用了
man/orchestrator 這兩個「弱訊號」domain 的工具，而任務文字同時也命中
了其他 domain 的關鍵字時，重試一次，給模型一個提示，讓它有機會補上
真正該做的診斷/查詢動作。**

**使用者已明確排除的方向（不要在這個 thread 裡做）**：不修改
`man.sendAlert` 的 inputSchema（例如加必填 `machineId`）——這會誤傷
跟機台無關的合法通知情境（例如人資類通知），且沒對到「工具選擇」這個
真正的病灶，只是讓已經選錯工具的呼叫多一個必填欄位。

# Success Criteria

- [ ] 新增一個純函式（建議命名 `usesOnlyWeakDomains(steps, task)` 或
  類似，export 供直接單元測試，比照 `resolveNodeRouting`／
  `inferDomainsFromIntent` 的既有模式）：
  1. `weakDomains = new Set(['man', 'orchestrator'])`——這兩個 domain
     的關鍵字表已知含有過度通用的詞（「通知」「更新」，見
     `20260904-retrievecontext-domain-narrowing.md` 的 Test Plan），
     是唯一會觸發這個檢查的 domain。
  2. 從 `plan.steps` 算出 `usedDomains =
     new Set(steps.map(s => s.toolName.split('.')[0]))`。
  3. 從 `task` 重新呼叫 `inferDomainsFromIntent(task)`（純函式，重算
     成本可忽略，不需要跨函式傳遞既有的 domains 結果）。
  4. 回傳條件：`usedDomains` 是 `weakDomains` 的非空子集（**所有**
     步驟都只用 man/orchestrator 工具），**且** `inferDomainsFromIntent`
     的結果存在、包含至少一個不在 `weakDomains` 裡的 domain。
  5. 純 man/orchestrator 任務（`inferDomainsFromIntent` 只回傳
     `['man']`／`['orchestrator']`／`undefined`）**不觸發**——這是
     避免誤傷合法單一 domain 任務的關鍵防呆，務必要有對應單元測試。
- [ ] 在 `plan()` 裡，**在 `if (validation.valid) return
  validation.plan;`（目前第 301 行附近）這個分支內**加這個檢查——
  跟既有的「hallucinated tool name」重試是兩個獨立分支（一個處理
  `validation.valid === true` 但工具選擇可疑，一個處理
  `validation.valid === false` 的 `TOOL_NOT_FOUND`），不要合併成同一個
  分支、不要動既有 hallucinated-retry 的邏輯。
- [ ] 觸發時的重試訊息（比照既有 hallucinated-retry 的
  parenthetical-note 風格，不要新增 system prompt 內容、不要動
  `HttpLLMClient.ts`）：
  ```
  `${task}\n\n(Note: this task may also involve ${otherDomains.join('/')} `
    + `tools — before or instead of only sending a notification, check `
    + `whether a diagnostic or query step is needed first.)`
  ```
  其中 `otherDomains` 是 `inferDomainsFromIntent(task)` 結果裡排除
  `weakDomains`後剩下的 domain。
- [ ] **只重試一次**（比照既有 hallucinated-retry 的單次重試設計，
  不要做成迴圈）。重試後的結果處理：
  1. 重試呼叫失敗（`plan.error`）→ 回傳**原本**已通過驗證的 plan
     （不要因為重試失敗就丟掉一個已經合法的結果）。
  2. 重試結果驗證失敗（`validatePlan` 不通過）→ 同樣回傳原本已通過
     驗證的 plan。
  3. 重試結果驗證通過**且**不再只用 weak domains → 回傳重試後的新
     plan（修正生效）。
  4. 重試結果驗證通過但**仍然**只用 weak domains（模型堅持原答案）→
     回傳重試後的 plan 仍然合理（因為它還是通過驗證的合法結果），但
     要記錄／可觀測（見下一項），不要當成錯誤。
- [ ] 每次觸發這個重試，都要有 `console.warn` 留下軌跡（哪個 task、
  觸發原因、重試後 domain 有沒有變），對應 CLAUDE.md「嚴禁靜默失敗」
  ——雖然這不是失敗，但這是一個會改變 plan() 輸出的隱性行為，需要可
  觀測性。
- [ ] 單元測試（`NLPlanningService.test.ts`）：
  1. `usesOnlyWeakDomains`／等價純函式的單元測試：weak-only 且
     inferDomains 有其他 domain → true；weak-only 但 inferDomains
     只有 weak domain 或 undefined → false；非 weak-only（含至少一個
     非 weak domain 的工具）→ false，不論 inferDomains 結果為何。
  2. `plan()` 端到端：第一次 LLM 回傳 man-only plan、`inferDomains`
     推論出其他 domain、mock LLM 第二次呼叫回傳含正確 domain 工具的
     plan → 斷言最終回傳的是第二次（修正後）的 plan，且第二次呼叫的
     task 文字包含 corrective note。
  3. `plan()` 端到端：純 man-only 任務（`inferDomainsFromIntent` 只
     回傳 `['man']`）、LLM 回傳 man-only plan → 斷言**不觸發**重試
     （LLM 只被呼叫一次），維持原本合法結果不變——這是防止誤傷的
     回歸測試，優先度最高。
  4. `plan()` 端到端：觸發重試但第二次 LLM 仍然回傳 man-only plan →
     斷言回傳這個仍然合法的 plan（不報錯、不無限重試）。
  5. 既有 `NLPlanningService.test.ts`／`resolveNodeRouting`／
     hallucinated-retry 的既有測試全數維持通過，不可回歸。
- [ ] typecheck／`npm test` 全數通過。
- [ ] **這次同樣依照新流程停在這裡**：Codex 完成後只把 diff／單元
  測試結果寫進 Codex Notes，不重啟服務、不送真實請求、不改 thread
  狀態——交給 Claude 在使用者看過 diff 後決定是否進到 live 驗證。

# Current Context

`plan()` 目前的相關結構（`NLPlanningService.ts`）：

```typescript
let plan = await this.generateNormalizedPlan(task, registeredTools, tools, planningResources, planningNodes);
if (plan.error || !this.options.toolbox) return plan;
plan = { ...plan, steps: resolveNodeRouting(plan.steps, registeredTools, nodes) };

let validation = validatePlan(plan, { tools: registeredTools, nodes });
if (validation.valid) return validation.plan;          // ← 新檢查要插進這個分支

// hallucinated tool name 的既有重試邏輯（validation.valid === false 時）
const hallucinated = validation.issues.filter(issue => issue.code === 'TOOL_NOT_FOUND')...
if (hallucinated.length > 0) { ... }
```

已驗證的具體案例（`20260904-retrievecontext-domain-narrowing.md` Test
Plan）：任務「這台設備最近常常過熱，需要通知維修人員」，
`inferDomainsFromIntent` 正確回傳 `['machine','man','env']`，候選集合
17 個工具（含 `machine.checkCalib`／`env.readTemperature` 等），但模型
最終只回傳 `man.sendAlert` 一個步驟——`status:"planned"`、無任何
`error`／`validationIssues`，是一次「看起來成功」但語意可疑的結果。

# Constraints

- 沿用兩個先前 thread 已經記錄的所有背景（`n_ctx=4096`、worked-example
  的教訓、`print-plan-schema.ts` 診斷方法論、git-bash curl UTF-8
  mangling 的坑、Codex sandbox 唯讀時的既有處理方式）。
- **這次改動不碰 system prompt／`HttpLLMClient.ts`／工具 schema**——
  重試訊息是動態附加在單次請求的 `task` 文字後面（跟既有
  hallucinated-retry 完全一樣的模式），不是寫進靜態 system prompt，
  對 context window 沒有累積性風險。
- **不要修改 `man.sendAlert` 的 inputSchema**（使用者已明確排除，見上
  方 Goal）。
- **重試不保證修好**：這是一個 nudge（提示），不是強制修正——比照既有
  hallucinated-retry 本身也不是 100% 保證修好（見
  `20260903-plan-local-tool-routing.md` 的教訓，光靠 prompt 層提示
  對這個模型的效果有限）。live 驗證階段要誠實記錄「重試後有沒有真的
  改變結果」，不能假設一定有效，這正是為什麼 Success Criteria 要求
  「重試後仍然 weak-only 時要能優雅接受，不能報錯」。
- **新的流程檢查點（沿用上一輪）**：Codex 完成後只交 diff＋單元測試
  結果，不做 live 驗證、不改 thread 狀態，由 Claude 審查後再決定是否
  進到 live 驗證。

# Codex Notes

## 實作說明

- 新增並 export 純函式 `usesOnlyWeakDomains(steps, task)`：只有在 plan 非空、
  所有工具都屬於 `man`／`orchestrator`，且重用
  `inferDomainsFromIntent(task)` 推論出至少一個其他 domain 時才回傳
  `true`。
- 在 `plan()` 的 `validation.valid === true` 分支加入一次性重試；提示文字
  完全依 Success Criteria 指定格式動態附加到 task。原本
  `validation.valid === false` 的 hallucinated-tool-name retry 未修改。
- 保留第一次已驗證 plan 作為 fallback：重試產生 error 或驗證失敗時回傳
  原 plan；重試合法時回傳重試 plan，即使模型仍只選 weak domains 也不報錯
  或再次重試。
- 每次觸發均以 `console.warn` 記錄 task、觸發原因、重試是否通過驗證及是否
  加入非 weak domain；產生 error 時也會記錄重試失敗與 domain 未改變。

## 程式碼變更摘要

- `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts`
  - 新增 `WEAK_DOMAINS` 與 `usesOnlyWeakDomains`。
  - 在驗證通過分支加入 weak-domain 自我修正重試與 graceful fallback。
- `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.test.ts`
  - 新增純函式案例：mixed intent、純 man、純 orchestrator、無已知 domain、
    空 steps、以及 steps 含非 weak domain。
  - 新增 plan 整合案例：重試後改用正確 domain、純 man 任務不重試、重試後
    仍 weak-only 時接受第二次合法結果且不無限重試。

## 單元測試結果

- `npm run typecheck`：通過（`tsc --noEmit`）。
- `npm test`：通過；17 個 test suites passed、1 skipped，227 個 tests
  passed、1 skipped，0 failed。
- 額外定向執行 `npm test -- --runInBand src/planning/NLPlanningService.test.ts`：
  44/44 tests passed。
- 未重啟服務、未送真實 `/api/plan` 請求、未進行 live 驗證，thread
  frontmatter status 維持 `open`。

# Review Findings

（待 Claude 審查 diff 後填寫。）

# Test Plan

**程式碼審查（Claude，2026-09-04）**：讀完整份 diff，`usesOnlyWeakDomains`
邏輯正確、跟既有 hallucinated-retry 分支完全獨立、重試訊息格式跟
spec 一致。獨立重跑 `npm run typecheck`（乾淨）／`npm test`
（227 passed，跟 Codex 回報一致）。單元測試涵蓋三個關鍵案例（純
man 任務不誤觸發、重試修好、重試後仍 weak-only 時優雅接受不迴圈），
都通過。

**Live 驗證（Claude，2026-09-04）——重要發現：這個功能在真實環境裡
目前幾乎無法被觸發，且觸發後對這個模型也沒有實際效果**，細節如下：

重啟 `AgentServer`（確認載入含這次改動的程式碼）後，重送
`20260904-retrievecontext-domain-narrowing.md` 記錄過的過熱／異音
邊界案例，這次**印出完整回應（包含 `validationIssues`），不是只看
`status`／`error`**——這是這次才修正的診斷方法論缺口，見下方
「方法論修正」。

發現：man.sendAlert 的 `inputSchema` 要求 `priority: enum(['low',
'normal','urgent'])`，但這個模型對「過熱／異音」這類任務，**11/11
次**穩定回傳 `priority:"high"`（不在允許值裡，`INPUT_INVALID`），
或有時連 `employeeId`/`message` 都留空（`INPUT_REQUIRED`，noise
案例 3 次裡 2 次）。這代表：**第一次 `generateNormalizedPlan()` 的
`validatePlan()` 幾乎必定在到達這個 thread 新增的 `validation.valid`
分支之前，就已經因為這個完全無關的欄位驗證問題判定
`validation.valid = false`**——`usesOnlyWeakDomains` 這個檢查在
這兩個具體邊界案例裡，實務上從未被執行到。

為了至少驗證「重試訊息本身有沒有用」，另外手動模擬重試會送出的
correctedTask（直接把 Success Criteria 指定的提示文字附加在任務後面，
繞過這個模型無法觸發的路徑），直接送 3 次真實請求——**3/3 次模型
仍然選擇 `man.sendAlert`，完全沒有改用 `machine`/`env` 的工具**。
這印證了 Constraints 早就寫好的預告：「重試不保證修好」——這次是
連機會都沒有得到驗證，而是**验证到就算給模型機會，它也沒有改變選擇**。

**方法論修正（重要，也回頭訂正上一個 thread 的一個潛在不精確之處）**：
`20260904-retrievecontext-domain-narrowing.md` 的 Test Plan
原本描述過熱／異音案例是「`status:"planned"`、無任何 error，靜默語意
錯誤」——但那次的驗證腳本**只印了 `status`／`error`，沒有印
`validationIssues`**。這次補印完整回應後發現，至少在這次的 11+ 次
重測裡，過熱／異音案例其實**每一次都有 `validationIssues`**
（`priority` 無效或 `employeeId`/`message` 缺漏），不是完全無跡可循
的靜默成功。这不代表原本的核心結論（模型選錯 domain、`man.sendAlert`
語意不對）是錯的——工具選擇本身確實還是錯的——但「完全沒有任何錯誤
訊號、看起來 100% 成功」這個描述不精確，應該訂正為「工具選錯了，但
剛好也伴隨一個不相關的欄位驗證問題，所以呼叫端至少會看到
`validationIssues`，不是完全沉默」。這個訂正不影響
`20260904-retrievecontext-domain-narrowing.md` 已經做的關鍵字表修正
本身的正確性，只影響「風險有多嚴重／多隱蔽」的描述準確度。

**這次意外發現的新問題（比這個 thread 原本要解決的問題更具體、風險
更低、修復價值可能更高）**：`man.sendAlert` 的 `priority` enum
只接受 `low`/`normal`/`urgent`，但模型對「緊急」情境穩定回傳英文
`"high"`——這是一個單純的 schema/enum 對齊問題，不涉及工具選擇的
語意判斷，修法（例如把 `'high'` 也納入合法值、或映射成
`'urgent'`）風險極低、不需要動 prompt，且很可能不只影響這兩個邊界
案例，任何觸發 `sendAlert` 的真實任務都可能撞到。這個發現已經記錄在
Open Questions，建議另開一個小 thread 處理，優先度可能比這個 thread
剩餘的殘餘風險更高。

# Decisions

**核准（使用者，2026-09-04）**：開這個 thread 處理工具選擇問題，用
「生成後自我修正迴圈」的具體實例（man/orchestrator-only 且任務涉及
其他 domain 時重試一次），不修改 `man.sendAlert` 的 schema。

**派工（Claude，2026-09-04）**：交給 Codex 實作，沿用上一輪的檢查點
——Codex 只交 diff＋單元測試，Claude 審查後再決定要不要 live 驗證。

**待決定（Claude，2026-09-04）**：live 驗證完成，程式碼本身正確、
單元測試全過、不影響既有行為（安全），但對這個 thread 最初要解決的
具體案例（過熱／異音）**沒有觀察到實際效果**——不是因為邏輯錯誤，
是因為 (1) 這兩個案例在真實環境裡幾乎不會走到這個新邏輯所在的
`validation.valid` 分支（被一個無關的 `priority` enum 問題擋在前面），
(2) 就算手動繞過去驗證重試訊息本身，模型也沒有改變選擇。這個 thread
目前維持 `open`，等待使用者決定：
1. **保留現狀，標記完成**——程式碼本身安全、正確，是「生成-驗證自我
   修正迴圈」規格方向的一個合理實例，可能在其他 `validation.valid`
   直接為真的情境下發揮作用，即使這次的動機案例沒被證實有效。
2. **先處理意外發現的 `priority` enum 問題**（開新 thread，見下方
   Open Questions）——修復後，這兩個邊界案例才有機會真正走到這個
   thread 的新邏輯，屆時才能重新驗證這個重試機制對這兩個案例到底
   有沒有用。
3. 兩者都做，順序上先做 1（這次的改動保留，不因為沒被證實有效就
   撤回，因為安全無害）、priority enum 修好後再回來重新驗證。

**核准（使用者，2026-09-04）**：選項 3。這個 thread 的程式碼保留、
標記完成；另開 `20260904-mansendalert-priority-enum-fix` 處理
`priority` enum 問題，修好後回來這裡重新驗證過熱／異音案例。

# Session Summary

實作了「plan() 驗證通過但只用 man/orchestrator 工具、任務又明明涉及
其他 domain」時重試一次的自我修正邏輯，Codex 一次到位完成程式碼＋
單元測試（227 passed），程式碼審查確認邏輯正確、與既有 hallucinated-
retry 分支獨立、不影響既有行為。Live 驗證階段意外發現一個更根本的
問題：這個 thread 鎖定的兩個具體案例（設備過熱／產線異音），模型
產生的 `man.sendAlert` 呼叫幾乎必定先在一個完全無關的欄位上驗證失敗
（`priority` 穩定回傳不合法的 `"high"`，或 `employeeId`/`message`
留空），導致這次新增的邏輯從未被真實觸發過；手動繞過這個限制直接
測試重試訊息本身，也證實對這個模型無效（3/3 次仍選
`man.sendAlert`）。同時訂正了上一個 thread（domain-narrowing）一個
診斷方法論缺口：當時只印了 `status`／`error`，沒印
`validationIssues`，這次補印後發現「靜默語意錯誤、完全無錯誤訊號」
的描述不夠精確——工具確實選錯，但通常會伴隨一個不相關的
`validationIssues`，不是完全沉默。thread 狀態維持 `open`，等待
使用者對後續方向做決定（見上方 Decisions）。

# Open Questions

- 這個檢查目前只鎖定 `weakDomains = ['man','orchestrator']`（已知具體
  證實有問題的兩個 domain）。如果未來其他 domain 的關鍵字表也出現
  同類「過度通用詞導致單一 domain 壓過其他相關 domain」的情況，要不要
  把這個機制廣義化成「任何單一 domain 壓過其他被推論出的 domain」，
  還是維持鎖定 weak domains 的保守範圍——留給下一輪視實測結果決定。
- **新發現（2026-09-04 live 驗證）**：`man.sendAlert` 的
  `inputSchema.priority` 只接受 `'low'|'normal'|'urgent'`，但模型對
  「緊急/過熱」情境穩定回傳英文 `"high"`（11/11 次重測皆如此），
  導致 `INPUT_INVALID`。這是單純的 schema/enum 對齊問題，不涉及工具
  選擇的語意判斷，風險低、修法直接（例如把 `'high'` 納入合法值或
  映射成 `'urgent'`），建議另開一個小 thread 處理，且可能影響的範圍
  比這兩個邊界案例更廣（任何真實觸發 `sendAlert` 的任務都可能撞到）。
- 這個重試對過熱/異音案例證實沒有實際效果（模型重試後依然選
  `man.sendAlert`，如 Constraints 預告）。要不要進一步升級成規則式的
  「後處理插入」（確定性地在 plan 前面插入對應 domain 的查詢步驟，
  而不是靠 prompt 提示模型自己想到）——這是比這次範圍更大的改動，
  待 priority enum 問題解決、能真正觀察到這個 thread 的重試邏輯運作後，
  再評估要不要往這個方向做。
