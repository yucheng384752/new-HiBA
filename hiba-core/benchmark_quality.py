"""Evaluate HiBA Core Protocol v1 planning accuracy through Ollama."""

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

QUALITY_HISTORY_PATH = Path(__file__).parent / "training" / "quality-history.jsonl"


def build_plan_json_schema(tools):
    """Python port of HttpLLMClient.ts's buildPlanJsonSchema -- restricts
    steps[].toolName to an enum of the tools actually on offer for this row,
    so a hallucinated name is rejected by Ollama's grammar-constrained
    decoding instead of just being scored wrong after the fact."""
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
                        "stepId":    {"type": "string"},
                        "toolName":  tool_name_prop,
                        "nodeId":    {"type": "string"},
                        "version":   {"type": "string"},
                        "input":     {"type": "object"},
                        "dependsOn": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["stepId", "toolName", "nodeId", "version", "input", "dependsOn"],
                },
            },
            "supervisorPolicy": {"type": "string", "enum": ["fail-fast", "partial-success"]},
            "error": {"type": "string"},
        },
        "required": ["protocolVersion", "steps", "supervisorPolicy"],
    }


def query(url, model, row, timeout, schema_format):
    # `system`/`instruction` are now the exact production prompt shape
    # (built by the real buildDefaultSystemPrompt(), see
    # plan_LLM_訓練清單.md §十四) instead of this script's own
    # hand-maintained raw-JSON-context format -- `context` (not sent to the
    # model) still carries the structured {resources, nodes, tools} this
    # function needs for schema-constrained decoding.
    fmt = build_plan_json_schema(json.loads(row["context"])["tools"]) if schema_format else "json"
    body = json.dumps({
        "model": model,
        "system": row["system"],
        "prompt": row["instruction"],
        "format": fmt,
        "stream": False,
        "options": {"temperature": 0},
    }).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())["response"].strip()


def component_scores(actual, expected):
    names = ("schema", "tool", "node", "input", "dependency", "exact")
    if not isinstance(actual, dict):
        return dict.fromkeys(names, 0)
    actual_steps = actual.get("steps") if isinstance(actual.get("steps"), list) else []
    # A malformed model output can put a non-dict element in steps[] (e.g. a bare
    # string) -- real production validation (planStepSchema) would reject that
    # outright, so treat it as an automatic step mismatch here instead of
    # crashing on .get() below.
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


def load_rows(path, limit):
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return rows[:limit] if limit else rows


def benchmark(model, rows, url, timeout, schema_format):
    totals = dict.fromkeys(("schema", "tool", "node", "input", "dependency", "exact"), 0)
    errors = 0
    for index, row in enumerate(rows, 1):
        try:
            actual = json.loads(query(url, model, row, timeout, schema_format))
        except Exception as error:
            errors += 1
            actual = None
            print(f"[{model} #{index}] ERROR: {error}")
        for name, value in component_scores(actual, json.loads(row["output"])).items():
            totals[name] += value

    count = len(rows)
    mode = "schema" if schema_format else "json"
    summary = " ".join(f"{name}={totals[name] / count:.1%}" for name in totals)
    print(f"{model} [format={mode}]: cases={count} errors={errors} {summary}")

    # Every benchmark run gets a permanent record -- not just terminal scrollback.
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "format_mode": mode,
        "cases": count,
        "errors": errors,
        **{name: totals[name] / count for name in totals},
    }
    QUALITY_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with QUALITY_HISTORY_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="*", default=["hiba-planner:v1"])
    parser.add_argument("--dataset", type=Path, default=Path("training/data/hiba-v1-eval.jsonl"))
    parser.add_argument("--url", default="http://127.0.0.1:11434/api/generate")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--schema-format", action="store_true",
        help="Constrain toolName to an enum via Ollama's JSON-Schema format instead of the bare 'json' mode",
    )
    args = parser.parse_args()
    rows = load_rows(args.dataset, args.limit)
    if not rows:
        raise SystemExit("evaluation dataset is empty")
    for model in args.models:
        benchmark(model, rows, args.url, args.timeout, args.schema_format)


if __name__ == "__main__":
    main()
