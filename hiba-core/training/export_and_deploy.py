"""Merge the v1 LoRA adapter and create a non-destructive Ollama v1 tag."""

import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
ADAPTER_PATH = PROJECT_ROOT / "training" / "hiba-planner-v1-lora"
MERGED_PATH = PROJECT_ROOT / "training" / "hiba-planner-v1-merged"
EXPORT_CONFIG = PROJECT_ROOT / "training" / "export_config.yaml"
MODELFILE = PROJECT_ROOT / "Modelfile"
MODEL_TAG = "hiba-planner:v1"
SYSTEM_PROMPT = (
    "You are a HiBA workflow planner. Use only the supplied Core Protocol v1 nodes and tools. "
    "Return only one valid ExecutionPlan JSON object. Never invent tool names, versions, node IDs, or input fields."
)


def log(message):
    print(f"[export] {message}", flush=True)


def merge_lora():
    if list(MERGED_PATH.glob("*.safetensors")):
        log("merged v1 model already exists; skipping merge")
        return
    if not ADAPTER_PATH.exists():
        raise SystemExit(f"LoRA adapter not found: {ADAPTER_PATH}")

    import fsspec  # noqa: F401
    from datasets import Dataset, DatasetDict, IterableDataset  # noqa: F401
    from llamafactory.extras import logging as _logging  # noqa: F401
    from llamafactory.hparams import DataArguments  # noqa: F401
    from llamafactory.cli import main

    sys.argv = ["llamafactory-cli", "export", str(EXPORT_CONFIG)]
    try:
        main()
    except SystemExit as error:
        if error.code:
            raise
    if not list(MERGED_PATH.glob("*.safetensors")):
        raise RuntimeError(f"merge produced no safetensors in {MERGED_PATH}")


def write_modelfile():
    MODELFILE.write_text(
        f"FROM {MERGED_PATH.as_posix()}\n\n"
        f'SYSTEM "{SYSTEM_PROMPT}"\n\n'
        "PARAMETER temperature 0\n"
        "PARAMETER top_p 0.9\n"
        'PARAMETER stop "<|eot_id|>"\n',
        encoding="utf-8",
    )


def main():
    merge_lora()
    write_modelfile()
    subprocess.run(["ollama", "create", MODEL_TAG, "-f", str(MODELFILE)], check=True, cwd=PROJECT_ROOT)
    subprocess.run([sys.executable, "benchmark_quality.py", MODEL_TAG, "--limit", "1"], check=True, cwd=PROJECT_ROOT)
    log(f"{MODEL_TAG} created; run the full benchmark before replacing any existing model tag")


if __name__ == "__main__":
    main()
