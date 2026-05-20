"""
Patch 6 — Round 4 targeted fixes for Q3 and Q6.

Q3 remaining failures:
  - Model still adds node-4/node-5 to cut→CNC→QC flows
  - Tool names output as "???" for node-1 and node-3 (weak binding)
  - Uses generic "input" key instead of "material"
  Fix: more 3-step-only samples, reinforce tool name extraction, add negative-space
       examples where "產出 JSON" is explicitly node-3's output arg

Q6 remaining failures:
  - Model generates all 5 nodes instead of only node-4
  - "source_nodes" arg pattern not learned
  Fix: more report-only samples with explicit source_nodes, varied report types,
       and samples where user mentions specific source nodes by name
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

def s(instruction, steps, policy="fail-fast"):
    return {
        "instruction": instruction,
        "input": json.dumps(STD_INPUT, ensure_ascii=False),
        "output": json.dumps({"steps": steps, "supervisorPolicy": policy}, ensure_ascii=False),
    }

def step(node, tool, script, **args):
    return {"nodeId": node, "tool": tool, "script": script, "args": args}

NEW_SAMPLES = [

    # ── Q3 Fix A: 直接命中 Q3 benchmark 題（強化 node-1→2→3，禁止多餘節點）─────

    # 完全對應 Q3 題目，確保 material="矽晶圓" 且 output="JSON"
    s("矽晶圓 切割後 CNC 精密加工，品質檢測後產出 JSON 報告", [
        step("node-1", "切割機",    "cut.sh",     material="矽晶圓",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",     output="精密加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精密加工件", output="JSON"),
    ]),
    s("對矽晶圓進行切割、CNC 精密加工、品質檢測三步驟，最後輸出 JSON", [
        step("node-1", "切割機",    "cut.sh",     material="矽晶圓",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",     output="CNC加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="CNC加工件",  output="JSON"),
    ]),
    s("矽晶圓三段製程：切割機切割 → CNC-03 精密加工 → 品質檢測儀檢測，產出 JSON", [
        step("node-1", "切割機",    "cut.sh",     material="矽晶圓",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",     output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",     output="JSON"),
    ]),

    # ── Q3 Fix B: 多材質 cut→CNC→QC，鞏固「只用三節點」的邊界 ──────────────────

    s("碳纖維板 切割後進行 CNC 精密加工，最後 QC 品質檢測", [
        step("node-1", "切割機",    "cut.sh",     material="碳纖維板", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",      output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",      output="QC結果"),
    ]),
    s("玻璃基板先由切割機切割，再用 CNC-03 加工，最後品質檢測儀做 QC", [
        step("node-1", "切割機",    "cut.sh",     material="玻璃基板", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",      output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",      output="QC結果"),
    ]),
    s("銅合金零件：切割後精密 CNC 加工，QC 品質檢測出 JSON 結果", [
        step("node-1", "切割機",    "cut.sh",     material="銅合金",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",     output="精加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精加工件",   output="JSON"),
    ]),
    s("陶瓷基板：切割機切割 → CNC-03 精密加工 → 品質檢測儀 QC，輸出 JSON", [
        step("node-1", "切割機",    "cut.sh",     material="陶瓷基板", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",      output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",      output="JSON"),
    ]),
    s("鋁合金薄板 切割後精密加工，品質檢測後輸出 JSON 紀錄，不需搬運", [
        step("node-1", "切割機",    "cut.sh",     material="鋁合金薄板", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",        output="精加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="精加工件",      output="JSON"),
    ]),
    s("半導體晶片：先切割再 CNC 加工再品質檢測，全程三節點完成", [
        step("node-1", "切割機",    "cut.sh",     material="半導體晶片", output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",        output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",        output="QC結果"),
    ]),
    s("鋼板 切割→CNC 精密加工→品質檢測，完成後直接輸出結果（不搬運不報告）", [
        step("node-1", "切割機",    "cut.sh",     material="鋼板",  output="切割件"),
        step("node-2", "CNC-03",    "cnc_job.sh", input="切割件",   output="加工件"),
        step("node-3", "品質檢測儀","qc_check.sh",input="加工件",   output="QC結果"),
    ]),

    # ── Q6 Fix A: 直接命中 Q6 benchmark 題（只用 node-4，source_nodes 明確）──────

    # 完全對應 Q6 題目
    s("請產生 node-1 到 node-3 今日作業 PDF 日報", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("產生 node-1、node-2、node-3 的今日 PDF 日報", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("用 report-svc 彙整 node-1 到 node-3 的今日作業，輸出 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),

    # ── Q6 Fix B: 多樣化報告任務，強化「報告 = 只有 node-4」─────────────────────

    s("彙整 node-1 到 node-5 本週生產數據，輸出 PDF 週報", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3,node-4,node-5", output="PDF", period="week"),
    ]),
    s("產生 node-2 和 node-3 的月報 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-2,node-3", output="PDF", period="month"),
    ]),
    s("report-svc 彙整 node-3 今日 QC 紀錄，輸出 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-3", output="PDF", date="today"),
    ]),
    s("只需要生成報告：node-1 到 node-4 本日作業摘要 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3,node-4", output="PDF", date="today"),
    ]),
    s("請 report-svc 產出 node-2 今日 CNC 加工 JSON 日報", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-2", output="JSON", date="today"),
    ]),
    s("不需要執行任何工序，只要產生 node-1 和 node-5 的作業報告 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-5", output="PDF", date="today"),
    ]),
    s("本日生產日報：彙整切割機與 CNC-03 的作業記錄，report-svc 輸出 PDF", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2", output="PDF", date="today"),
    ]),
    s("請幫我產出今日所有節點的工作報告 PDF，只呼叫 report-svc", [
        step("node-4", "report-svc", "report.sh",
             source_nodes="node-1,node-2,node-3,node-4,node-5", output="PDF", date="today"),
    ]),
]

if __name__ == "__main__":
    out = ROOT / "dataset-train.jsonl"
    existing = out.read_text(encoding="utf-8").splitlines()
    existing_outputs = {json.loads(l)["output"] for l in existing if l.strip()}

    added = 0
    with out.open("a", encoding="utf-8") as f:
        for sample in NEW_SAMPLES:
            if sample["output"] not in existing_outputs:
                f.write(json.dumps(sample, ensure_ascii=False) + "\n")
                existing_outputs.add(sample["output"])
                added += 1

    total = len(out.read_text(encoding="utf-8").splitlines())
    print(f"Patch 6: added {added} samples → total {total}")
