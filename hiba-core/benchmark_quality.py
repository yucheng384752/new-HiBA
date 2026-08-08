"""Evaluate HiBA Core Protocol v1 planning accuracy through Ollama."""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SYSTEM = """You are a HiBA workflow planner. Use only the supplied Core Protocol v1 nodes and tools. Return only one ExecutionPlan JSON object. Tool names, versions, node IDs, input fields, and dependencies must exactly match the supplied context."""


def query(url, model, row, timeout):
    prompt = f"Core Protocol v1 context:\n{row['input']}\n\nUser task:\n{row['instruction']}"
    body = json.dumps({
        "model": model,
        "system": SYSTEM,
        "prompt": prompt,
        "format": "json",
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
    expected_steps = expected["steps"]
    paired = list(zip(actual_steps, expected_steps))
    same_count = len(actual_steps) == len(expected_steps)
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


def benchmark(model, rows, url, timeout):
    totals = dict.fromkeys(("schema", "tool", "node", "input", "dependency", "exact"), 0)
    errors = 0
    for index, row in enumerate(rows, 1):
        try:
            actual = json.loads(query(url, model, row, timeout))
        except Exception as error:
            errors += 1
            actual = None
            print(f"[{model} #{index}] ERROR: {error}")
        for name, value in component_scores(actual, json.loads(row["output"])).items():
            totals[name] += value

    count = len(rows)
    summary = " ".join(f"{name}={totals[name] / count:.1%}" for name in totals)
    print(f"{model}: cases={count} errors={errors} {summary}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="*", default=["hiba-planner:v1"])
    parser.add_argument("--dataset", type=Path, default=Path("training/data/hiba-v1-eval.jsonl"))
    parser.add_argument("--url", default="http://127.0.0.1:11434/api/generate")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    rows = load_rows(args.dataset, args.limit)
    if not rows:
        raise SystemExit("evaluation dataset is empty")
    for model in args.models:
        benchmark(model, rows, args.url, args.timeout)


if __name__ == "__main__":
    main()
