"""Validate Core v1 data, then launch LLaMA-Factory LoRA training."""

import json
import os
import subprocess
import sys
import enum
import typing
from pathlib import Path

import fsspec
from datasets import Dataset, DatasetDict, IterableDataset, concatenate_datasets, interleave_datasets
from llamafactory.extras import logging as lf_logging
from llamafactory.hparams import DataArguments
from llamafactory.data.data_utils import Role, split_dataset  # noqa: F401
from llamafactory.data.collator import SFTDataCollatorWith4DAttentionMask  # noqa: F401


if __name__ == "__main__":
    project_root = Path(__file__).parent.parent
    os.chdir(project_root)
    config_path = sys.argv[1] if len(sys.argv) > 1 else "training/train_config.yaml"
    subprocess.run([
        "node", "tools/validate-dataset.mjs",
        "training/data/hiba-v1-train.jsonl",
        "training/data/hiba-v1-eval.jsonl",
    ], check=True)

    import datasets as _datasets
    _datasets.disable_caching()
    print(f"[run_train] dataset validated; starting Llama 3.1 LoRA training ({config_path})", flush=True)
    sys.argv = ["llamafactory-cli", "train", config_path]
    from llamafactory.cli import main
    main()

    # Every run gets a permanent record in training/run-history.jsonl -- not just terminal scrollback.
    subprocess.run([sys.executable, "training/record_run.py", config_path], check=True)
