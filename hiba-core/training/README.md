# HiBA Planner — Training Pipeline

Fine-tunes `meta-llama/Llama-3.1-8B-Instruct` with LoRA (via LLaMA-Factory) and deploys the result as an Ollama model named `hiba-planner`.

## Prerequisites

- Python 3.11+（3.13 需要 `run_train.py` 的依賴預載處理，已內建）
- LLaMA-Factory：`pip install llamafactory`
- Ollama 0.1.26+（需支援 `FROM /path/to/hf/dir`）
- Dataset `hiba_workflow` 已註冊至 LLaMA-Factory dataset registry

## Quickstart

```bash
# Step 1 — Fine-tune（從 hiba-core/ 目錄執行）
python training/run_train.py

# Step 2 — Merge LoRA + 部署至 Ollama
python training/export_and_deploy.py
```

---

## 完整流程

```
run_train.py
  └─ llamafactory-cli train train_config.yaml
       └─ 輸出: training/hiba-planner-lora/   ← LoRA adapter weights

export_and_deploy.py
  ├─ 1. LLaMA-Factory export  →  training/hiba-planner-merged/  (safetensors)
  ├─ 2. 寫入 Modelfile         →  hiba-core/Modelfile
  ├─ 3. ollama create hiba-planner
  └─ 4. 推論 smoke-test
```

---

## 腳本說明

| 檔案 | 用途 |
|---|---|
| `run_train.py` | **訓練入口**。以正確順序預載 C extension（避免 Python 3.13 segfault），再執行 LLaMA-Factory SFT 訓練。 |
| `train_config.yaml` | 訓練超參數：base model、LoRA rank/alpha、dataset、epoch、輸出路徑。 |
| `export_and_deploy.py` | **部署入口**。合併 LoRA → safetensors、寫入 Modelfile、呼叫 `ollama create`、執行 smoke-test。 |
| `export_config.yaml` | 由 `export_and_deploy.py` 自動產生，勿手動編輯。 |
| `watch_training.py` | 選用：每 5 分鐘輪詢 `trainer_state.json`，訓練完成後自動觸發 `export_and_deploy.py`。 |
| `convert_wrapper.py` | 選用 GGUF 路徑：修補 `gguf` 0.18.0 缺少的 arch enum，再執行 `_convert_hf_to_gguf.py`。僅需 `.gguf` 檔案時使用（Ollama 已支援直接匯入 safetensors，一般不需要此步驟）。 |
| `_convert_hf_to_gguf.py` | llama.cpp 的 HF → GGUF 轉換腳本。只透過 `convert_wrapper.py` 呼叫。 |

---

## 選用：Watcher（無人值守）

訓練開始前或進行中，在第二個終端機啟動 watcher：

```bash
# Terminal 1
python training/run_train.py

# Terminal 2
python training/watch_training.py
```

Watcher 偵測到 `global_step ≥ 36` 或 `adapter_model.safetensors` 存在時，自動接續執行 `export_and_deploy.py`。

---

## 輸出目錄

| 路徑 | 內容 | Git |
|---|---|---|
| `training/hiba-planner-lora/` | LoRA adapter weights | excluded（`.gitignore`）|
| `training/hiba-planner-merged/` | 合併後 HF safetensors | excluded（`.gitignore`）|
| `hiba-core/Modelfile` | Ollama model definition | tracked |

---

## 僅重新部署（訓練已完成）

若 LoRA 訓練已完成，只需重新建立 Ollama 模型：

```bash
python training/export_and_deploy.py
```

`hiba-planner-merged/*.safetensors` 已存在時，腳本會跳過 LoRA merge 步驟直接部署。

---

## 推論環境變數

```bash
LLM_URL=http://localhost:11434/v1/chat/completions
LLM_MODEL=hiba-planner
LLM_FORMAT=ollama
```
