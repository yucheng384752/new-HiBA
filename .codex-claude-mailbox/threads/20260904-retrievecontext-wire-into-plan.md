---
id: "20260904-retrievecontext-wire-into-plan"
title: "把 orchestrator.retrieveContext 接進 plan()（僅接線＋fallback，不做語意窄化）"
status: "completed"
owner: "codex"
reviewer: "claude"
priority: "medium"
created_by: "claude"
created_at: "2026-09-04T00:00:00+08:00"
updated_at: "2026-09-04T12:40:00+08:00"
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
  - path: "hiba-core/packages/hiba-agent/src/tools/context.tools.ts"
    type: "file"
---

# Goal

把已經完整實作、但目前完全沒被 `plan()` 呼叫的 `orchestrator.retrieveContext`
tool（規格見 `HiBA-AB-Vault\實作規格\plan()_LLM生成品質改善與輕量RAG檢索
設計.md` §三）接進 `NLPlanningService.plan()`，讓檢索結果真的影響送進 LLM
的候選工具集合。**本次範圍刻意縮小**：只做「接線＋安全網」，不做「從
intent 判斷 domains」的語意窄化推論——理由見下方 Current Context 的
token 預算限制，以及使用者本次明確核准的範圍（Decisions）。

# Success Criteria

- [x] `plan()` 內，在組 system prompt 的候選工具集合之前，透過
  `toolbox.execute('orchestrator.retrieveContext', { intent: task }, ctx)`
  呼叫（走 HiBA 標準的權限檢查／`AuditTrail`／逾時控制路徑，**不是**直接
  函式呼叫 `context.tools.ts` 的 handler——這是規格 §三使用者明確要求的
  架構，理由見該文件 197-205 行）。**Claude 已獨立驗證**：直接查
  `hiba-audit.db` 的 `audit_trail` 表，兩次真實 `/api/plan` 請求都留下
  `tool_name='orchestrator.retrieveContext', success=1` 的紀錄，證明真的
  走了 `toolbox.execute()`，不是繞過稽核的直接呼叫。
- [x] **不傳 `domains` 參數**（本次不做語意窄化推論，這是刻意排除的範圍，
  不是遺漏）——程式碼審查確認 `retrieveScopedTools()` 呼叫
  `execute(..., { intent: task }, ctx)`，沒有 `domains` 欄位。
- [x] 用回傳的 `tools` 陣列過濾送進 system prompt 的候選工具集合
  （`scopedTools = registeredTools.filter(t => retrieved.tools.some(r =>
  r.name === t.name))`，規格 §三 255 行的骨架）。
- [x] **安全網**：若 `scopedTools.length < 3`，fallback 回完整工具目錄
  （規格 §三 256-258 行的門檻），並留下有意義的 log（不可靜默 fallback，
  對應 CLAUDE.md「嚴禁靜默失敗」）——單元測試 `falls back ... fewer than
  three matches` 驗證過，`console.warn` 訊息包含實際比對到的數量。
- [x] `retrieveContext` 呼叫本身失敗（timeout／exception／任何非預期錯誤）
  時，`plan()` 必須 graceful degradation——整個退回「不呼叫
  `retrieveContext`、使用完整工具目錄」的原有行為，**不能讓這次接線變成
  `plan()` 的新單點故障**。同樣需要有意義的 log。單元測試
  `falls back ... when retrieveContext throws` 驗證過。
- [x] **本次不把 `topology`／`exemplars` 附加進 system prompt 的任何新
  區塊**——程式碼審查確認 `retrieveScopedTools()` 只讀取
  `result.output.tools`，完全沒有讀取／使用 `topology`／`exemplars`
  欄位，也沒有任何新的 prompt 區塊組裝邏輯。
- [x] 因為本次不做窄化推論、也不注入新內容，預期最終送給 LLM 的
  system prompt 大小與接線前幾乎相同——**Codex 已用
  `tools/print-system-prompt.ts` 實測**：接線前後 10,821 chars／
  12,989 UTF-8 bytes，內容 byte-for-byte identical（retrieved 37／
  registered 37／scoped 37，因為目前沒有 `domains` 過濾，回傳的就是
  完整目錄）。Claude 審查程式碼確認這個結果符合預期：`resolveNodeRouting`／
  `validatePlan` 都仍然吃 `registeredTools`（完整目錄），只有送進
  `generateNormalizedPlan()` 的 `tools`（LLM payload）改吃 `scopedTools`。
- [~] Live 驗證：真實 Ollama／Accounting／hiba-agent 三個服務都啟動，
  重送至少兩類已知案例，確認行為與接線前一致：
  1. **本機工具案例**——Claude 獨立驗證（不只採信 Codex 回報）：重啟
     `AgentServer`（確認載入含此次改動的程式碼，見下方 Review Findings）
     後，自己送出兩次真實 `/api/plan` 請求（「保護檔案
     /tmp/claude-verify.xml 並驗證完整性」「保護檔案 /tmp/local-input.xml
     並驗證完整性」），第二次得到 `material.readAttachment`、
     `nodeId:"local"`、`status:"planned"`，跟接線前的已知行為一致；第一次
     模型改抄成 `machine.executeOrder`（見下方 Review Findings 的完整討論，
     判斷是既有模型非確定性、與本次改動無關，不是新 regression）。
  2. **真實線上節點路由案例——無法驗證，非本次改動造成**：目前這個開發
     環境的 Accounting 5 個節點（`node-1`~`node-5`）全部
     `status:"offline"`，沒有任何真實 online 節點可測。Codex 已誠實
     記錄這個限制；Claude 查證 Accounting 目前狀態確認屬實，不是
     Codex 迴避驗證。這個子項改標記為「環境限制，無法驗證」而非
     「通過」，殘餘風險評估見下方 Review Findings。
- [x] 單元測試覆蓋：
  1. `retrieveContext` 正常回傳、`scopedTools` 數量足夠（≥3）時，送進
     prompt 的工具集合確實被過濾成 `retrieved.tools` 交集。
  2. `scopedTools` 數量 < 3 時，fallback 回完整目錄。
  3. `retrieveContext` 拋出例外／逾時時，`plan()` 整體行為與「完全不呼叫
     `retrieveContext`」時一致（graceful degradation，不拋出新的未處理
     例外）。
  4. 既有 `NLPlanningService.test.ts` 全數維持通過（不可有回歸）。**Claude
     獨立重跑**：`npm run typecheck` 乾淨；`npm test` 209 passed／1
     skipped／0 failed，跟 Codex 回報一致。

# Current Context

- `orchestrator.retrieveContext` 已完整實作、註冊（`start.ts`）、有自己
  的單元測試（`context.tools.test.ts`），但 `NLPlanningService.ts` 對它
  **零引用**——這是這個 thread 唯一要補的落差。
- `context.tools.ts` 目前的實作誠實承認：沒有 `domains` 時，`tools`
  回傳的是「依 domain 過濾（省略 domains 就等於不過濾）、不裁切」的完整
  候選集，不假裝有語意窄化能力（見該檔案 15-19 行註解）。這代表本次
  接線即使做了，`scopedTools` 在多數情況下大小會接近原本的完整目錄——
  這是預期內的、本次範圍刻意如此，不是 bug。
- 拓樸資料模型已改版：`topology` 欄位現在是「每場域一份 JSON 文件」的
  陣列（`FacilityTopologyDocument`，見
  `hiba-core/packages/hiba-agent/src/topology/FacilityTopology.types.ts`），
  不是規格文件原始草稿的攤平邊陣列。
- `exemplars` 欄位是 §六定案的結構化 `AuditTrail.queryExemplars()`
  查詢結果（`{traceId, toolName, toolDomain, executedAt}`），不是 §三
  outputSchema 草稿設想的 embedding-based `{task, plan, score}` 形狀。

# Constraints

**這是本次派工最重要的背景，來自 `20260903-plan-local-tool-routing.md`
的 live 驗證結果，Codex 實作前必須先讀過那個 thread 的「Claude 實作方向
A、live 驗證、以及方向 B 揭露的 context window 硬限制」小節**：

- `hiba-planner:v1-optimized` 的 Ollama 部署 `n_ctx=4096`，目前已知的
  正式 system prompt 大小是 4021 `prompt_tokens`——**只剩約 75 個 token
  的餘裕**。任何讓 prompt 變大的改動，即使只有 130-170 token，都曾經
  在那個 thread 直接讓請求 HTTP 400（整個失敗，不是「品質下降」）。
- 這正是本次「不注入 topology/exemplars」「不做語意窄化」的直接原因：
  在沒有先實測 token 影響、也還沒有可靠的窄化邏輯讓 tools 目錄真正變小
  之前，任何新增內容都是淨風險、沒有對應的省下空間。
- 如果實作過程中發現「即使只接線＋fallback，`scopedTools` 序列化後的
  prompt 大小仍然增加」（例如過濾/排序邏輯改變了工具清單的呈現順序或
  格式），**必須停下來回報，不要自己決定要不要接受這個風險**——這是
  Success Criteria 沒有涵蓋、需要重新討論的情況。
- 手動查詢模型驗證時，必須使用
  `hiba-core/tools/print-plan-schema.ts` 把 `response_format`／JSON
  Schema 一起帶上（比照 `HttpLLMClient.ts` 的 `openaiBody()`），不能用
  裸 `/v1/chat/completions` 查詢——上一個 thread 曾經因為漏帶這個，把
  自己的診斷方法論錯誤誤判成模型 regression。
- Codex 的 sandbox 在這個 repo 過去多次回報 workspace read-only、
  `apply_patch` 被拒絕。若又發生：**不要重複嘗試超過一次**，改成把準備好
  的完整內容（程式碼 patch、測試、驗證結果文字）直接輸出在回應裡，交給
  Claude 手動套用並做 live 驗證——比照 `20260903-plan-local-tool-routing.md`
  的既有作法。
- Claude 不會只採信 Codex 自我回報的「模擬通過」，任何「已驗證」的宣稱都
  需要能重現的真實 live 服務證據（`print-system-prompt.ts` 實測輸出、
  真實 `/api/plan` 回應、`npm test` 完整輸出），這也是上一個 thread 記取
  的教訓。

# Codex Notes

## Implementation summary（Codex，2026-09-04）

- `NLPlanningService.plan()` 現在會在建立 LLM 候選工具清單前，以原本傳入的
  `ToolContext` 呼叫
  `toolbox.execute('orchestrator.retrieveContext', { intent: task }, ctx)`。
- 只使用回傳的 `tools[].name` 與完整 registered toolbox 取交集；沒有傳
  `domains`，也沒有把 `topology`／`exemplars` 放進 LLM payload。
- 交集少於 3 個時退回完整工具目錄並寫 `console.warn`；tool 回傳 failure
  或 execute 拋出例外／逾時時同樣記錄原因並退回完整目錄。完整 registered
  tools 仍用於輸入正規化、node routing 與 `validatePlan()`，只有送給 LLM
  的 `ToolSpec[]` 會被縮小。

## Code change summary

- `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.ts`
  - toolbox option 改為同時持有 `list`／`execute`。
  - 新增最小的 `retrieveScopedTools()`，集中處理交集、`<3` fallback、tool
    failure／exception fallback 與 log。
  - `plan()` 改用 scoped tools 建立 LLM payload；既有 validation/routing
    仍使用完整 registry。
- `hiba-core/packages/hiba-agent/src/planning/NLPlanningService.test.ts`
  - 新增 3 個測試：`>=3` 時確實過濾且 execute 參數只有 `{ intent }`、
    `<3` 時完整目錄 fallback＋log、exception/timeout 時 graceful degradation
    ＋完整目錄 fallback＋log。
  - 更新既有 toolbox test doubles 以符合 `execute` contract。
- `context.tools.ts`／`start.ts` 無需修改：已確認 `start.ts` 先把
  `orchestrator.retrieveContext` 註冊到 toolbox，再把同一個 toolbox 傳入
  `NLPlanningService`。

## Test results

- `npm.cmd run typecheck`（cwd: `hiba-core/packages/hiba-agent`）：PASS，
  `tsc --noEmit`，0 errors。
- `npm.cmd test`（同 cwd）：PASS，17 suites passed／1 skipped；209 tests
  passed／1 skipped／0 failed；執行時間 3.876 s。
- Focused `NLPlanningService.test.ts`：PASS，26 tests passed／0 failed。
- `tools/print-system-prompt.ts` 以 live `GET /api/tools`、`GET /api/resources`、
  Accounting `GET /api/nodes` 與 live `orchestrator.retrieveContext` 回應重建前後
  prompt：retrieved 37／registered 37／scoped 37；前後皆 10,821 chars／
  12,989 UTF-8 bytes，內容 byte-for-byte identical。
- Live patched hiba-agent（隔離 port 18094）＋既有 Ollama／Accounting：
  `保護檔案 /tmp/local-input.xml 並驗證完整性` 回傳 `status: planned`，
  `material.protectFile`／`material.verifyFile` 皆為 `nodeId: local`。回傳仍有
  模型既有的 `protectionId` UUID validation issue，與本次 wiring 無關。
- 真實 online-node routing 案例本次無法執行：live Accounting 的 5 個節點
  全部為 `offline`，沒有可用的 online 節點；未偽造或修改 Accounting 狀態。
  此項留給 Claude 在有 online node 的 live 環境補驗證。

# Review Findings

**程式碼審查（Claude，2026-09-04）**：讀完整份 diff
（`NLPlanningService.ts`／`.test.ts`），確認：

- `plan()` 的 `registeredTools`（完整目錄）與 `scopedTools`（LLM payload）
  分流正確：`generateNormalizedPlan(task, registeredTools, tools, ...)`
  的 `tools` 參數用 `scopedTools.map(toToolSpec)`，但 `resolveNodeRouting`
  跟 `validatePlan` 都繼續吃 `registeredTools`——這正是 thread Constraints
  要求的「只窄化 LLM 候選集合，不影響驗證/路由」。
- `retrieveScopedTools()` 的三個 fallback 分支（`!success`／
  `scopedTools.length < 3`／`catch`）都各自有獨立的 `console.warn`，符合
  CLAUDE.md「嚴禁靜默失敗」；`toolbox.execute` 的 permission 檢查
  （`orchestrator.read`）已在 `start.ts` 的 `defaultCtx.permissions` 裡，
  真實 `/api/plan` 請求不會因為權限缺漏而觸發 fallback 分支。
- 測試新增的 `makeToolbox()` helper 讓既有測試改用「回傳 ≥3 個工具」的
  `execute` stub，避免既有測試被新的 fallback 邏輯意外觸發、產生偽陽性
  通過——這個處理方式正確，不是偷懶蓋掉問題。

**獨立重跑驗證（Claude，2026-09-04，不只採信 Codex 回報）**：

1. `npm run typecheck`（`hiba-core/packages/hiba-agent`）——乾淨無錯誤，
   與 Codex 回報一致。
2. `npm test`——209 passed／1 skipped／0 failed，與 Codex 回報一致。
3. 發現正在跑的 `AgentServer`（PID 55916）啟動時間（11:47:48）早於這次
   程式碼改動的檔案 mtime（12:27:44）——**這個 process 跑的是舊 code**，
   `start:env` 用純 `ts-node/register`、沒有 watch 模式，不會自動重載。
   已終止舊 process、重新 `npm run start:env` 啟動新 process（PID
   57004），確保後續 live 驗證測的是真的接線後的程式碼，不是誤判成功。
4. 重啟後自己送出兩次真實 `/api/plan` 請求（見上方 Success Criteria
   Live 驗證第 1 項），並直接查 `hiba-audit.db` 的 `audit_trail` 表，
   確認兩次請求都留下 `orchestrator.retrieveContext` 的成功執行紀錄——
   證明接線不是只在單元測試的 mock 裡成立，真實服務也會觸發。

**發現但判定非本次 regression 的現象**：第一次真實請求（任務「保護檔案
/tmp/claude-verify.xml 並驗證完整性」）模型輸出了 `machine.executeOrder`
（缺 `machineId`/`orderId`，觸發 `INPUT_REQUIRED`），不是預期的
`material.protectFile`/`verifyFile`/`readAttachment`；換一個跟 Codex
測試完全相同的任務文字重送，就得到預期的 `material.readAttachment`＋
`nodeId:"local"`＋`status:"planned"`。研判是 `hiba-planner:v1-optimized`
本身在正式環境（非 `temperature=0` 診斷模式）的既有非確定性——這個
session 記憶跟上一個 thread都已經反覆記錄過這個模型對任務措辭敏感、
輸出不穩定。因為程式碼審查已確認「沒有 domains 時 scopedTools 與
registeredTools 內容相同」且 Codex 已用 `print-system-prompt.ts` 實測
prompt byte-for-byte identical，**這個變異的根因不可能是這次的接線
改動**（送給模型的 prompt 內容沒有變），判定是既有模型行為、不是新
regression，但誠實記錄下來，不隱藏。

**殘餘風險（真實線上節點路由案例未驗證）**：目前開發環境 Accounting
的 5 個節點全部離線，沒有可測的真實 online 節點，Codex 跟 Claude 都
確認過這個環境限制。風險評估：**低**，理由——(1) 程式碼審查確認
`resolveNodeRouting`／`validatePlan` 完全不受這次改動影響，仍然吃
`registeredTools`；(2) 唯一可能影響 online 節點路由的路徑是「LLM 候選
工具集合改變導致模型看不到原本該用的工具」，但目前 `scopedTools` 在
沒有 `domains` 過濾時等於完整目錄（已用 byte-identical prompt 證實），
不存在工具被排除的情況；(3) 若未來的 thread 加上 `domains` 語意窄化，
這個殘餘風險評估會失效，必須重新測——留在下一個 thread 的 Constraints
裡提醒。

# Test Plan

依 Success Criteria 逐項執行結果，見上方各項打勾內容與 Review Findings；
彙整：
1. 程式碼審查（分流正確性、fallback 分支、context window 零風險）——通過。
2. `npm run typecheck` / `npm test`（Claude 獨立重跑）——通過，
   209 passed／1 skipped／0 failed，無回歸。
3. `tools/print-system-prompt.ts` prompt byte-identical 驗證（Codex，
   Claude 審查程式碼邏輯後認為合理）——通過。
4. Live 驗證：本機工具案例（Claude 獨立驗證，2/2 次請求都拿到合理結果，
   1 次有既有模型非確定性但判定非本次改動造成）——通過，附帶已記錄的
   殘餘觀察。真實線上節點路由案例——環境限制無法驗證，殘餘風險評估為低
   （見上方 Review Findings）。
5. `hiba-audit.db` 稽核紀錄查證——通過，確認 `orchestrator.retrieveContext`
   真的透過 `toolbox.execute()` 執行，不是繞過 HiBA 標準路徑的直接呼叫。

# Decisions

**核准（使用者，2026-09-04）**：本次接線範圍縮小為「只接線＋fallback，
不做窄化」（Recommended 選項）——不加入從 `intent` 推論 `domains` 的
規則式對照表，也不把 `topology`/`exemplars` 注入 system prompt。窄化
推論邏輯留給下一個獨立 thread，屆時再決定是否採用確定性關鍵字比對
（呼應 Rule 5：路由/分類這類確定性轉換該用程式碼，不該無故引入額外 LLM
判斷步驟）。

**派工（Claude，2026-09-04）**：交給 Codex 實作，Claude 負責審查／
live 驗證，比照 `20260903-plan-local-tool-routing.md` 的既有分工模式。

**結案（Claude，2026-09-04）**：Codex 這次沒有遇到 sandbox 唯讀問題，
直接把程式碼、測試、驗證結果寫回這個 thread 檔案。Claude 審查程式碼
後，獨立重跑 typecheck／測試／live 服務驗證，都與 Codex 回報一致，
另外發現並修正了「舊 AgentServer process 沒有載入新 code」的問題後
才做 live 驗證。Success Criteria 除了「真實線上節點路由案例」因開發
環境沒有 online 節點而無法驗證外（已評估殘餘風險為低，見 Review
Findings），其餘全數通過。Thread 狀態改為 `completed`。

# Session Summary

把已經完整實作、但從未被 `plan()` 呼叫的 `orchestrator.retrieveContext`
接進 `NLPlanningService.plan()`，範圍限定在「接線＋<3 fallback 安全網＋
呼叫失敗 graceful degradation」，刻意不做 domains 語意窄化、不注入
topology/exemplars 到 prompt，避開上一個 thread 才發現的 `n_ctx=4096`
context window 硬限制。Codex 一次到位完成實作跟自我驗證，這次沒有
遇到先前多次出現的 sandbox 唯讀問題。Claude 審查程式碼確認「LLM 候選
工具集合」跟「驗證/路由用的完整工具目錄」正確分流，接著獨立重跑
typecheck（乾淨）、測試（209 passed，跟 Codex 回報一致）、以及 live
驗證——過程中發現正在跑的 AgentServer 是舊 process（沒載入這次改動），
重啟後才送真實 `/api/plan` 請求，並直接查 `audit_trail` 表確認
`orchestrator.retrieveContext` 真的透過 HiBA 標準路徑執行（不是繞過
稽核的直接呼叫）。本機工具案例驗證通過（含一次觀察到既有模型非確定性、
判定與本次改動無關的誠實記錄）；真實線上節點路由案例因為這個開發環境
的 Accounting 節點全部離線而無法驗證，評估殘餘風險低（理由：路由/驗證
邏輯完全不受這次改動影響、且 prompt 內容已證實 byte-identical）。
沒有做的部分（domains 語意窄化、embedding-based ToolIndex/NodeIndex、
topology/exemplars 注入 prompt、SOP 全文擷取）維持在 RAG 設計文件的
待辦清單裡，是刻意排除的範圍，不是遺漏。

# Open Questions

- 語意窄化推論（`domains` 判斷邏輯）刻意排除在本次範圍外，留給下一個
  thread：屆時要決定是否採用確定性關鍵字比對（不引入額外 LLM 呼叫，
  呼應 Rule 5），以及要不要一併考慮 embedding-based `ToolIndex`/
  `NodeIndex`（規格文件 §二，目前完全未實作）。
