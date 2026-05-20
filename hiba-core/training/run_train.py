"""
Bootstrap script: pre-loads C extension dependencies in correct order
to avoid Python 3.13 segfault when llamafactory.data is imported directly.

Must use if __name__ == '__main__' guard — Windows multiprocessing uses
spawn, which re-imports this module in child processes.
"""
import json, os, sys, enum, typing

# fsspec must be initialised before datasets touches its registry
import fsspec

# datasets triggers all pyarrow / multiprocessing init
from datasets import (
    DatasetDict,
    concatenate_datasets,
    interleave_datasets,
    Dataset,
    IterableDataset,
)

# llamafactory internal modules — order matters
from llamafactory.extras import logging as lf_logging
from llamafactory.hparams import DataArguments

# Verify the previously-segfaulting submodules now load cleanly
from llamafactory.data.data_utils import Role, split_dataset  # noqa: F401
from llamafactory.data.collator import SFTDataCollatorWith4DAttentionMask  # noqa: F401

if __name__ == "__main__":
    # Disable Arrow file-cache to avoid WinError 1224 (mmap lock on Windows)
    import datasets as _ds
    _ds.disable_caching()

    print("[run_train] dependency pre-load OK — starting training", flush=True)
    sys.argv = ["llamafactory-cli", "train", "training/train_config.yaml"]
    from llamafactory.cli import main
    main()
