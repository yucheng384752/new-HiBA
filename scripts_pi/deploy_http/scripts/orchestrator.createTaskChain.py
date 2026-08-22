#!/usr/bin/env python3
"""Create an LLM workflow on selected nodes and optionally approve/run it."""

import json
import os
import sys
import time
import urllib.error
import urllib.request


PLANNING_URL = os.environ.get("PLANNING_URL", "http://192.168.200.87:8090").rstrip("/")
TERMINAL = {"succeeded", "failed", "partial_success", "interrupted"}


def request(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{PLANNING_URL}{path}", data=data, method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"{method} {path} returned HTTP {error.code}: {detail[:500]}") from error


def main():
    params = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    task = params.get("task", "").strip()
    node_ids = params.get("nodeIds", [])
    auto_run = params.get("autoRun", False)
    approved_by = params.get("approvedBy", "claw-dashboard")

    if not task:
        raise ValueError("task is required")
    if not isinstance(node_ids, list) or len(set(node_ids)) < 2 or not all(isinstance(x, str) and x for x in node_ids):
        raise ValueError("nodeIds must contain at least two distinct node IDs")
    if not isinstance(auto_run, bool):
        raise ValueError("autoRun must be boolean")

    instruction = (
        f"{task}\nMandatory: create exactly {len(node_ids)} steps and use every one of "
        f"these node IDs exactly once: {', '.join(node_ids)}. Do not add extra steps."
    )
    plan = request("POST", "/api/plan", {"task": instruction})
    if plan.get("error"):
        raise RuntimeError(plan["error"])
    steps = plan.get("steps", [])
    if len(steps) != len(node_ids):
        raise RuntimeError(f"LLM generated {len(steps)} steps; exactly {len(node_ids)} are required")

    # Selected nodes are authoritative; the LLM chooses tools/dependencies.
    for index, step in enumerate(steps):
        step["nodeId"] = node_ids[index % len(node_ids)]
        if isinstance(step.get("input"), dict):
            step["input"].pop("dependsOn", None)
        if index and not step.get("dependsOn"):
            step["dependsOn"] = [steps[index - 1]["stepId"]]

    workflow_id = plan.get("workflowId")
    result = {
        "success": True,
        "workflowId": workflow_id,
        "status": plan.get("status", "planned"),
        "plan": {key: plan[key] for key in ("protocolVersion", "steps", "supervisorPolicy") if key in plan},
        "selectedNodeIds": node_ids,
        "llmGenerated": True,
    }
    if not auto_run:
        print(json.dumps(result, ensure_ascii=False))
        return
    if not workflow_id:
        raise RuntimeError("planning server did not return workflowId")

    headers = {"X-User-Id": approved_by, "X-Agent-Id": approved_by}
    result["approval"] = request(
        "POST", f"/api/workflows/{workflow_id}/approve", {"plan": result["plan"]}, headers,
    )
    request("POST", f"/api/workflows/{workflow_id}/run", {}, headers)
    for _ in range(60):
        workflow = request("GET", f"/api/workflows/{workflow_id}")
        if workflow.get("status") in TERMINAL:
            result["status"] = workflow["status"]
            result["execution"] = workflow.get("result")
            result["success"] = workflow["status"] == "succeeded"
            print(json.dumps(result, ensure_ascii=False))
            return
        time.sleep(1)
    raise TimeoutError(f"workflow {workflow_id} did not finish within 60 seconds")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
