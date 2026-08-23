# hiba-planner 任務鏈品質問題：診斷與程式碼層防護

分支 `fix/planner-prompt-context-overflow`，commit `03c6c82`。

## 背景

前一輪對話手動測 `/api/plan` 時，同一個 hiba-agent 對兩個不同任務描述都回傳了同一組引用
`material.protectFile`/`material.verifyFile` 的計畫，懷疑 LLM 規劃品質有問題。使用者要求：
1. 確認 LLM 能不能根據任務內容產出不同的任務鏈。
2. 另開任務處理 hiba-planner 品質問題。

## 診斷過程（重點：找到真正 root cause 前先修正了一個環境誤判）

第一次用 isolated context（假造「無節點註冊」）直接測 `hiba-planner:latest`/`hiba-planner:best`，
兩個模型都能正確依任務描述給出不同工具——一開始誤以為模型本身沒問題。

後來確認 `localhost:9090` 其實是這台機器上**已經在跑的真實 Accounting Server**（不是我猜測的另一個
AgentServer），裡面有兩個真的在線節點 `m2`/`m3`（`192.168.200.43:3000`/`3001`），各自掛了 9 個工具
（`machine.executeOrder`、`env.readSensor` 等），但都沒有掛 `material.protectFile`/`verifyFile`。改用真實
accounting 資料重跑，才重現原本的壞行為。

第一次重現時，不小心在切分支的過程中把 base 建在過舊的 `main`（落後 `fix/scripts-tab-drawer-schema-compat`
15 個 commit，工具目錄、`hiba.tools.ts` 內容都不同）。發現後整支分支重建在正確的
`fix/scripts-tab-drawer-schema-compat` 之上，重跑一次診斷確認同樣可重現，才動手改 production 程式碼。

## Root Cause（已用真實 LLM + 真實 accounting server 資料證實，非只是推測）

用 production 的 `buildDefaultSystemPrompt`（36 個工具、真實 `m2`/`m3` 節點描述，~9.4k 字元）實際打
Ollama，抓到模型的原始輸出：

- 任務「讀取感測器溫度並記錄到稽核日誌」：模型自己掰了兩個不存在的工具名
  `env.readTemperature`（該用 `env.readSensor`）、`material.recordAudit`（catalog 裡根本沒有），
  且 S2 的 `input` 物件漏了一個右括號，JSON 語法本身就是壞的。
- 任務「查詢過去24小時的稽核執行摘要」：這次工具名選對了（`orchestrator.getAuditSummary`），但
  `timeRange` 用了錯的欄位名（`start`/`end`，正確應為 `from`/`to`）跟非 ISO 8601 佔位字串
  （`"now-24h"`），而且結尾用了 `)` 取代 `}`，同樣是語法壞掉的 JSON。

對照組：「讀取全部環境感測器溫度濕度」這個任務（剛好對應 `env.readSensor`，且該工具沒有必填參數）
兩個模型都答對，證明**模型並非完全不會依任務內容產出不同計畫**——問題集中在：(a) 目標工具需要模型
自己推斷/翻譯工具名，或 (b) 需要模型自己合成結構化/衍生輸入值（如時間區間）的時候。

## 已做的程式碼層防護（fix/planner-prompt-context-overflow, commit 03c6c82）

- `HttpLLMClient.complete()`：JSON 解析失敗時重試一次，把壞掉的原始輸出連同「請修正」訊息一起餵回模型。
- `NLPlanningService.plan()`：`validatePlan` 回報 `TOOL_NOT_FOUND`（幻覺工具名，不同於
  `AGENT_NOT_REGISTERED` 那種「工具是真的但沒有在線節點」）時重試一次，明確點出哪個名字是錯的。

測試：hiba-agent 全套 162/162 通過（原 158 + 新增 4 個：`HttpLLMClient.test.ts` 2 個涵蓋重試成功／
重試上限，`NLPlanningService.test.ts` 2 個涵蓋幻覺工具名重試成功／連續兩次都失敗時正確 fail loud）。
`tsc --noEmit` 乾淨。

## 已知限制（誠實記錄，沒有誇大修復效果）

用真實 LLM 對原本那兩個失敗任務重新跑過修好的 `NLPlanningService.plan()`：**兩個任務都還是失敗**，
錯誤訊息一樣是 `Plan parse failed: ... received: string`。追查發現：在完整 production prompt 下，
模型對同一個任務的第一次與重試後輸出**幾乎一模一樣**（同樣的壞 JSON 結構），代表這個模型在目前
的 prompt 長度／複雜度下，光靠一次文字糾正沒辦法可靠地跳出同一種錯誤模式。

重試機制本身沒有白做——它會在模型第二次真的給出不同輸出時發揮作用（已用 mock 測試證實），也不會
讓原本就正常的計畫變差——只是對這兩個原始案例沒有達到「完全修復」。

## 待辦 / 後續選項（未擅自決定，留給使用者選）

1. ~~加一層機械式的括號配平修復~~ ——**已完成，見下方「機械式括號配平修復」段落**。
2. 從根本改善 `hiba-planner` 的訓練資料（`hiba-core/training`，LoRA pipeline），補上複合任務／
   結構化輸入（時間區間等）的訓練範例——這已經超出「程式碼防護」範圍，需要重新準備訓練資料並跑
   微調，不在這次分支處理。

## 機械式括號配平修復（同日追加，commit `0cfa793`）

新增 `repairBracketBalance()`（`HttpLLMClient.ts`），在 `tryParseJson()` 裡當 `JSON.parse` 與程式碼區塊
擷取都失敗時，用一個 stack 追蹤每個 `{`/`[` 該對應的 closer，機械式修正兩種真實抓到的壞掉模式：
少了一個 `}` 就補上、或是把不該出現在 JSON 語法位置的 `)`（一律視為打錯的 `}`/`]`）換成正確的
closer。只處理字串字面值以外的結構符號，對已經合法的 JSON 是 no-op。

用真實模型 + 真實 accounting server 重新對原本那兩個失敗任務跑過完整 `NLPlanningService.plan()`：
**兩個任務的 JSON 都成功解析了**——`Plan parse failed: expected object, received string` 這個錯誤消失，
換成 `validatePlan` 給出的具體錯誤（`No online node can execute 'env.readTemperature@1.0.0'`、
`Invalid enum value...` 等）。也就是說：**機械式修復確實達成了它的目標**（修好語法），但兩個任務
本身還是因為模型選錯工具名／編造不存在的 enum 值而驗證失敗——這是上面已經記錄的模型能力問題，
不是這次修復的範圍，不會假裝已經解決。

測試：新增 5 個 `repairBracketBalance` 案例（含兩筆真實抓到的壞字串原樣測試）+ 1 個「一次 HTTP call
內就地修復、不用重試」的案例，並把原本假設「一定要重試」的測試改成用真的無法修復的內容（純文字，非
JSON 形狀）。hiba-agent 全套 168/168 通過，`tsc --noEmit` 乾淨。
