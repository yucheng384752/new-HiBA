# HiBA Planner v1：Llama 3.1 + LoRA

底模固定為 `meta-llama/Llama-3.1-8B-Instruct`。這一版只重訓 LoRA，目標是讓模型依 Accounting Server 提供的節點、ToolSpec 與 JSON Schema，輸出 Core Protocol v1 `ExecutionPlan`。

## 固定契約

- 輸入：任務文字、`resources`、`NodeDescriptor[]`、`ToolSpec[]`
- 輸出：`protocolVersion`、`steps[]`、`supervisorPolicy`
- 每個 step：`stepId`、`toolName`、`nodeId`、`version`、`input`、`dependsOn`
- 禁止使用舊欄位：`tool`、`script`、`args`

## 執行順序

```powershell
npm run dataset:v1
npm run dataset:validate
python training/run_train.py
python training/export_and_deploy.py
python benchmark_quality.py hiba-planner:v1
```

訓練輸出使用 `training/hiba-planner-v1-lora/`，合併模型使用 `training/hiba-planner-v1-merged/`，因此不會覆蓋舊版。只有 `exact`、`tool`、`node`、`input`、`dependency` 指標符合部署門檻後，才應把 `hiba-planner:v1` 切換成正式模型。量化應在 F16 通過後另做比較，不放進訓練主流程。
