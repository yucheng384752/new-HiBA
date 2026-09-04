"""Append a completed training run's config + final metrics to training/run-history.jsonl.

Reads all_results.json (written automatically by the HF Trainer into output_dir)
plus the tracked hyperparameters from the run's own config yaml. Called
automatically by run_train.py after each training run -- every run gets a
permanent record, not just whatever scrolled past in the terminal.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

HISTORY_PATH = Path(__file__).parent / "run-history.jsonl"

TRACKED_CONFIG_KEYS = [
    "model_name_or_path",
    "dataset",
    "lora_rank",
    "lora_alpha",
    "lora_target",
    "disable_gradient_checkpointing",
    "cutoff_len",
    "per_device_train_batch_size",
    "gradient_accumulation_steps",
    "num_train_epochs",
    "learning_rate",
    "output_dir",
]


def main(config_path: Path) -> None:
    cfg = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    output_dir = Path(cfg["output_dir"])
    results_path = output_dir / "all_results.json"
    if not results_path.exists():
        raise SystemExit(f"[record_run] {results_path} not found -- training did not complete, nothing to record")
    results = json.loads(results_path.read_text(encoding="utf-8"))

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config_file": str(config_path),
        **{key: cfg.get(key) for key in TRACKED_CONFIG_KEYS},
        **results,
    }
    with HISTORY_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(
        f"[record_run] appended to {HISTORY_PATH}: "
        f"train_loss={results.get('train_loss')} eval_loss={results.get('eval_loss')} "
        f"train_runtime={results.get('train_runtime')}",
        flush=True,
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python training/record_run.py <train_config.yaml>")
    main(Path(sys.argv[1]))
