"""Diagnostic only: profile one real forward+backward of the LoRA-wrapped
Llama-3.1-8B model to find where the 700s/microbatch actually goes.
Not part of the training pipeline; safe to delete after use.
"""
import json
import time

import torch
from torch.profiler import profile, ProfilerActivity
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

MODEL = "meta-llama/Llama-3.1-8B-Instruct"
CUTOFF_LEN = 512  # small probe: same op breakdown, far less wall time than the real 4096/batch4 case

print("[profile_step] loading tokenizer + model...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(MODEL)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
model = AutoModelForCausalLM.from_pretrained(
    MODEL, dtype=torch.bfloat16, device_map={"": 0}, low_cpu_mem_usage=True,
)
model.gradient_checkpointing_enable()
model.enable_input_require_grads()

lora_cfg = LoraConfig(
    r=32, lora_alpha=64, lora_dropout=0.05,
    target_modules=["up_proj", "down_proj", "gate_proj", "k_proj", "q_proj", "o_proj", "v_proj"],
    task_type="CAUSAL_LM",
)
model = get_peft_model(model, lora_cfg)
model.train()
print("[profile_step] model ready, trainable params:", sum(p.numel() for p in model.parameters() if p.requires_grad), flush=True)

# Build one real batch from the smoke train set, tokenized the same way llamafactory would
rows = [json.loads(l) for l in open("training/smoke/data/hiba-v1-train.jsonl", encoding="utf-8") if l.strip()][:4]
texts = [f"{r['instruction']}\n{r['input']}\n{r['output']}" for r in rows]
enc = tokenizer(texts, return_tensors="pt", padding="max_length", truncation=True, max_length=CUTOFF_LEN)
enc = {k: v.to("cuda") for k, v in enc.items()}
labels = enc["input_ids"].clone()

optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4)

def one_step():
    optimizer.zero_grad(set_to_none=True)
    out = model(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"], labels=labels)
    out.loss.backward()
    optimizer.step()
    torch.cuda.synchronize()
    return out.loss.item()

print("[profile_step] warmup step...", flush=True)
t0 = time.time()
loss = one_step()
print(f"[profile_step] warmup done in {time.time()-t0:.1f}s, loss={loss:.4f}", flush=True)

print("[profile_step] profiled step starting...", flush=True)
t0 = time.time()
with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA], record_shapes=False) as prof:
    loss = one_step()
dt = time.time() - t0
print(f"[profile_step] profiled step took {dt:.1f}s, loss={loss:.4f}", flush=True)

print("\n===== TOP 25 BY SELF CUDA TIME =====", flush=True)
print(prof.key_averages().table(sort_by="self_cuda_time_total", row_limit=25), flush=True)
print("\n===== TOP 25 BY SELF CPU TIME =====", flush=True)
print(prof.key_averages().table(sort_by="self_cpu_time_total", row_limit=25), flush=True)

total_cuda = sum(e.self_cuda_time_total for e in prof.key_averages())
total_cpu = sum(e.self_cpu_time_total for e in prof.key_averages())
print(f"\n[profile_step] sum self_cuda_time_total={total_cuda/1e6:.2f}s  sum self_cpu_time_total={total_cpu/1e6:.2f}s", flush=True)
