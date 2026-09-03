"""Experiment (not production code): rebuilds training/data/hiba-v1-eval.jsonl
with a per-row SCOPED tool catalog instead of the full fixed 36-tool one, to
answer a concrete question before touching plan()'s prompt-construction code:
does narrowing "Available Tools" to just the tools relevant to a task help or
hurt exact-match accuracy on the currently-deployed model?

Why this matters (see plan_LLM_訓練清單.md §十一延伸結論): every training row
for hiba-planner:v1 / v1-optimized shows nearly the full tool catalog (35-36
of 36 tools) -- there is no training signal for "a small, task-relevant
subset". Scoping the catalog at inference time is therefore an input shape
the model has never seen in training. This script measures the effect
empirically via benchmark_quality.py instead of assuming either direction.

Relevance scoring: character-bigram overlap between the row's `instruction`
and each candidate tool's `name + description`. No embeddings/RAG infra
exists in this project yet (checked); bigram overlap is the simplest thing
that works for Chinese text without a tokenizer, and is fair here because
these eval instructions were generated FROM the tools' own description
templates (gen-training-data.ts), so a real match should score highly.
Keeps any tool scoring above a small floor, always keeps at least 3, caps at
12 (~1/3 of the full 36) so the reduction is real -- multi-step scenarios in
this eval set use at most 4 distinct tools per row.

Output: training/data/hiba-v1-eval-scoped.jsonl (same instruction/output as
the original row; `system` rebuilt via the real buildDefaultSystemPrompt()
for the scoped tool list; `context.tools` scoped to match, so
benchmark_quality.py's schema-constrained decoding enum is scoped too --
this mirrors how a real implementation would work, since HttpLLMClient.ts
uses the same `payload.tools` for both the prompt and the schema enum).

Run: python training/scoped_catalog_experiment.py
Then compare against the existing baseline (plan_LLM_訓練清單.md §10.6):
  python benchmark_quality.py hiba-planner:v1-optimized --schema-format \
    --dataset training/data/hiba-v1-eval-scoped.jsonl
"""

import json
import subprocess
from pathlib import Path

IN_PATH = Path(__file__).parent / "data" / "hiba-v1-eval.jsonl"
OUT_PATH = Path(__file__).parent / "data" / "hiba-v1-eval-scoped.jsonl"
PRINT_SYSTEM_PROMPT_SCRIPT = Path(__file__).parent.parent / "tools" / "print-system-prompt.ts"
REQUESTED_AT = "2026-08-28T12:00:00Z"  # matches gen-training-data.ts's REQUESTED_AT

MIN_TOOLS = 3
MAX_TOOLS = 12
SCORE_FLOOR = 1  # a tool with zero bigram overlap is never included


def bigrams(text):
    return {text[i:i + 2] for i in range(len(text) - 1)}


def score_tool(task_grams, tool):
    tool_text = tool["name"] + " " + tool.get("description", "")
    tool_grams = bigrams(tool_text)
    return len(task_grams & tool_grams)


def scope_tools(instruction, tools):
    task_grams = bigrams(instruction)
    scored = sorted(
        ((score_tool(task_grams, t), t) for t in tools),
        key=lambda pair: pair[0], reverse=True,
    )
    above_floor = [t for s, t in scored if s >= SCORE_FLOOR]
    scoped = above_floor[:MAX_TOOLS] if above_floor else []
    if len(scoped) < MIN_TOOLS:
        scoped = [t for _, t in scored[:MIN_TOOLS]]
    return scoped


def build_system_prompt(resources, nodes, tools):
    """Shells out to tools/print-system-prompt.ts so this experiment's prompt
    is byte-for-byte what the real buildDefaultSystemPrompt() would produce
    for this tool list, not a hand-maintained copy (same rationale as
    build_c6_scenarios.py)."""
    payload = json.dumps({
        "resources": resources, "nodes": nodes,
        "tools": tools, "requestedAt": REQUESTED_AT,
    })
    result = subprocess.run(
        ["node", "--require", "ts-node/register", str(PRINT_SYSTEM_PROMPT_SCRIPT)],
        input=payload, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return result.stdout


def main():
    rows_out = []
    catalog_sizes = []
    with open(IN_PATH, encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            ctx = json.loads(row["context"])
            scoped_tools = scope_tools(row["instruction"], ctx["tools"])
            catalog_sizes.append(len(scoped_tools))
            system = build_system_prompt(ctx["resources"], ctx["nodes"], scoped_tools)
            new_ctx = {**ctx, "tools": scoped_tools}
            rows_out.append({
                "instruction": row["instruction"],
                "system": system,
                "output": row["output"],
                "context": json.dumps(new_ctx, ensure_ascii=False),
            })

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        for row in rows_out:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    avg = sum(catalog_sizes) / len(catalog_sizes)
    print(f"wrote {len(rows_out)} rows to {OUT_PATH}")
    print(f"tool catalog size: min={min(catalog_sizes)} p50={sorted(catalog_sizes)[len(catalog_sizes)//2]} "
          f"max={max(catalog_sizes)} mean={avg:.1f} (full catalog was 36)")


if __name__ == "__main__":
    main()
