"""Redo of catalog_size_gradient.py against training/data/hiba-v1-eval-legacy.jsonl
(pre-baa2fa3 snapshot: `git show baa2fa3~1:.../hiba-v1-eval.jsonl`), which
matches the prompt format AND 13-tool catalog hiba-planner:v1-optimized was
actually trained on -- see plan_LLM_訓練清單.md §十六 for why the current
hiba-v1-eval.jsonl no longer does (regenerated twice, both after the model's
weights were frozen).

Uses the OLD (pre-§十四) query() logic byte-for-byte: short generic SYSTEM
constant + full context concatenated into `prompt`, over the native
/api/generate endpoint. That combination is what the historical 89.1%/93.8%
baseline was actually measured with, and is unaffected by this model's
TEMPLATE quirk (the dropped `system` field never carried anything load-
bearing in this path -- the catalog/context lives in `prompt`, which the
`{{ .Prompt }}` template does render).

Fixed catalog sizes on the SAME 20-row subset: 13 (baseline, no scoping),
10, 7, 4, 2 -- a gradient sized to an actual 13-tool catalog, not the 36-tool
one catalog_size_gradient.py assumed.

Run: python training/legacy_catalog_gradient.py
"""

import json
import time
import urllib.request
from pathlib import Path

EVAL_PATH = Path(__file__).parent / "data" / "hiba-v1-eval-legacy.jsonl"
URL = "http://127.0.0.1:11434/api/generate"
MODEL = "hiba-planner:v1-optimized"
SUBSET_SIZE = 20
SIZES = [13, 10, 7, 4, 2]
TIMEOUT = 90

SYSTEM = ("You are a HiBA workflow planner. Use only the supplied Core Protocol v1 nodes and tools. "
          "Return only one ExecutionPlan JSON object. Tool names, versions, node IDs, input fields, "
          "and dependencies must exactly match the supplied context.")


def build_plan_json_schema(tools):
    tool_names = [tool["name"] for tool in tools]
    tool_name_prop = {"type": "string", "enum": tool_names} if tool_names else {"type": "string"}
    return {
        "type": "object",
        "properties": {
            "protocolVersion": {"type": "string", "const": "1.0"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "stepId": {"type": "string"}, "toolName": tool_name_prop,
                        "nodeId": {"type": "string"}, "version": {"type": "string"},
                        "input": {"type": "object"}, "dependsOn": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["stepId", "toolName", "nodeId", "version", "input", "dependsOn"],
                },
            },
            "supervisorPolicy": {"type": "string", "enum": ["fail-fast", "partial-success"]},
            "error": {"type": "string"},
        },
        "required": ["protocolVersion", "steps", "supervisorPolicy"],
    }


def query(instruction, input_obj, tools):
    ctx = {**input_obj, "tools": tools}
    prompt = f"Core Protocol v1 context:\n{json.dumps(ctx, ensure_ascii=False)}\n\nUser task:\n{instruction}"
    fmt = build_plan_json_schema(tools)
    body = json.dumps({
        "model": MODEL, "system": SYSTEM, "prompt": prompt, "format": fmt,
        "stream": False, "options": {"temperature": 0},
    }).encode("utf-8")
    request = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read())["response"].strip()


def component_scores(actual, expected):
    names = ("schema", "tool", "node", "input", "dependency", "exact")
    if not isinstance(actual, dict):
        return dict.fromkeys(names, 0)
    actual_steps = actual.get("steps") if isinstance(actual.get("steps"), list) else []
    well_formed = all(isinstance(s, dict) for s in actual_steps)
    expected_steps = expected["steps"]
    paired = list(zip(actual_steps, expected_steps)) if well_formed else []
    same_count = well_formed and len(actual_steps) == len(expected_steps)
    return {
        "schema": int(actual.get("protocolVersion") == "1.0" and same_count and actual.get("supervisorPolicy") == expected["supervisorPolicy"]),
        "tool": int(same_count and all(a.get("toolName") == e["toolName"] and a.get("version") == e["version"] for a, e in paired)),
        "node": int(same_count and all(a.get("nodeId") == e["nodeId"] for a, e in paired)),
        "input": int(same_count and all(a.get("input") == e["input"] for a, e in paired)),
        "dependency": int(same_count and all(a.get("stepId") == e["stepId"] and a.get("dependsOn") == e["dependsOn"] for a, e in paired)),
        "exact": int(actual == expected),
    }


def bigrams(text):
    return {text[i:i + 2] for i in range(len(text) - 1)}


def top_n_tools(instruction, tools, n):
    if n >= len(tools):
        return tools
    task_grams = bigrams(instruction)
    scored = sorted(tools, key=lambda t: len(task_grams & bigrams(t["name"] + " " + t.get("description", ""))), reverse=True)
    return scored[:n]


def main():
    with open(EVAL_PATH, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f][:SUBSET_SIZE]

    excluded = 0
    for row in rows:
        inp = json.loads(row["input"])
        expected = json.loads(row["output"])
        scoped_names = {t["name"] for t in top_n_tools(row["instruction"], inp["tools"], 2)}
        for step in expected.get("steps", []):
            if step["toolName"] not in scoped_names:
                excluded += 1
    print(f"correctness check: {excluded} ground-truth tool refs excluded at size=2 (of {SUBSET_SIZE} rows)")

    for size in SIZES:
        exact_total, errors = 0, 0
        for i, row in enumerate(rows):
            inp = json.loads(row["input"])
            expected = json.loads(row["output"])
            tools = inp["tools"] if size == 13 else top_n_tools(row["instruction"], inp["tools"], size)
            t0 = time.time()
            try:
                actual = json.loads(query(row["instruction"], inp, tools))
                dt = time.time() - t0
                score = component_scores(actual, expected)["exact"]
                exact_total += score
                status = "OK" if score else "MISS"
                print(f"  size={size} row={i} [{status}] {dt:.1f}s")
            except Exception as e:
                dt = time.time() - t0
                errors += 1
                print(f"  size={size} row={i} [ERROR after {dt:.1f}s] {e}")
        print(f"size={size:>2}  exact={exact_total}/{len(rows)} ({100*exact_total/len(rows):.0f}%)  errors={errors}")


if __name__ == "__main__":
    main()
