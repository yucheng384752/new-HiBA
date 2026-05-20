"""
Post-training pipeline (runs after retraining completes):
  1. Merge new LoRA → safetensors
  2. Convert to GGUF (F16)
  3. ollama create hiba-planner:latest (F16)
  4. ollama create hiba-planner:q4km  (Q4_K_M)
  5. Benchmark both
  6. If Q4KM quality >= F16 - 5%: promote Q4KM to latest
"""
import json, os, sys, subprocess, urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT       = Path(__file__).parent
TRAIN_DIR  = ROOT / "training"
ADAPTER    = TRAIN_DIR / "hiba-planner-lora"
MERGED     = TRAIN_DIR / "hiba-planner-merged"
GGUF_FILE  = TRAIN_DIR / "hiba-planner.gguf"
MODELFILE  = ROOT / "Modelfile"
EXPORT_CFG = TRAIN_DIR / "export_config.yaml"

SYSTEM = (
    "你是 HiBA 工作流程規劃師。"
    "根據節點資源清單，將使用者的繁體中文任務拆解成 ExecutionPlan JSON。"
    "只回傳純 JSON，不加任何說明。"
)

STD_INPUT = json.dumps({
    "node-1":[{"name":"cut.sh","version":"1.2.0","type":"script"},{"name":"切割機","version":"2.0.0","type":"tool"}],
    "node-2":[{"name":"cnc_job.sh","version":"1.0.3","type":"script"},{"name":"CNC-03","version":"3.1.0","type":"tool"}],
    "node-3":[{"name":"qc_check.sh","version":"1.1.0","type":"script"},{"name":"品質檢測儀","version":"1.0.0","type":"tool"}],
    "node-4":[{"name":"report.sh","version":"2.3.0","type":"script"},{"name":"report-svc","version":"1.5.0","type":"service"}],
    "node-5":[{"name":"transfer.sh","version":"1.0.1","type":"script"},{"name":"搬運車","version":"1.0.0","type":"tool"}],
}, ensure_ascii=False)

BENCHMARKS = [
    ("把 鋁合金板 從 倉庫A 切割後送到 QC 暫存區",          ["node-1","node-5"], ["material","destination"]),
    ("不鏽鋼管 切割後進行品質檢測，不合格送 manual-review",  ["node-1","node-3"], ["material"]),
    ("矽晶圓 切割後 CNC 精密加工，再做品質檢測，產出 JSON", ["node-1","node-2","node-3"], ["material","output"]),
    ("對 QC 暫存區的 PCB板 品質檢測後合格品搬到 出貨區",    ["node-3","node-5"], ["destination"]),
    ("鈦合金零件 緊急訂單：跳過品質檢測直接 CNC 加工後搬到 出貨區", ["node-2","node-5"], ["destination"]),
    ("請產生 node-1 到 node-3 今日作業 PDF 日報",          ["node-4"], ["output"]),
    ("批次處理 80 件 PCB板：切割→品質檢測，合格才搬到 出貨區", ["node-1","node-3","node-5"], ["destination"]),
    ("對 矽晶圓 單獨執行 CNC 精密加工，不需要切割或 QC",    ["node-2"], ["material"]),
]

def log(msg): print(f"[pipeline] {msg}", flush=True)

def run(cmd, **kw):
    log(f"$ {' '.join(cmd)}")
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise RuntimeError(f"Command failed: {cmd}")
    return r

# ── Step 1: merge ────────────────────────────────────────────────────────────
def merge_lora():
    log("Merging LoRA adapter…")
    import json as _j, enum, typing, fsspec
    from datasets import DatasetDict, Dataset, IterableDataset
    from llamafactory.extras import logging as _lf
    from llamafactory.hparams import DataArguments

    EXPORT_CFG.write_text(
        f"model_name_or_path: meta-llama/Llama-3.1-8B-Instruct\n"
        f"adapter_name_or_path: {ADAPTER}\n"
        f"export_dir: {MERGED}\n"
        f"export_device: cpu\n",
        encoding="utf-8",
    )
    import shutil
    if MERGED.exists(): shutil.rmtree(MERGED)
    MERGED.mkdir(parents=True)

    sys.argv = ["llamafactory-cli", "export", str(EXPORT_CFG)]
    from llamafactory.cli import main
    try: main()
    except SystemExit as e:
        if e.code != 0: raise
    shards = list(MERGED.glob("*.safetensors"))
    log(f"Merge OK — {len(shards)} shard(s)")

# ── Step 2: GGUF conversion ───────────────────────────────────────────────────
def convert_gguf():
    log("Converting HF safetensors → GGUF F16…")
    # apply gguf patch
    import gguf
    for _i, _name in enumerate(["GEMMA4","DEEPSEEK2OCR","HUNYUAN_VL","MISTRAL4"]):
        if not hasattr(gguf.MODEL_ARCH, _name):
            _v = max(e.value for e in gguf.MODEL_ARCH) + _i + 1
            _m = int.__new__(gguf.MODEL_ARCH, _v)
            _m._name_ = _name; _m._value_ = _v
            gguf.MODEL_ARCH._member_map_[_name] = _m
            gguf.MODEL_ARCH._value2member_map_[_v] = _m
            type.__setattr__(gguf.MODEL_ARCH, _name, _m)
            gguf.MODEL_ARCH_NAMES[_m] = _name.lower().replace("_","-")
            gguf.MODEL_TENSORS[_m] = {}

    script = TRAIN_DIR / "_convert_hf_to_gguf.py"
    code = script.read_text(encoding="utf-8")
    g = {"__name__":"__main__","__file__":str(script)}
    sys.argv = [str(script), str(MERGED), "--outfile", str(GGUF_FILE), "--outtype","f16"]
    exec(compile(code, str(script), "exec"), g)
    log(f"GGUF OK — {GGUF_FILE.stat().st_size/1e9:.1f} GB")

# ── Step 3: F16 ollama model ──────────────────────────────────────────────────
def create_ollama_models():
    MODELFILE.write_text(
        f'FROM {GGUF_FILE.as_posix()}\n\n'
        f'SYSTEM "{SYSTEM}"\n\n'
        'PARAMETER temperature 0.1\nPARAMETER top_p 0.9\nPARAMETER stop "<|eot_id|>"\n',
        encoding="utf-8",
    )
    run(["ollama", "rm", "hiba-planner"], capture_output=True)
    run(["ollama", "rm", "hiba-planner:q4km"], capture_output=True)
    run(["ollama", "create", "hiba-planner", "-f", str(MODELFILE)])
    log("F16 model created")

# ── Step 4: Q4KM ollama model (created AFTER F16 benchmark) ──────────────────
def create_q4km_model():
    run(["ollama", "create", "hiba-planner:q4km", "-f", str(MODELFILE), "--quantize", "q4_K_M"])
    log("Q4KM model created")

# ── Step 5: benchmark ─────────────────────────────────────────────────────────
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
MAX_SCORE = 10

def query(model, prompt, timeout=90):
    body = json.dumps({"model":model,"system":SYSTEM,
        "prompt":f"節點資源：{STD_INPUT}\n任務：{prompt}","stream":False}).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL, data=body,
                                 headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())["response"].strip()
    except Exception as e:
        return f"ERROR:{e}"

def score(raw, expected_nodes, must_args):
    s = 0
    try: d = json.loads(raw)
    except: return s
    if isinstance(d.get("steps"), list) and len(d["steps"]) > 0: s += 4
    if "supervisorPolicy" in d: s += 1
    actual = {st.get("nodeId") for st in d.get("steps",[])}
    if set(expected_nodes) <= actual: s += 3
    elif set(expected_nodes) & actual: s += 1
    all_args = {}
    for st in d.get("steps",[]): all_args.update(st.get("args",{}))
    if all(a in all_args for a in must_args): s += 2
    elif any(a in all_args for a in must_args): s += 1
    return s

def benchmark(model):
    # warm-up: ensure model is loaded before timed benchmark queries
    query(model, "切割機測試", timeout=180)
    total = sum(score(query(model, instr), nodes, args)
                for instr, nodes, args in BENCHMARKS)
    pct = total / (MAX_SCORE * len(BENCHMARKS)) * 100
    log(f"{model}: {total}/{MAX_SCORE*len(BENCHMARKS)} ({pct:.1f}%)")
    return pct

# ── Step 6: decide ────────────────────────────────────────────────────────────
def decide_compression(f16_pct, q4_pct):
    diff = f16_pct - q4_pct
    log(f"F16={f16_pct:.1f}%  Q4KM={q4_pct:.1f}%  diff={diff:.1f}%")
    if diff < 5:
        log("Quality gap < 5% → promoting Q4KM to hiba-planner:latest")
        run(["ollama", "cp", "hiba-planner:q4km", "hiba-planner:best"])
        log("hiba-planner:best = Q4_K_M (4.9 GB)")
    else:
        log(f"Quality gap {diff:.1f}% ≥ 5% → keeping F16 as hiba-planner:latest")

if __name__ == "__main__":
    merge_lora()
    convert_gguf()
    create_ollama_models()
    f16_pct = benchmark("hiba-planner:latest")   # warm-up included; F16 fully loaded
    create_q4km_model()
    q4_pct  = benchmark("hiba-planner:q4km")     # warm-up included; Q4KM fully loaded
    decide_compression(f16_pct, q4_pct)
    log("Pipeline complete.")
