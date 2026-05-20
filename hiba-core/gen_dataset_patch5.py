"""
Patch 5 — targeted fixes for Q3 and Q6 regression.

Q3 root cause:
  - Model binds "矽晶圓" → CNC-only (from Q8 training data)
  - Model treats "產出 JSON" as a report step (node-4) instead of node-3 output arg
  Fix: add diverse 切割→CNC→QC samples with various materials and explicit JSON/output from node-3

Q6 root cause:
  - Model interprets "node-1 到 node-3 日報" as executing those nodes, not reporting on them
  Fix: add more report-only samples with varied phrasings, strictly using node-4
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).parent
sys.stdout.reconfigure(encoding="utf-8")

STD_INPUT = {
    "node-1": [{"name": "cut.sh", "version": "1.2.0", "type": "script"}, {"name": "切割機", "version": "2.0.0", "type": "tool"}],
    "node-2": [{"name": "cnc_job.sh", "version": "1.0.3", "type": "script"}, {"name": "CNC-03", "version": "3.1.0", "type": "tool"}],
    "node-3": [{"name": "qc_check.sh", "version": "1.1.0", "type": "script"}, {"name": "品質檢測儀", "version": "1.0.0", "type": "tool"}],
    "node-4": [{"name": "report.sh", "version": "2.3.0", "type": "script"}, {"name": "report-svc", "version": "1.5.0", "type": "service"}],
    "node-5": [{"name": "transfer.sh", "version": "1.0.1", "type": "script"}, {"name": "搬運車", "version": "1.0.0", "type": "tool"}],
}

def s(instruction, steps, policy="fail-fast"):
    return {
        "instruction": instruction,
        "input": json.dumps(STD_INPUT, ensure_ascii=False),
        "output": json.dumps({"steps": steps, "supervisorPolicy": policy}, ensure_ascii=False),
    }

def step(node, tool, script, **args):
    return {"nodeId": node, "tool": tool, "script": script, "args": args}

NEW_SAMPLES = [
    # ── Q3 Fix: 切割→CNC→QC，強調「切割後」= node-1 先行 ──────────────────
    # 矽晶圓（直接對應 Q3，最強訊號）
    s("矽晶圓 切割後 CNC 精密加工，再做品質檢測，產出 JSON",  [
        step("node-1", "切割機",   "cut.sh",     material="矽晶圓",   output="切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="切割件",      output="CNC加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="CNC加工件",   output="JSON"),
    ]),
    s("矽晶圓先切割，接著做 CNC 精密加工，最後品質檢測輸出 JSON 結果",  [
        step("node-1", "切割機",   "cut.sh",     material="矽晶圓",   output="矽晶圓切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="矽晶圓切割件",output="精密加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精密加工件",  output="JSON"),
    ]),
    s("對矽晶圓執行：切割 → CNC加工 → QC 檢測，最終輸出 JSON 報告",  [
        step("node-1", "切割機",   "cut.sh",     material="矽晶圓",   output="切割片"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="切割片",      output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",      output="JSON"),
    ]),
    # 其他材料，「切割後 CNC」→ node-1 必須先行
    s("碳纖維板 切割後進行 CNC 精密加工，再 QC 檢測，輸出 JSON", [
        step("node-1", "切割機",   "cut.sh",     material="碳纖維板", output="切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="切割件",      output="CNC件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="CNC件",       output="JSON"),
    ]),
    s("鋁合金板 切割後做 CNC 加工，品質檢測通過後輸出 JSON 結果", [
        step("node-1", "切割機",   "cut.sh",     material="鋁合金板", output="切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="切割件",      output="CNC件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="CNC件",       output="JSON"),
    ]),
    s("玻璃基板 切割 → CNC 精加工 → QC，產出 JSON 品質報告", [
        step("node-1", "切割機",   "cut.sh",     material="玻璃基板", output="切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="切割件",      output="精加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精加工件",    output="JSON"),
    ]),
    s("鈦合金板 切割後 CNC 精密加工，品質檢測結果以 JSON 格式輸出", [
        step("node-1", "切割機",   "cut.sh",     material="鈦合金板", output="鈦合金切割件"),
        step("node-2", "CNC-03",   "cnc_job.sh", input="鈦合金切割件",output="CNC件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="CNC件",       output="JSON"),
    ]),

    # ── Q6 Fix: 報告任務嚴格只用 node-4，強調「日報/報告 = report-svc」────
    # 直接對應 Q6 的各種說法
    s("請產生 node-1 到 node-3 今日作業 PDF 日報", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("產生 node-1、node-2、node-3 的今日作業日報，格式為 PDF", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF"),
    ]),
    s("彙整 node-1 到 node-3 今天的作業記錄，輸出 PDF 日報", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF"),
    ]),
    s("請用 report-svc 產生 node-1 到 node-3 的今日 PDF 日報", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF"),
    ]),
    s("node-1、node-2、node-3 今日作業統計，請輸出 PDF", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF"),
    ]),
    # 其他報告場景，強化「日報 = node-4 only」
    s("產生 node-2 CNC 加工站今日作業日報，格式 PDF", [
        step("node-4", "report-svc","report.sh", source="node-2", output="PDF"),
    ]),
    s("請匯出 node-3 品質檢測站今日日報（PDF）", [
        step("node-4", "report-svc","report.sh", source="node-3", output="PDF"),
    ]),
    s("彙整 node-1 切割站本週作業，輸出 PDF 週報", [
        step("node-4", "report-svc","report.sh", source="node-1", output="PDF", period="week"),
    ]),
    s("node-1 到 node-5 全站今日作業日報，PDF 格式", [
        step("node-4", "report-svc","report.sh",
             source_nodes="node-1,node-2,node-3,node-4,node-5", output="PDF"),
    ]),
]

print(f"New samples to add: {len(NEW_SAMPLES)}")
print(f"  Q3 fixes: 7 samples")
print(f"  Q6 fixes: 9 samples")

golden_path = ROOT / "dataset-golden.jsonl"
with open(golden_path, "a", encoding="utf-8") as f:
    for sample in NEW_SAMPLES:
        f.write(json.dumps(sample, ensure_ascii=False) + "\n")
print(f"Appended {len(NEW_SAMPLES)} samples to {golden_path.name}")

sources = [
    "dataset-golden.jsonl",
    "dataset-generated.jsonl",
    "dataset-manual1.jsonl",
    "dataset-patch-clean.jsonl",
]
all_samples = []
for src in sources:
    p = ROOT / src
    if p.exists():
        with open(p, encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        all_samples.extend(lines)
        print(f"  {src}: {len(lines)} lines")

seen, unique = set(), []
for line in all_samples:
    try:
        key = json.loads(line).get("instruction", line)
        if key not in seen:
            seen.add(key)
            unique.append(line)
    except json.JSONDecodeError:
        pass

train_path = ROOT / "dataset-train.jsonl"
with open(train_path, "w", encoding="utf-8") as f:
    for line in unique:
        f.write(line + "\n")

print(f"\ndataset-train.jsonl rebuilt: {len(unique)} unique samples")
