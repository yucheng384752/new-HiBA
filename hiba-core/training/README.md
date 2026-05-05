# HiBA Planner Fine-tuning

## 環境需求
- Python 3.10+
- CUDA 11.8+（GPU ≥ 8GB VRAM）
- LLaMA-Factory：`pip install llmtuner`

## 訓練

```bash
llamafactory-cli train training/train_config.yaml
```

## 匯出 GGUF 並建立 Ollama 模型

```bash
llamafactory-cli export \
  --model_name_or_path meta-llama/Llama-3.1-8B-Instruct \
  --adapter_name_or_path training/hiba-planner-lora \
  --export_dir training/hiba-planner-merged \
  --export_quantization_bit 4 \
  --export_format gguf

echo "FROM ./training/hiba-planner-merged/model.gguf" > Modelfile
ollama create hiba-planner -f Modelfile
```

## 切換推論端點

```bash
LLM_URL=http://localhost:11434/v1/chat/completions
LLM_MODEL=hiba-planner
LLM_FORMAT=ollama
```

## 快速測試推論

```bash
ollama run hiba-planner "把 鋁合金板 從 倉庫A 切割後送到 QC 暫存區"
```
