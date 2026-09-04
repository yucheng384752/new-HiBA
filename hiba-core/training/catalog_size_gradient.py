"""Follow-up to scoped_catalog_experiment.py (plan_LLM_訓練清單.md §十五): that
experiment tested one aggressive reduction (36 -> ~10 tools, capped 3-12) and
found exact match collapses to 0%. This script isolates a different variable:
is the collapse a cliff at some specific catalog size, or does accuracy
degrade smoothly as the catalog shrinks? A milder, topology/RAG-grouped
reduction (e.g. "all tools for this production line") might land above a
cliff even if an aggressive top-12 cut lands below it -- that's the concrete
question this measures before deciding whether RAG/topology-based tool
selection has ANY viable catalog size, independent of retraining.

Fixed catalog sizes tested (all on the SAME 20-row subset of hiba-v1-eval.jsonl
for a controlled comparison): 36 (baseline, no scoping), 30, 24, 18, 12.
v1-optimized only (the actually-deployed model), schema-constrained decoding
only (matches production's LLM_FORMAT=openai path per §10.8 -- schema
constraint is always-on in production, so an unconstrained number here
wouldn't answer the deployment question).

Run: python training/catalog_size_gradient.py
"""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from benchmark_quality import query, component_scores

EVAL_PATH = Path(__file__).parent / "data" / "hiba-v1-eval.jsonl"
PRINT_SYSTEM_PROMPT_SCRIPT = Path(__file__).parent.parent / "tools" / "print-system-prompt.ts"
REQUESTED_AT = "2026-08-28T12:00:00Z"
SUBSET_SIZE = 20
SIZES = [36]  # temporarily narrowed to just the baseline to debug the unexpected 0/20 -- see plan_LLM_訓練清單.md §十五 follow-up
URL = "http://localhost:11434/api/generate"
MODEL = "hiba-planner:v1-optimized"


def bigrams(text):
    return {text[i:i + 2] for i in range(len(text) - 1)}


def top_n_tools(instruction, tools, n):
    if n >= len(tools):
        return tools
    task_grams = bigrams(instruction)
    scored = sorted(
        tools,
        key=lambda t: len(task_grams & bigrams(t["name"] + " " + t.get("description", ""))),
        reverse=True,
    )
    return scored[:n]


def build_system_prompt(resources, nodes, tools):
    payload = json.dumps({"resources": resources, "nodes": nodes, "tools": tools, "requestedAt": REQUESTED_AT})
    result = subprocess.run(
        ["node", "--require", "ts-node/register", str(PRINT_SYSTEM_PROMPT_SCRIPT)],
        input=payload, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return result.stdout


def main():
    with open(EVAL_PATH, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f][:SUBSET_SIZE]

    # Correctness check first, same discipline as scoped_catalog_experiment.py:
    # confirm the smallest size (12) never excludes a ground-truth tool on
    # this subset before spending inference time on it.
    excluded = 0
    for row in rows:
        ctx = json.loads(row["context"])
        expected = json.loads(row["output"])
        scoped_names = {t["name"] for t in top_n_tools(row["instruction"], ctx["tools"], 12)}
        for step in expected.get("steps", []):
            if step["toolName"] not in scoped_names:
                excluded += 1
    print(f"correctness check: {excluded} ground-truth tool references excluded at size=12 (of {SUBSET_SIZE} rows)")
    if excluded:
        print("WARNING: results below are confounded by filter exclusions, not just model behavior")

    for size in SIZES:
        exact_total = 0
        errors = 0
        for i, row in enumerate(rows):
            ctx = json.loads(row["context"])
            expected = json.loads(row["output"])
            tools = ctx["tools"] if size == 36 else top_n_tools(row["instruction"], ctx["tools"], size)
            system = row["system"] if size == 36 else build_system_prompt(ctx["resources"], ctx["nodes"], tools)
            fake_row = {"instruction": row["instruction"], "system": system,
                        "context": json.dumps({**ctx, "tools": tools}, ensure_ascii=False)}
            import time
            t0 = time.time()
            try:
                actual = json.loads(query(URL, MODEL, fake_row, 90, True))
                dt = time.time() - t0
                score = component_scores(actual, expected)["exact"]
                exact_total += score
                status = "OK" if score else "MISS"
                print(f"  size={size} row={i} [{status}] {dt:.1f}s")
                if not score:
                    print(f"    expected: {json.dumps(expected, ensure_ascii=False)[:250]}")
                    print(f"    actual:   {json.dumps(actual, ensure_ascii=False)[:250]}")
            except Exception as e:
                dt = time.time() - t0
                errors += 1
                print(f"  size={size} row={i} [ERROR after {dt:.1f}s] {e}")
        print(f"size={size:>2}  exact={exact_total}/{len(rows)} ({100*exact_total/len(rows):.0f}%)  errors={errors}")


if __name__ == "__main__":
    main()
