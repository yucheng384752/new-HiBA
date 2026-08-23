# hiba-planner 訓練資料：補上 timeRange 結構化輸入與複合任務範例

分支 `feat/hiba-planner-training-data-timerange-compound`，接續
[[2026-08-23_hiba-planner-plan-quality-diagnosis]] 待辦第 2 項（原分支
`fix/planner-prompt-context-overflow` 未處理的部分，本次獨立開分支處理）。

## 背景

診斷文件已確認 root cause：production 工具目錄中會用到巢狀 `timeRange: {from, to}`
結構的工具（`orchestrator.getAuditSummary`、`machine.calculateOee`、`machine.listAlarms`），
訓練資料集（`hiba-core/training/data/hiba-v1-*.jsonl`，由 `tools/gen-training-data.mjs`
產生）裡完全沒有出現過——`grep timeRange` 是 0 筆。模型沒看過這個 schema 形狀，才會在
`start`/`end` 欄位名稱、ISO 8601 格式上瞎猜。同時複合任務（3 步以上依賴鏈）也完全沒有
訓練樣本，原本 256+64 筆資料的 step 數分布只有 1 或 2。

## 已做的變更

`hiba-core/tools/gen-training-data.mjs`：

1. `TOOLS` 補上 `machine.calculateOee`、`machine.listAlarms`、`orchestrator.getAuditSummary`，
   inputSchema 逐欄核對 production 原始定義（`hiba.tools.ts` / `audit.tools.ts`），
   確保訓練資料的 schema 跟真實工具契約一致。
2. 新增 `VALUES.timeRanges`：4 組**絕對** ISO 8601 區間常數。
3. 新增 5 個 SCENARIOS：
   - 3 個單步驟情境，指令文字直接把 `timeRanges` 的 `from`/`to` 寫進任務描述裡
     （例如「計算機台 X 從 2026-08-20T00:00:00Z 到 2026-08-21T00:00:00Z 的 OEE」），
     訓練目標是「照抄成 `timeRange.from`/`timeRange.to`」。
   - 2 個 3 步依賴鏈情境（跨機台/跨感測器領域各一），其中各含一步使用 `timeRange`，
     複合任務與結構化輸入兩個訓練目標疊加。

跑 `npm run dataset:v1` 重新產生 256 筆訓練 + 64 筆驗證資料，`npm run dataset:validate`
全部通過（`total=256 valid=256` / `total=64 valid=64`）。重新產生後的分布：
step 數 `{1: 214, 2: 63, 3: 43}`；`getAuditSummary`/`calculateOee`/`listAlarms`
分別出現在 43/44/22 筆 output 裡。

## 刻意不做的事（誠實記錄邊界）

**沒有加入「相對時間」情境**（例如原始壞案例「過去24小時」）。核實過
`NLPlanningService` / `HttpLLMClient` 的 prompt 組裝完全不含任何「現在時間」錨點
（`buildDefaultSystemPrompt` 只餵 `resources`/`nodes`/`tools`），模型無法從 context
推算「現在」，若訓練資料教「過去24小時 → 自己算 from/to」，只會讓模型學會產生一個
看起來合理但實際上瞎猜的時間戳，而非真正解決問題。這是 **prompt/context schema 層**
的缺口（需要加類似 `requestedAt` 欄位），不是訓練資料能單獨解決的，也超出這次「處理
訓練資料」的任務範圍——**留給使用者決定要不要另開任務處理**，未擅自動手。

## 尚未做的事

- 尚未實際跑 `python training/run_train.py` 重新微調 LoRA / 產出新 `hiba-planner:v1`
  模型——這次只處理訓練資料本身。是否要跑訓練、跑完後拿 `benchmark_quality.py`
  比對 `exact`/`tool`/`node`/`input`/`dependency` 指標，待使用者確認。
- 未回頭拿新資料重跑診斷文件裡那兩個原始失敗案例（因為要跑訓練 pipeline 才能驗證，
  這輪只到資料集這一步）。
