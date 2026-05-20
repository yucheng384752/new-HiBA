"""
Validate F16 cold-start fix: steps 3-6 only (skip merge/convert).
Run: python validate_pipeline_fix.py
"""
import sys, pathlib
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from post_train_pipeline import (
    create_ollama_models, create_q4km_model,
    benchmark, decide_compression, log,
)

log("=== Validation run (steps 3-6, GGUF reused) ===")
create_ollama_models()
f16_pct = benchmark("hiba-planner:latest")
create_q4km_model()
q4_pct  = benchmark("hiba-planner:q4km")
decide_compression(f16_pct, q4_pct)
log("=== Validation complete ===")
