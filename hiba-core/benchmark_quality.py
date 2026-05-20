"""
Compare hiba-planner:latest (F16) vs hiba-planner:q4km (Q4_K_M).
Quality score = weighted average of:
  - valid JSON            (weight 2)
  - has 'steps' key       (weight 2)
  - has 'supervisorPolicy'(weight 1)
  - correct node selected (weight 3)
  - correct args present  (weight 2)
Prints per-prompt scores and final comparison.
"""
import json, sys, urllib.request, urllib.error
sys.stdout.reconfigure(encoding="utf-8")

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
SYSTEM = (
    "你是 HiBA 工作流程規劃師。"
    "根據節點資源清單，將使用者的繁體中文任務拆解成 ExecutionPlan JSON。"
    "只回傳純 JSON，不加任何說明。"
)

STD_INPUT = json.dumps({
    "node-1": [{"name": "cut.sh","version":"1.2.0","type":"script"},{"name":"切割機","version":"2.0.0","type":"tool"}],
    "node-2": [{"name": "cnc_job.sh","version":"1.0.3","type":"script"},{"name":"CNC-03","version":"3.1.0","type":"tool"}],
    "node-3": [{"name": "qc_check.sh","version":"1.1.0","type":"script"},{"name":"品質檢測儀","version":"1.0.0","type":"tool"}],
    "node-4": [{"name": "report.sh","version":"2.3.0","type":"script"},{"name":"report-svc","version":"1.5.0","type":"service"}],
    "node-5": [{"name": "transfer.sh","version":"1.0.1","type":"script"},{"name":"搬運車","version":"1.0.0","type":"tool"}],
}, ensure_ascii=False)

# (instruction, expected_nodes, must_have_args)
BENCHMARKS = [
    ("把 鋁合金板 從 倉庫A 切割後送到 QC 暫存區",
     ["node-1","node-5"], ["material","destination"]),
    ("不鏽鋼管 切割後進行品質檢測，不合格送 manual-review",
     ["node-1","node-3"], ["material"]),
    ("矽晶圓 切割後 CNC 精密加工，再做品質檢測，產出 JSON",
     ["node-1","node-2","node-3"], ["material","output"]),
    ("對 QC 暫存區的 PCB板 品質檢測後合格品搬到 出貨區",
     ["node-3","node-5"], ["destination"]),
    ("鈦合金零件 緊急訂單：跳過品質檢測直接 CNC 加工後搬到 出貨區",
     ["node-2","node-5"], ["destination"]),
    ("請產生 node-1 到 node-3 今日作業 PDF 日報",
     ["node-4"], ["output"]),
    ("批次處理 80 件 PCB板：切割→品質檢測，合格才搬到 出貨區",
     ["node-1","node-3","node-5"], ["destination"]),
    ("對 矽晶圓 單獨執行 CNC 精密加工，不需要切割或 QC",
     ["node-2"], ["material"]),
]

def query(model, prompt, timeout=90):
    body = json.dumps({
        "model": model,
        "system": SYSTEM,
        "prompt": f"節點資源：{STD_INPUT}\n任務：{prompt}",
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())["response"].strip()
    except Exception as e:
        return f"ERROR:{e}"

def score_response(raw, expected_nodes, must_args):
    s = 0
    # valid JSON (2)
    try:
        d = json.loads(raw)
        s += 2
    except Exception:
        return s, raw[:60]
    # has steps (2)
    if isinstance(d.get("steps"), list) and len(d["steps"]) > 0:
        s += 2
    # has supervisorPolicy (1)
    if "supervisorPolicy" in d:
        s += 1
    # correct nodes (3)
    actual_nodes = {step.get("nodeId") for step in d.get("steps", [])}
    if set(expected_nodes) == actual_nodes or set(expected_nodes).issubset(actual_nodes):
        s += 3
    elif len(set(expected_nodes) & actual_nodes) > 0:
        s += 1
    # required args (2)
    all_args = {}
    for step in d.get("steps", []):
        all_args.update(step.get("args", {}))
    if all(a in all_args for a in must_args):
        s += 2
    elif any(a in all_args for a in must_args):
        s += 1
    return s, json.dumps(d, ensure_ascii=False)[:80]

MAX_SCORE = 10

def run_benchmark(model):
    total = 0
    results = []
    print(f"\n{'='*60}")
    print(f"Model: {model}")
    print(f"{'='*60}")
    for i, (instr, nodes, args) in enumerate(BENCHMARKS, 1):
        raw = query(model, instr)
        sc, preview = score_response(raw, nodes, args)
        total += sc
        results.append(sc)
        print(f"[{i}] score={sc}/{MAX_SCORE}  {instr[:40]}")
        print(f"     → {preview}")
    pct = total / (MAX_SCORE * len(BENCHMARKS)) * 100
    print(f"\nTotal: {total}/{MAX_SCORE*len(BENCHMARKS)}  ({pct:.1f}%)")
    return pct, results

if __name__ == "__main__":
    f16_pct, f16_scores = run_benchmark("hiba-planner:latest")
    q4_pct, q4_scores  = run_benchmark("hiba-planner:q4km")

    diff = f16_pct - q4_pct
    print(f"\n{'='*60}")
    print(f"F16  quality: {f16_pct:.1f}%")
    print(f"Q4KM quality: {q4_pct:.1f}%")
    print(f"Difference:   {diff:.1f}%")
    if abs(diff) < 5:
        print("✓ 差距 < 5% → 建議使用 Q4_K_M（節省 ~11GB）")
    else:
        print("✗ 差距 ≥ 5% → 維持 F16")
