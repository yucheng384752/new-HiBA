"""
Generate 20 new golden samples covering under-represented scenarios.
Appends to dataset-golden.jsonl and rebuilds dataset-train.jsonl.
"""
import json, sys, pathlib

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
    # ── 直接對應 smoke-test 查詢 ──────────────────────────────────
    s("把 鋁合金板 從 倉庫A 切割後送到 QC 暫存區", [
        step("node-1", "切割機", "cut.sh", material="鋁合金板", source="倉庫A", output="切割完成品"),
        step("node-5", "搬運車", "transfer.sh", input="切割完成品", destination="QC暫存區"),
    ]),
    s("鋁合金板 從 倉庫A 取出，先切割再移送 QC 暫存區", [
        step("node-1", "切割機", "cut.sh", material="鋁合金板", source="倉庫A", output="切割件"),
        step("node-5", "搬運車", "transfer.sh", input="切割件", destination="QC暫存區"),
    ]),
    s("從 倉庫A 拿 鋁合金板 去切割，切完放到 QC 暫存區", [
        step("node-1", "切割機", "cut.sh", material="鋁合金板", source="倉庫A", output="鋁合金切割件"),
        step("node-5", "搬運車", "transfer.sh", input="鋁合金切割件", destination="QC暫存區"),
    ]),

    # ── 切割 → QC 檢測 ────────────────────────────────────────────
    s("把 碳纖維片 從 倉庫B 切割後，立即做品質檢測，合格品輸出 JSON", [
        step("node-1", "切割機", "cut.sh", material="碳纖維片", source="倉庫B", output="碳纖維切割件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="碳纖維切割件", output="JSON", threshold="0.9"),
    ]),
    s("不鏽鋼管 切割完成後進行品質檢測，不合格送 manual-review", [
        step("node-1", "切割機", "cut.sh", material="不鏽鋼管", output="切割件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="切割件", fail_action="manual-review"),
    ]),

    # ── 切割 → CNC → QC ──────────────────────────────────────────
    s("矽晶圓 切割後進行 CNC 精密加工，再做品質檢測，產出 JSON 報告", [
        step("node-1", "切割機", "cut.sh", material="矽晶圓", output="矽晶圓切割件"),
        step("node-2", "CNC-03", "cnc_job.sh", input="矽晶圓切割件", output="CNC加工件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="CNC加工件", output="JSON"),
    ]),
    s("請對 鈦合金零件 執行切割、CNC 精加工、品質檢測三步流程", [
        step("node-1", "切割機", "cut.sh", material="鈦合金零件", output="鈦合金切割件"),
        step("node-2", "CNC-03", "cnc_job.sh", input="鈦合金切割件", output="CNC件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="CNC件", output="檢測報告"),
    ]),

    # ── QC → 搬運 ────────────────────────────────────────────────
    s("對 QC 暫存區 的 PCB板 做品質檢測後，合格品搬運到 出貨區", [
        step("node-3", "品質檢測儀", "qc_check.sh", input="PCB板", source="QC暫存區", output="合格品清單"),
        step("node-5", "搬運車", "transfer.sh", input="合格品清單", destination="出貨區"),
    ]),
    s("從 QC 暫存區 取出 橡膠墊片，品質抽樣通過後搬到 倉庫B", [
        step("node-3", "品質檢測儀", "qc_check.sh", input="橡膠墊片", source="QC暫存區", sample_rate="0.1"),
        step("node-5", "搬運車", "transfer.sh", input="橡膠墊片", destination="倉庫B"),
    ]),

    # ── 搬運 only ────────────────────────────────────────────────
    s("把 鋁合金板 從 倉庫A 直接搬到 出貨區，不做任何加工", [
        step("node-5", "搬運車", "transfer.sh", material="鋁合金板", source="倉庫A", destination="出貨區"),
    ]),
    s("將 玻璃基板 從 冷藏區 搬到 QC 暫存區，每批限重 3kg", [
        step("node-5", "搬運車", "transfer.sh", material="玻璃基板", source="冷藏區", destination="QC暫存區", batch_weight_kg=3),
    ]),

    # ── 報告 only ────────────────────────────────────────────────
    s("請產生 node-1 到 node-3 今日作業的 PDF 日報，送到 report-service", [
        step("node-4", "report-svc", "report.sh", source_nodes=["node-1","node-2","node-3"], output="PDF", destination="report-service"),
    ]),
    s("彙整 node-2 CNC 加工數據，輸出 XLSX 給 dashboard", [
        step("node-4", "report-svc", "report.sh", source="node-2", output="XLSX", destination="dashboard"),
    ]),

    # ── 完整五步流程 ──────────────────────────────────────────────
    s("請對 ABS外殼 執行完整產線：切割 → CNC → 品質檢測 → 出報告 → 搬到出貨區", [
        step("node-1", "切割機", "cut.sh", material="ABS外殼", output="切割件"),
        step("node-2", "CNC-03", "cnc_job.sh", input="切割件", output="CNC件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="CNC件", output="檢測結果"),
        step("node-4", "report-svc", "report.sh", input="檢測結果", output="PDF"),
        step("node-5", "搬運車", "transfer.sh", input="CNC件", destination="出貨區"),
    ]),
    s("壓克力面板 完整產線：切割、CNC精加工、QC檢測、報告、搬出貨", [
        step("node-1", "切割機", "cut.sh", material="壓克力面板", output="切割完成"),
        step("node-2", "CNC-03", "cnc_job.sh", input="切割完成", output="精加工完成"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="精加工完成", output="QC結果"),
        step("node-4", "report-svc", "report.sh", input="QC結果", output="PDF報告"),
        step("node-5", "搬運車", "transfer.sh", input="精加工完成", destination="出貨區"),
    ]),

    # ── 緊急/例外流程 ────────────────────────────────────────────
    s("鈦合金零件 緊急訂單：跳過品質檢測直接 CNC 加工後搬到 出貨區", [
        step("node-2", "CNC-03", "cnc_job.sh", material="鈦合金零件", priority="urgent", output="加工件"),
        step("node-5", "搬運車", "transfer.sh", input="加工件", destination="出貨區"),
    ]),
    s("壓克力面板 CNC 後發現尺寸異常，重新排入 CNC 修正，再做 QC", [
        step("node-2", "CNC-03", "cnc_job.sh", material="壓克力面板", reason="尺寸修正", output="修正件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="修正件", output="QC結果"),
    ]),

    # ── 批次/分批 ────────────────────────────────────────────────
    s("批次處理 80 件 PCB板：切割 → 品質檢測，合格才搬到 出貨區", [
        step("node-1", "切割機", "cut.sh", material="PCB板", quantity=80, output="切割批次件"),
        step("node-3", "品質檢測儀", "qc_check.sh", input="切割批次件", output="合格品"),
        step("node-5", "搬運車", "transfer.sh", input="合格品", destination="出貨區"),
    ]),
    s("銅線 100 件品質抽樣 5%，產生 CSV 抽樣報告", [
        step("node-3", "品質檢測儀", "qc_check.sh", material="銅線", quantity=100, sample_rate="0.05", output="抽樣結果"),
        step("node-4", "report-svc", "report.sh", input="抽樣結果", output="CSV"),
    ]),

    # ── CNC only ─────────────────────────────────────────────────
    s("對 矽晶圓 單獨執行 CNC 精密加工，不需要切割或 QC", [
        step("node-2", "CNC-03", "cnc_job.sh", material="矽晶圓", output="精密加工件"),
    ]),
]

print(f"New samples to add: {len(NEW_SAMPLES)}")

# Append to golden
golden_path = ROOT / "dataset-golden.jsonl"
with open(golden_path, "a", encoding="utf-8") as f:
    for s in NEW_SAMPLES:
        f.write(json.dumps(s, ensure_ascii=False) + "\n")
print(f"Appended {len(NEW_SAMPLES)} samples to {golden_path}")

# Rebuild dataset-train.jsonl from all source files
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

# Deduplicate by instruction
seen = set()
unique = []
for line in all_samples:
    try:
        d = json.loads(line)
        key = d.get("instruction", line)
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
