"""Diagnose Q3 and Q6 failure modes by printing full model output."""
import json, urllib.request, sys
sys.stdout.reconfigure(encoding="utf-8")

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
SYSTEM = (
    "你是 HiBA 工作流程規劃師。"
    "根據節點資源清單，將使用者的繁體中文任務拆解成 ExecutionPlan JSON。"
    "只回傳純 JSON，不加任何說明。"
)
STD_INPUT = json.dumps({
    "node-1": [{"name": "cut.sh", "version": "1.2.0", "type": "script"}, {"name": "切割機", "version": "2.0.0", "type": "tool"}],
    "node-2": [{"name": "cnc_job.sh", "version": "1.0.3", "type": "script"}, {"name": "CNC-03", "version": "3.1.0", "type": "tool"}],
    "node-3": [{"name": "qc_check.sh", "version": "1.1.0", "type": "script"}, {"name": "品質檢測儀", "version": "1.0.0", "type": "tool"}],
    "node-4": [{"name": "report.sh", "version": "2.3.0", "type": "script"}, {"name": "report-svc", "version": "1.5.0", "type": "service"}],
    "node-5": [{"name": "transfer.sh", "version": "1.0.1", "type": "script"}, {"name": "搬運車", "version": "1.0.0", "type": "tool"}],
}, ensure_ascii=False)

CASES = [
    ("Q3", "矽晶圓 切割後 CNC 精密加工，再做品質檢測，產出 JSON", ["node-1", "node-2", "node-3"], ["material", "output"]),
    ("Q4", "對 QC 暫存區的 PCB板 品質檢測後合格品搬到 出貨區",    ["node-3", "node-5"],           ["destination"]),
    ("Q6", "請產生 node-1 到 node-3 今日作業 PDF 日報",          ["node-4"],                     ["output"]),
    ("Q7", "批次處理 80 件 PCB板：切割→品質檢測，合格才搬到 出貨區", ["node-1", "node-3", "node-5"], ["destination"]),
]

def query(model, prompt, timeout=90):
    body = json.dumps({
        "model": model, "system": SYSTEM,
        "prompt": f"節點資源：{STD_INPUT}\n任務：{prompt}",
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["response"].strip()

for model in ["hiba-planner:latest"]:
    print(f"\n{'='*60}\nModel: {model}\n{'='*60}")
    for tag, prompt, exp_nodes, exp_args in CASES:
        print(f"\n--- {tag}: {prompt} ---")
        print(f"    Expected nodes: {exp_nodes}")
        raw = query(model, prompt)
        try:
            d = json.loads(raw)
            actual_nodes = [s.get("nodeId") for s in d.get("steps", [])]
            print(f"    Actual  nodes: {actual_nodes}")
            for step in d.get("steps", []):
                print(f"      [{step.get('nodeId')}] tool={step.get('tool')}  args={list(step.get('args', {}).keys())}")
            print(f"    supervisorPolicy: {d.get('supervisorPolicy', '(missing)')}")
            all_args = {}
            for step in d.get("steps", []): all_args.update(step.get("args", {}))
            missing_args = [a for a in exp_args if a not in all_args]
            print(f"    Missing required args: {missing_args if missing_args else 'none'}")
        except Exception as e:
            print(f"    JSON parse error: {e}")
            print(f"    Raw: {raw[:300]}")
