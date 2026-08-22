# 拆分 fix/scripts-tab-drawer-schema-compat 分支上的混合改動

## Context

分支上一次累積了一批混雜的未提交改動：OrchestratorRunner 重連/failover（先前已審查）、Dashboard 任務鏈 UI 重構（先前已審查），以及一批新出現、還沒審查過的 `.py` 腳本與一份新規範文件。要求：先確認新出現的檔案是做什麼用的、跟已審查的兩個功能是不是同一個 feature，再依「一次只做一件事」拆成對應的 commit。

診斷結果：新出現的東西**不是**同一個 feature，實際上混了六件互相獨立的事——見下方「開發內容」。另外在 diff 過程中發現兩個原本不在範圍內、但需要決定怎麼處理的異常。

## 開發內容

依相依順序拆成 6 個 commit：

1. `3cfb16d` fix(agent): add reconnect and failover to OrchestratorRunner remote dispatch
2. `a824b0b` fix(agent): tighten planner prompt and normalize sequential/incomplete plans
3. `03f4bdb` docs(scripts_pi): add manifest and LLM-summary spec, retrofit existing tool schemas
4. `e3a1435` refactor(scripts_pi): rename orchestrator.deployServer to orchestrator.updateSubWebRuntime
5. `4270c1e` feat(scripts_pi): add machine.queryLog and orchestrator.createTaskChain tools
6. `68ec8b2` feat(agent): add /api/summarize natural-language execution summary
7. `a1f9f94` feat(dashboard): drag-and-drop workflow editor with missing-field prompts and LLM summary

（編號到 7 是因為原本規劃 6 個，執行中把「Planner 提示調整」跟「/api/summarize」拆成兩個獨立 commit，因為兩者除了都在 `NLPlanningService.plan()`/`summarize()` 之外沒有必然關聯，硬綁在一起會違反 CLAUDE.md 的一次一事原則。）

拆分時遇到的技術問題：TS 檔案（尤其 `NLPlanningService.ts`）跟兩份 `manifest.json` 的改動在同一個 method / 同一份重新格式化過的 JSON 裡互相糾纏，`git add -p` 幾乎切不開。做法是：先用 Read 存一份最終目標內容的備份，再用 Edit 手動把每個檔案退回到「這個 commit該有的中間狀態」逐次提交，最後 diff 回備份確認每個檔案都精確落在目標終態（僅有一處無關緊要的註解區塊順序差異）。

## 測試方式與結果

每個 commit 落地前都用 `git stash push --keep-index` 隔離出「這個 commit 真正會提交的內容」，在該精確快照上跑：
- `npx tsc --noEmit`（hiba-agent）：全部 6 次皆 clean。
- `npx jest`（hiba-agent）：測試數隨 commit 累加，最終 158/158 通過。
- 兩份 `manifest.json`：每次改動後用 `JSON.parse` 驗證仍是合法 JSON。
- 新 `.py` 腳本：`python3 -m py_compile` 過語法，另外對 `machine.queryLog.py` 做了手動 smoke test（缺 log 檔優雅降級成 `count:0`、缺 `startTime` 回傳乾淨的錯誤 JSON，兩種情境都驗證過）。
- `claw-dashboard.html`：跑了既有的 `hiba-core/tools/test-subweb-schema.mjs`（會解析這支檔案裡的 schema 處理邏輯），並用 `new Function()` 對抽出的 inline `<script>` 做語法檢查；沒有實際起服務做端對端手動操作，這部分留給下次真的要驗收 UI 時做。

全部完成後在最終狀態重跑一次 `tsc --noEmit` + `npm test`，確認整條分支歷史每個節點跟最終工作樹都是一致、乾淨的。

## 待辦 / 已知落差

- **`scripts_pi/manifest.json`（根目錄）與根目錄的 `*.py` 副本**：確認程式碼庫裡沒有任何地方讀取它們（`sync-tool-manifest.ts`、`accounting-server.mjs`、`00_setup.sh` 都只指向 `scripts_pi/deploy_http/`），研判是 `deploy_http/` 重組（commit `85e8767`）後留下的孤兒重複檔案。這次**刻意不動它們**（沒有加入任何 commit），维持原狀；要不要整批移除是後續獨立決定，不在這次範圍內。
- **`npm run tools:check`（hiba-core）持續失敗**：這是既有落差，不是這次改動造成的迴歸——`tools:check` 用 `toToolSpec()` 從 TS 端重建 manifest 並要求逐 byte 相同，但它不認得 `summaryHints`／`metadataSchemaVersion`／`retryPolicy` 這些欄位，所以只要 Pi manifest 有比 TS ToolSpec 更豐富的欄位就一定會報「not synchronized」。已在 commit `03f4bdb` 訊息裡註記；要修就要擴充 `sync-tool-manifest.ts` 支援這些欄位，是獨立任務。
- **`.env.example` 缺三個新變數**：`LLM_TIMEOUT_MS`、`SUMMARY_LLM_MODEL`、`SUMMARY_LLM_TEMPERATURE` 只在 `start.ts` 裡用 `env(key, fallback)` 給了程式碼層級預設值，沒有寫進 `.env.example`。已在 commit `68ec8b2` 訊息裡註記；照文件慣例應該補上，留給下次碰這支檔案時一併處理。
