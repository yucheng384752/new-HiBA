"""
Monitors training completion by polling trainer_state.json and the adapter
output directory. When training finishes (global_step == max_steps),
automatically launches export_and_deploy.py.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT  = Path(__file__).parent.parent
ADAPTER_PATH  = PROJECT_ROOT / "training" / "hiba-planner-lora"
STATE_FILE    = ADAPTER_PATH / "trainer_state.json"
EXPORT_SCRIPT = PROJECT_ROOT / "training" / "export_and_deploy.py"

CHECK_INTERVAL = 300  # seconds between polls
TOTAL_STEPS    = 36   # must match train_config.yaml


def log(msg: str) -> None:
    print(f"[watch] {msg}", flush=True)


def training_complete() -> bool:
    # Primary signal: trainer_state.json written at end of training
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            step = state.get("global_step", 0)
            log(f"trainer_state.json found — global_step={step}/{TOTAL_STEPS}")
            if step >= TOTAL_STEPS:
                return True
        except Exception as e:
            log(f"Could not parse trainer_state.json: {e}")

    # Secondary signal: adapter weights written
    adapter = ADAPTER_PATH / "adapter_model.safetensors"
    if adapter.exists():
        log("adapter_model.safetensors detected.")
        return True

    return False


def main() -> None:
    log(f"Started. Polling every {CHECK_INTERVAL}s for training completion.")
    log(f"Adapter output dir: {ADAPTER_PATH}")

    while True:
        if training_complete():
            log("Training complete — launching export pipeline.")
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT)],
                capture_output=False,
            )
            if result.returncode == 0:
                log("Export pipeline finished successfully.")
            else:
                log(f"Export pipeline exited with code {result.returncode}.")
            sys.exit(result.returncode)

        log("Training still in progress…")
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
