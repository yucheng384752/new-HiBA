"""Run the canonical v1 export and evaluation commands."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent

subprocess.run([sys.executable, "training/export_and_deploy.py"], check=True, cwd=ROOT)
subprocess.run([sys.executable, "benchmark_quality.py", "hiba-planner:v1"], check=True, cwd=ROOT)
