---
id: "20260904-mansendalert-priority-enum-fix"
title: "man.sendAlert priority enum 不接受模型常用的 \"high\""
status: "open"
owner: "claude"
reviewer: "claude"
priority: "low"
created_by: "claude"
created_at: "2026-09-04T15:40:00+08:00"
updated_at: "2026-09-04T15:40:00+08:00"
role_priority:
  implementation: "claude"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.tools.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.tools.test.ts"
    type: "file"
---

# Goal

`man.sendAlert` 的 `inputSchema.priority` 只接受
`z.enum(['low','normal','urgent'])`，但在
`20260904-plan-self-correction-weak-domain-retry.md` 的 live 驗證中
發現：`hiba-planner:v1-optimized` 對「緊急/過熱」這類任務，穩定回傳
英文 `"high"`（11/11 次重測皆如此），觸發 `INPUT_INVALID`。這是單純
的 schema 對齊問題，不涉及工具選擇的語意判斷，修復範圍小、風險低。

# Success Criteria

- [ ] `man.sendAlert` 的 `priority` 欄位改用 `z.preprocess()` 做輸入
  正規化：`'high'` 正規化成 `'urgent'`，再套用既有的
  `z.enum(['low','normal','urgent']).default('normal')`——**保持
  enum 本身只有三個值**（不擴大成四個值），因為 `low`/`urgent` 已經
  涵蓋了語意上的兩端，加第四個值只會造成未來實作 handler 時的歧義；
  用 preprocess 正規化模型的常見同義詞，才是對到病灶的最小改動。
- [ ] 這個工具目前是 `handler: notImplemented`、沒有對應的
  Pi 端 `manifest.json` 登錄（已確認：`scripts_pi/` 全文搜尋
  `sendAlert` 無結果），改動不涉及 Data-First 的跨端契約同步問題。
- [ ] 單元測試（`hiba.tools.test.ts`，或就近放在
  `NLPlanningService.test.ts` 若既有測試檔案結構更適合）：
  1. `priority: 'high'` → 正規化通過驗證，等同 `'urgent'`。
  2. `priority: 'low'`/`'normal'`/`'urgent'` 既有三個合法值維持不變
     （不可回歸）。
  3. `priority` 缺省時仍然預設 `'normal'`（`.default()` 行為不可被
     `preprocess` 破壞）。
  4. 其他不合法值（例如 `'critical'`）仍然要被拒絕，不能因為加了
     preprocess 就變成對所有值都寬容。
- [ ] typecheck／`npm test` 全數通過。
- [ ] Live 驗證：修好後重送
  `20260904-plan-self-correction-weak-domain-retry.md` 的過熱／異音
  邊界案例，確認：
  1. `priority` 不再是這兩個案例的驗證失敗原因。
  2. 觀察這次是否真的走到 `usesOnlyWeakDomains` 的重試分支（可暫時加
     debug log 確認，驗證完畢後移除，比照先前 thread 的既有作法）。
  3. 如果走到了，記錄這個重試機制對這兩個案例最終有沒有實際效果
     （不管有沒有效果都要如實記錄，這是上一個 thread 沒能驗證到的
     部分）。

# Current Context

live 證據（`20260904-plan-self-correction-weak-domain-retry.md` Test
Plan）：11/11 次過熱案例重測，`priority` 都是 `"high"`；noise 案例
3 次裡 1 次也是 `"high"`，另外 2 次是 `employeeId`/`message` 完全
留空（`INPUT_REQUIRED`，不在這次修復範圍內——欄位留空是另一種
模型行為，不是 enum 對齊問題，這次不處理）。

# Constraints

- 不要把這個機會拿來重新設計 `man.sendAlert` 的其他欄位（例如上一輪
  討論過、已經決定不做的 `machineId` 綁定）——範圍嚴格限定在
  `priority` 這一個欄位的 enum 對齊。
- 這次由 Claude 直接實作＋測試＋live 驗證（不派工給 Codex）：改動
  單純、範圍小、已有明確的 Success Criteria，不需要來回派工的溝通
  成本。

# Codex Notes

（本次無 Codex 派工，Claude 直接實作。）

# Review Findings

由 Claude 直接實作＋自我審查：`priority` 欄位改用 `z.preprocess()` 把
`'high'` 正規化成 `'urgent'`，enum 本身維持三個值不變，`.default()`
行為透過保留 `undefined` passthrough 不受影響。改動範圍精準對應
Success Criteria，沒有動到 `man.sendAlert` 其他欄位或 schema 結構。

# Test Plan

1. `npm run typecheck`：乾淨無錯誤。
2. `npm test`：233 passed／1 skipped／0 failed（比修復前多 6 個新
   測試：`'high'`→`'urgent'` 正規化、三個既有合法值不回歸、省略時
   仍預設 `'normal'`、未知值仍被拒絕）。
3. **Live 驗證（真實 Ollama／Accounting／hiba-agent）**：
   - 重啟 `AgentServer`，重送過熱案例 3 次：**3/3 次 `priority` 都
     正確正規化成 `"urgent"`，不再有 `validationIssues`**——enum 問題
     完全修好。
   - 重送異音案例 3 次：**仍然是 `INPUT_REQUIRED`（`employeeId`／
     `message` 留空）**——這是這次範圍明確排除的另一種模型行為（欄位
     留空，不是 enum 不合法），不在這次修復範圍內，如實記錄，不算
     未達成。
   - **關鍵驗證**：查 `AgentServer` log，過熱案例的 3 次請求都出現
     `[NLPlanningService] weak-domain-only plan for task "..." despite
     inferred machine/env domain(s); retry valid: ...; domains
     changed: false`——**證實
     `20260904-plan-self-correction-weak-domain-retry.md` 的重試邏輯
     這次真的被觸發了**（enum 問題修好前從未觸發過），但**3/3 次
     `domains changed` 都是 `false`**——重試後模型仍然只選
     `man.sendAlert`，沒有改用 `machine`/`env` 工具。這徹底回答了
     那個 thread 留下的懸而未決問題：**重試機制本身運作正常（會被
     正確觸發），但對這個模型的這個任務模式沒有實際效果**——不是
     邏輯 bug，是模型本身對「文字明講通知」這種措辭的偏好非常頑固，
     連明確的糾正提示都無法撼動，跟這個 session 從頭到尾記錄的「這個
     模型對抽象規則文字的約束力遠弱於字面值/措辭本身」是同一種現象
     （呼應 `20260903-plan-local-tool-routing.md` 的核心教訓）。

# Decisions

**核准（使用者，2026-09-04）**：修復＋測試，包含修好後重新驗證
`20260904-plan-self-correction-weak-domain-retry.md` 的重試邏輯是否
真的能被觸發、有沒有效果。

**結案（Claude，2026-09-04）**：enum 問題完全修好並用 live 服務驗證。
連帶回答了上一個 thread 留下的懸而未決問題（重試邏輯確實會被觸發，
但對這個模型無效）。Thread 狀態改為 `completed`。

# Session Summary

修好 `man.sendAlert.priority` 的 enum 對齊問題（`z.preprocess()` 把
模型常回傳的 `'high'` 正規化成 `'urgent'`），typecheck／233 個測試
（新增 6 個）都過，live 驗證確認過熱案例的 `priority` 問題 100% 解決
（3/3）。這個修復意外地也讓
`20260904-plan-self-correction-weak-domain-retry.md` 那個 thread
一直無法在真實環境驗證的重試邏輯終於能被觸發——log 證實 3/3 次都正確
觸發，但 3/3 次重試後模型仍然選 `man.sendAlert`，證實那個重試機制
對這個具體案例沒有實際效果。異音案例仍卡在另一個不同的模型行為
（欄位留空），不在這次修復範圍內。整條調查線至此告一段落：工具選擇
問題的根因被精準定位到「模型對字面措辭的偏好，抽象提示改變不了」，
若要真正解決，需要規則式的確定性後處理（見下方 Open Questions），
不是這次規模能覆蓋的範圍。

# Open Questions

- 異音案例的「`employeeId`/`message` 留空」是另一種獨立的模型行為，
  沒有在這次修復範圍內處理——如果之後要處理，需要先確認這是不是
  也是某種可以用 preprocess／預設值處理的欄位缺漏模式，還是要在
  `plan()` 端另外加對應的重試/修正邏輯。
- 兩個 thread 加總後的結論：`man/orchestrator` 弱訊號 domain 的
  「工具選對了 domain 但語意不對」問題，靠 prompt 層的重試提示已經
  證實對這個模型無效。如果要真正解決，`20260904-plan-self-correction-
  weak-domain-retry.md` 的 Open Questions 已經預留了下一步方向：
  改成規則式的確定性後處理（例如偵測到這個模式時直接在 plan 前面
  插入對應 domain 的查詢步驟，而非依賴模型自己想到）——這是更大範圍
  的改動，需要另外開 thread 討論是否要做、值不值得做。
