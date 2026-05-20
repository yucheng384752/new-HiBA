"""
Patch 7 — Round 5 fixes:
1. Remove patch6 Q3 samples with exclusionary language:
     "不需搬運" / "不搬運不報告" / "全程三節點完成"
   Replace with positive ordered-step language.
2. Add 6 Q7 reinforcement samples (cut→QC→transfer, destination arg, NO CNC).
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).parent
sys.stdout.reconfigure(encoding="utf-8")

STD_INPUT = {
    "node-1": [{"name": "cut.sh",      "version": "1.2.0", "type": "script"}, {"name": "切割機",    "version": "2.0.0", "type": "tool"}],
    "node-2": [{"name": "cnc_job.sh",  "version": "1.0.3", "type": "script"}, {"name": "CNC-03",    "version": "3.1.0", "type": "tool"}],
    "node-3": [{"name": "qc_check.sh", "version": "1.1.0", "type": "script"}, {"name": "品質檢測儀","version": "1.0.0", "type": "tool"}],
    "node-4": [{"name": "report.sh",   "version": "2.3.0", "type": "script"}, {"name": "report-svc","version": "1.5.0", "type": "service"}],
    "node-5": [{"name": "transfer.sh", "version": "1.0.1", "type": "script"}, {"name": "搬運車",    "version": "1.0.0", "type": "tool"}],
}

# ── instructions to remove (patch6 exclusionary language) ────────────────────
REMOVE_INSTRUCTIONS = {
    "鋁合金薄板 切割後精密加工，品質檢測後輸出 JSON 紀錄，不需搬運",
    "鋼板 切割→CNC 精密加工→品質檢測，完成後直接輸出結果（不搬運不報告）",
    "半導體晶片：先切割再 CNC 加工再品質檢測，全程三節點完成",
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
    # ── Q3 replacements：正向有序語言，不使用排除性語句 ───────────────────────

    s("鋁合金薄板：第一步切割機切割，第二步 CNC-03 精密加工，第三步品質檢測儀 QC，產出 JSON", [
        step("node-1", "切割機",    "cut.sh",     material="鋁合金薄板", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",        output="精加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精加工件",      output="JSON"),
    ]),
    s("鋼板三段製程：第一步切割機切割 → 第二步 CNC-03 精密加工 → 第三步品質檢測儀 QC", [
        step("node-1", "切割機",    "cut.sh",     material="鋼板",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",   output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",   output="QC結果"),
    ]),
    s("半導體晶片依序執行：切割機切割 → CNC-03 精密加工 → 品質檢測儀品質檢測", [
        step("node-1", "切割機",    "cut.sh",     material="半導體晶片", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",        output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",        output="QC結果"),
    ]),

    # ── Q7 reinforcement：cut→QC→transfer，明確 destination，不含 CNC ─────────

    s("批次處理 50 件不鏽鋼板：切割後品質檢測，合格品搬到出貨倉", [
        step("node-1", "切割機",    "cut.sh",     material="不鏽鋼板", quantity=50),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",      pass_threshold=0.9),
        step("node-5", "搬運車",    "transfer.sh",destination="出貨倉"),
    ]),
    s("30 件鋁合金零件：切割完成後品質檢測，合格才搬運到 B 區暫存", [
        step("node-1", "切割機",    "cut.sh",     material="鋁合金",  quantity=30),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.9),
        step("node-5", "搬運車",    "transfer.sh",destination="B區暫存"),
    ]),
    s("銅片 100 件批次：切割機切割 → 品質檢測儀 QC，通過才由搬運車送往出貨區", [
        step("node-1", "切割機",    "cut.sh",     material="銅片",  quantity=100),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5", "搬運車",    "transfer.sh",destination="出貨區"),
    ]),
    s("鈦合金板切割後直接品質檢測，合格品目的地倉庫 C（跳過 CNC 加工）", [
        step("node-1", "切割機",    "cut.sh",     material="鈦合金板", output="切割件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",      pass_threshold=0.9),
        step("node-5", "搬運車",    "transfer.sh",destination="倉庫C"),
    ]),
    s("玻璃面板切割→QC 品質檢測，合格後搬往包裝區，此批不需要 CNC 加工", [
        step("node-1", "切割機",    "cut.sh",     material="玻璃面板", output="切割件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",      pass_threshold=0.95),
        step("node-5", "搬運車",    "transfer.sh",destination="包裝區"),
    ]),
    s("PCB 板 200 件批次處理：切割→品質檢測→搬運，不進行 CNC 精密加工", [
        step("node-1", "切割機",    "cut.sh",     material="PCB板",  quantity=200),
        step("node-3", "品質檢測儀","qc_check.sh",input="切割件",    pass_threshold=0.9),
        step("node-5", "搬運車",    "transfer.sh",destination="出貨站"),
    ]),
]


if __name__ == "__main__":
    out = ROOT / "dataset-train.jsonl"
    lines = out.read_text(encoding="utf-8").splitlines()

    kept, removed = [], 0
    for line in lines:
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get("instruction", "") in REMOVE_INSTRUCTIONS:
            removed += 1
        else:
            kept.append(line)

    existing_outputs = {json.loads(l)["output"] for l in kept}

    added = 0
    new_lines = list(kept)
    for sample in NEW_SAMPLES:
        if sample["output"] not in existing_outputs:
            new_lines.append(json.dumps(sample, ensure_ascii=False))
            existing_outputs.add(sample["output"])
            added += 1

    out.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    total = len(new_lines)
    print(f"Patch 7: removed {removed}, added {added} → total {total}")
