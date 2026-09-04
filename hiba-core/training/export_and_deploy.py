"""Merge a v1 LoRA adapter and create a non-destructive Ollama tag.

Usage: python training/export_and_deploy.py [export_config.yaml] [model_tag]
Defaults to the standard config / hiba-planner:v1 for backward compatibility.
"""

import subprocess
import sys
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).parent.parent
SYSTEM_PROMPT = (
    "You are a HiBA workflow planner. Use only the supplied Core Protocol v1 nodes and tools. "
    "Return only one valid ExecutionPlan JSON object. Never invent tool names, versions, node IDs, or input fields."
)


def log(message):
    print(f"[export] {message}", flush=True)


def merge_lora(export_config, adapter_path, merged_path):
    if list(merged_path.glob("*.safetensors")):
        log(f"merged model already exists at {merged_path}; skipping merge")
        return
    if not adapter_path.exists():
        raise SystemExit(f"LoRA adapter not found: {adapter_path}")

    import fsspec  # noqa: F401
    from datasets import Dataset, DatasetDict, IterableDataset  # noqa: F401
    from llamafactory.extras import logging as _logging  # noqa: F401
    from llamafactory.hparams import DataArguments  # noqa: F401
    from llamafactory.cli import main

    sys.argv = ["llamafactory-cli", "export", str(export_config)]
    try:
        main()
    except SystemExit as error:
        if error.code:
            raise
    if not list(merged_path.glob("*.safetensors")):
        raise RuntimeError(f"merge produced no safetensors in {merged_path}")


def write_modelfile(modelfile_path, merged_path):
    modelfile_path.write_text(
        f"FROM {merged_path.as_posix()}\n\n"
        f'SYSTEM "{SYSTEM_PROMPT}"\n\n'
        "PARAMETER temperature 0\n"
        "PARAMETER top_p 0.9\n"
        'PARAMETER stop "<|eot_id|>"\n',
        encoding="utf-8",
    )


def main():
    export_config = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "training" / "export_config.yaml"
    model_tag = sys.argv[2] if len(sys.argv) > 2 else "hiba-planner:v1"

    cfg = yaml.safe_load(export_config.read_text(encoding="utf-8"))
    adapter_path = PROJECT_ROOT / Path(cfg["adapter_name_or_path"])
    merged_path = PROJECT_ROOT / Path(cfg["export_dir"])
    modelfile_path = PROJECT_ROOT / f"Modelfile-{model_tag.replace(':', '-')}"

    merge_lora(export_config, adapter_path, merged_path)
    write_modelfile(modelfile_path, merged_path)
    subprocess.run(["ollama", "create", model_tag, "-f", str(modelfile_path)], check=True, cwd=PROJECT_ROOT)
    subprocess.run([sys.executable, "benchmark_quality.py", model_tag, "--limit", "1"], check=True, cwd=PROJECT_ROOT)
    log(f"{model_tag} created; run the full benchmark before replacing any existing model tag")


if __name__ == "__main__":
    main()
