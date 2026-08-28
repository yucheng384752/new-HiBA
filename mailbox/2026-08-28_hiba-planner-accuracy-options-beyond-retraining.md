# hiba-planner 正確率：不重新訓練也能做的優化方向

背景：[[2026-08-23_hiba-planner-training-data-timerange-compound]] 完成後，`hiba-planner:v1`
（`lora_target: all`）已達 eval exact=93.8%（見 `training/quality-history.jsonl`）。討論「除了重新
訓練還有哪些方式可以提高正確性」時列出以下 6 個方向，均針對這次診斷過程中實際觀察到的失敗模式
（幻覺工具名、`timeRange` 這類巢狀 schema 欄位名稱錯誤、相對時間無法計算），非泛用清單。

## 1. JSON Schema 約束生成（已著手實作，見下方進度）

`HttpLLMClient.ts` 目前對 Ollama 送的是 `format: 'json'`——只保證語法合法，不保證欄位名稱/enum
值/工具名正確。Ollama（本機 0.32.9）支援把完整 JSON Schema 物件傳給 `format`，觸發 grammar-based
約束解碼，讓模型在生成階段就不可能吐出目錄以外的工具名。直接對應這次診斷的兩個主要失敗模式
（幻覺工具名、`timeRange.from/to` 這類欄位名稱錯誤）。

## 2. 補上「現在時間」錨點（已實作，見 Vault `plan_LLM_訓練清單.md` §十二）

`NLPlanningService`/`HttpLLMClient` 的 context 完全沒有「現在時間」欄位，模型無法正確計算「過去
24小時」這類相對時間任務（[[2026-08-23_hiba-planner-plan-quality-diagnosis]] 已記錄這個缺口）。
加一個 `requestedAt: <ISO 8601>` 欄位進 context schema + prompt 即可解決一整類任務失敗，屬程式碼
層小改動。

## 3. Tool 名稱模糊比對修正（後處理層）

`validatePlan` 抓到 `TOOL_NOT_FOUND` 時，除了現有的「重試並告知錯誤」，可以先用字串相似度
（Levenshtein）比對真實工具目錄，自動修正明顯筆誤（`env.readTemperature`→`env.readSensor`），修
正得了就省一次重試往返。

## 4. 動態縮減 prompt 裡的工具目錄

現在每次都塞全部工具的完整 schema 進 prompt（36+ 個工具 ≈ 9.4k 字元，這也是
`fix/planner-prompt-context-overflow` 分支要處理的問題背景）。可先用關鍵字/embedding 比對任務描
述，只塞相關的一小批工具進去——context 越乾淨，模型越不容易在無關資訊裡選錯。

## 5. Multi-sample + 一致性檢查

同一任務跑 2-3 次（temperature > 0），多數結果一致才採用，否則觸發重試或轉人工確認。成本是多打
幾次 LLM 換正確率，適合高風險/寫入類任務（例如 `machine.executeOrder`）。

## 6. Few-shot 範例直接放進 system prompt（已實作，見 Vault `plan_LLM_訓練清單.md` §十二）

不用微調，直接在 prompt 裡放 2-3 個「任務描述 → 正確 ExecutionPlan」範例（尤其是複合任務、
`timeRange` 這種訓練資料才剛補上的場景）。比微調快，但每次呼叫都要多付 token 成本。

## 優先順序（使用者確認）

先做 #1 + #2——都是程式碼層小改動，直接堵住已診斷出的具體失敗模式，不用等推理成本上升（不像
multi-sample）也不用重跑訓練。#1、#2、#6 已實作（#6 提前於 #3–#5 做，因為直接對應 #1/#2 的
失敗模式且同樣不需重訓）。#3（工具名模糊修正）、#4（動態縮減工具目錄）、#5（multi-sample）
尚未實作。

## 追加發現：新增 Tool 需要重訓的問題（2026-08-28，20 情境集測試後）

`gen-training-data.mjs` 目前每筆訓練範例都用同一組固定 14 個工具，模型學到的比較接近
「背 14 個字串」而非「讀目錄選工具」的可泛化能力——#1 的 schema 約束能擋掉幻覈工具名，
但擋不住「選到目錄裡別的、錯的工具」。這代表**目前的訓練方式下，每次擴充工具目錄都需要
重訓（或至少增量微調）**，不是這 6 個推論期優化方向能單獨解決的。修法需要回到訓練資料
生成策略本身（每筆範例的工具目錄隨機化 + held-out tool 驗證泛化能力）。完整分析見 Vault
`plan_LLM_訓練清單.md`「延伸結論：目前的訓練方式下，每次擴充 Tool 目錄都需要重訓」一節。
