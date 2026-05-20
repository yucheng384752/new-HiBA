"""
Post-training pipeline:
  1. Merge LoRA adapter into base model (HF safetensors via LLaMA-Factory)
  2. Write Ollama Modelfile pointing at merged safetensors directory
  3. ollama create hiba-planner
  4. Quick inference smoke-test

Note: GGUF conversion via llama.cpp is skipped — Windows MAX_PATH (260 chars)
prevents cloning the llama.cpp repo. Ollama 0.1.26+ supports importing HF
safetensors directories directly via `FROM /path/to/dir` in the Modelfile.
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
ADAPTER_PATH = PROJECT_ROOT / "training" / "hiba-planner-lora"
MERGED_PATH  = PROJECT_ROOT / "training" / "hiba-planner-merged"
MODELFILE    = PROJECT_ROOT / "Modelfile"
EXPORT_CFG   = PROJECT_ROOT / "training" / "export_config.yaml"

SYSTEM_PROMPT = (
    "你是 HiBA 工作流程規劃師。"
    "根據節點資源清單，將使用者的繁體中文任務拆解成 ExecutionPlan JSON。"
    "只回傳純 JSON，不加任何說明。"
)


# ── helpers ──────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(f"[export] {msg}", flush=True)


def preload_deps() -> None:
    import json as _j, enum, typing, fsspec  # noqa: F401
    from datasets import DatasetDict, Dataset, IterableDataset  # noqa: F401
    from llamafactory.extras import logging as _lf  # noqa: F401
    from llamafactory.hparams import DataArguments  # noqa: F401


# ── step 1: LoRA merge → HF safetensors ──────────────────────────────────────

def write_export_config() -> None:
    cfg = f"""\
model_name_or_path: meta-llama/Llama-3.1-8B-Instruct
adapter_name_or_path: {ADAPTER_PATH}
export_dir: {MERGED_PATH}
export_device: cpu
"""
    EXPORT_CFG.write_text(cfg, encoding="utf-8")
    log(f"export_config.yaml written → {EXPORT_CFG}")


def run_llamafactory_export() -> bool:
    preload_deps()
    sys.argv = ["llamafactory-cli", "export", str(EXPORT_CFG)]
    try:
        from llamafactory.cli import main
        main()
        return True
    except SystemExit as e:
        return e.code == 0
    except Exception as exc:
        log(f"LLaMA-Factory export error: {exc}")
        return False


def merge_lora() -> None:
    """Merge LoRA adapter into base model; raise if safetensors not produced."""
    log("Merging LoRA adapter → HF safetensors…")
    MERGED_PATH.mkdir(parents=True, exist_ok=True)
    write_export_config()
    run_llamafactory_export()

    shards = list(MERGED_PATH.glob("*.safetensors"))
    if not shards:
        raise RuntimeError(
            f"LoRA merge failed — no safetensors in {MERGED_PATH}"
        )
    log(f"Merge complete — {len(shards)} safetensors shard(s).")


# ── step 2: Modelfile ─────────────────────────────────────────────────────────

def write_modelfile() -> None:
    """
    Write a Modelfile that points Ollama at the merged safetensors directory.
    Ollama 0.1.26+ accepts `FROM /absolute/path/to/hf/dir`.
    """
    content = (
        f'FROM {MERGED_PATH.as_posix()}\n\n'
        f'SYSTEM "{SYSTEM_PROMPT}"\n\n'
        'PARAMETER temperature 0.1\n'
        'PARAMETER top_p 0.9\n'
        'PARAMETER stop "<|eot_id|>"\n'
    )
    MODELFILE.write_text(content, encoding="utf-8")
    log(f"Modelfile written → {MODELFILE}")


# ── step 3: ollama create ────────────────────────────────────────────────────

def create_ollama_model() -> None:
    log("Running: ollama create hiba-planner …")
    r = subprocess.run(
        ["ollama", "create", "hiba-planner", "-f", str(MODELFILE)],
        capture_output=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ollama create exited {r.returncode}")
    log("Ollama model 'hiba-planner' created successfully.")


# ── step 4: smoke-test ────────────────────────────────────────────────────────

def smoke_test() -> None:
    log("Running smoke-test…")
    r = subprocess.run(
        ["ollama", "run", "hiba-planner",
         "把 鋁合金板 從 倉庫A 切割後送到 QC 暫存區"],
        capture_output=True, text=True, timeout=120,
        encoding="utf-8", errors="replace",
    )
    output = r.stdout.strip() or r.stderr.strip()
    log(f"Smoke-test response:\n{output}")
    try:
        plan = json.loads(output)
        if "steps" in plan and "supervisorPolicy" in plan:
            log("Smoke-test PASSED ✓")
        else:
            log("Smoke-test: response parsed but unexpected schema.")
    except json.JSONDecodeError:
        log("Smoke-test: response is not JSON (model may need more tuning).")


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not ADAPTER_PATH.exists():
        log(f"ERROR: adapter not found at {ADAPTER_PATH}")
        sys.exit(1)

    # Skip re-merge if safetensors already present from a previous run
    existing_shards = list(MERGED_PATH.glob("*.safetensors"))
    if existing_shards:
        log(f"Merged model already exists ({len(existing_shards)} shards) — skipping re-merge.")
    else:
        merge_lora()

    write_modelfile()
    create_ollama_model()
    smoke_test()
    log("Pipeline complete. hiba-planner is ready in Ollama.")
