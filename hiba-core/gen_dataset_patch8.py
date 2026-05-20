"""
Patch 8 — Rank-32 retraining preparation:
1. +40 cut→QC→transfer samples (no CNC) → balance Q7 pattern to ~76:121 ratio
2. +8  Q3 explicit-order samples (step1/step2/step3 language)
3. +8  Q6 report-only with strong "node-4 only" signal
Goal: push dataset to ~314 samples for rank=32 retraining targeting 95%+
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

    # ══════════════════════════════════════════════════════════════════════════
    # Q7 BALANCE — cut → QC → transfer（完全無 CNC），40 筆
    # 目標：讓模型學會在「切割後直接品檢再搬運」情境下跳過 node-2
    # ══════════════════════════════════════════════════════════════════════════

    s("鐵板 60 片切割後品質檢測，合格搬到成品倉", [
        step("node-1","切割機",    "cut.sh",     material="鐵板",   quantity=60),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",    pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="成品倉"),
    ]),
    s("矽晶圓切割後直接品質檢測，通過才搬到出貨區", [
        step("node-1","切割機",    "cut.sh",     material="矽晶圓", output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",    pass_threshold=0.97),
        step("node-5","搬運車",    "transfer.sh",destination="出貨區"),
    ]),
    s("不鏽鋼片 40 片：切割機切割→品質檢測儀 QC→搬運車送出貨站", [
        step("node-1","切割機",    "cut.sh",     material="不鏽鋼片",quantity=40),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="出貨站"),
    ]),
    s("鋁合金板批次切割後品檢，合格品目的地為 B 倉庫", [
        step("node-1","切割機",    "cut.sh",     material="鋁合金板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="B倉庫"),
    ]),
    s("銅片 120 片切割後品質檢測，通過率 92% 才允許搬到出口", [
        step("node-1","切割機",    "cut.sh",     material="銅片",  quantity=120),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.92),
        step("node-5","搬運車",    "transfer.sh",destination="出口"),
    ]),
    s("碳纖維板切割完成後做 QC，合格才搬到組裝線", [
        step("node-1","切割機",    "cut.sh",     material="碳纖維板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.96),
        step("node-5","搬運車",    "transfer.sh",destination="組裝線"),
    ]),
    s("鈦合金零件 25 個：切割後品質檢測（門檻 98%），合格送到精加工暫存", [
        step("node-1","切割機",    "cut.sh",     material="鈦合金",quantity=25),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.98),
        step("node-5","搬運車",    "transfer.sh",destination="精加工暫存"),
    ]),
    s("陶瓷基板切割後品質抽查，通過搬到包裝站", [
        step("node-1","切割機",    "cut.sh",     material="陶瓷基板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.94),
        step("node-5","搬運車",    "transfer.sh",destination="包裝站"),
    ]),
    s("塑膠板 200 片批次：切割→QC 品質檢測→搬到倉庫C（全程無需 CNC 加工）", [
        step("node-1","切割機",    "cut.sh",     material="塑膠板",quantity=200),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.90),
        step("node-5","搬運車",    "transfer.sh",destination="倉庫C"),
    ]),
    s("玻璃面板切割後只需品質檢測與搬運，不做精密加工", [
        step("node-1","切割機",    "cut.sh",     material="玻璃面板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出貨區"),
    ]),
    s("PCB 板 80 片：切割機→品質檢測儀→搬運車，目的地出貨站", [
        step("node-1","切割機",    "cut.sh",     material="PCB板", quantity=80),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出貨站"),
    ]),
    s("鋼板切割完成→品質管制通過→搬到成品區，此批跳過 CNC 精密加工", [
        step("node-1","切割機",    "cut.sh",     material="鋼板",  output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="成品區"),
    ]),
    s("半導體切割料件品質檢測後直接搬往 QC 核准區，不做二次加工", [
        step("node-1","切割機",    "cut.sh",     material="半導體料件",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",       pass_threshold=0.97),
        step("node-5","搬運車",    "transfer.sh",destination="QC核准區"),
    ]),
    s("50 件鋁板：切割機切割 → 品質檢測儀 QC（pass 95%）→ 搬運車至出貨區", [
        step("node-1","切割機",    "cut.sh",     material="鋁板",  quantity=50),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出貨區"),
    ]),
    s("不鏽鋼管 30 根切割後送品質檢測，合格送到 A 出口倉", [
        step("node-1","切割機",    "cut.sh",     material="不鏽鋼管",quantity=30),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="A出口倉"),
    ]),
    s("銅板批次切割後 QC，合格品搬至電鍍站", [
        step("node-1","切割機",    "cut.sh",     material="銅板",  output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.94),
        step("node-5","搬運車",    "transfer.sh",destination="電鍍站"),
    ]),
    s("鋁擠型材 70 支切割→品質檢測，通過搬到倉庫 D", [
        step("node-1","切割機",    "cut.sh",     material="鋁擠型材",quantity=70),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="倉庫D"),
    ]),
    s("矽鋼片切割完後立即品質管制，合格品目的地為捲繞站", [
        step("node-1","切割機",    "cut.sh",     material="矽鋼片",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.96),
        step("node-5","搬運車",    "transfer.sh",destination="捲繞站"),
    ]),
    s("100 件鋁蓋板：切割後只做 QC 再搬出，不需要 CNC 工序", [
        step("node-1","切割機",    "cut.sh",     material="鋁蓋板",quantity=100),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出貨區"),
    ]),
    s("鐵皮 150 張切割後品質抽查，抽查通過才搬到焊接站", [
        step("node-1","切割機",    "cut.sh",     material="鐵皮",  quantity=150),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.92),
        step("node-5","搬運車",    "transfer.sh",destination="焊接站"),
    ]),
    s("此批碳鋼板不需精密加工，切割後直接品檢再送出貨倉", [
        step("node-1","切割機",    "cut.sh",     material="碳鋼板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.94),
        step("node-5","搬運車",    "transfer.sh",destination="出貨倉"),
    ]),
    s("環氧樹脂板 45 片切割後做品質檢測，合格搬到固化站", [
        step("node-1","切割機",    "cut.sh",     material="環氧樹脂板",quantity=45),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",       pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="固化站"),
    ]),
    s("鎳板切割完成後品質檢測儀驗收，合格由搬運車送到電鍍線", [
        step("node-1","切割機",    "cut.sh",     material="鎳板",  output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.96),
        step("node-5","搬運車",    "transfer.sh",destination="電鍍線"),
    ]),
    s("鉛框切割後品質管制，通過品質門檻才讓搬運車帶走", [
        step("node-1","切割機",    "cut.sh",     material="鉛框",  output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="成品區"),
    ]),
    s("晶圓載板 35 片：切割機→品質檢測儀→搬運車到研磨區", [
        step("node-1","切割機",    "cut.sh",     material="晶圓載板",quantity=35),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.97),
        step("node-5","搬運車",    "transfer.sh",destination="研磨區"),
    ]),
    s("鋁散熱片切割後立即做品質檢測，OK 再搬到組裝區", [
        step("node-1","切割機",    "cut.sh",     material="鋁散熱片",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="組裝區"),
    ]),
    s("批次 90 件不鏽鋼片：切割→品質抽檢（95%）→搬運至鍍鋅站", [
        step("node-1","切割機",    "cut.sh",     material="不鏽鋼片",quantity=90),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="鍍鋅站"),
    ]),
    s("鋁型材 55 支切割後 QC 品質管制，通過送到成型站", [
        step("node-1","切割機",    "cut.sh",     material="鋁型材",quantity=55),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.94),
        step("node-5","搬運車",    "transfer.sh",destination="成型站"),
    ]),
    s("複合材料板切割→品質檢測儀→搬運車，直達出口倉（無需 CNC）", [
        step("node-1","切割機",    "cut.sh",     material="複合材料板",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",       pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出口倉"),
    ]),
    s("磁性材料 20 片：切割完成→品質管制通過→搬運車送到磁化站", [
        step("node-1","切割機",    "cut.sh",     material="磁性材料",quantity=20),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.97),
        step("node-5","搬運車",    "transfer.sh",destination="磁化站"),
    ]),
    s("鈹銅合金切割後直接做品質檢測，合格搬至精密零件區", [
        step("node-1","切割機",    "cut.sh",     material="鈹銅合金",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.98),
        step("node-5","搬運車",    "transfer.sh",destination="精密零件區"),
    ]),
    s("對 PCB 板 110 片執行切割後品質檢測，合格品搬到電測站", [
        step("node-1","切割機",    "cut.sh",     material="PCB板", quantity=110),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="電測站"),
    ]),
    s("鎂合金薄板 65 片切割後品質檢測，通過後搬運至表面處理站", [
        step("node-1","切割機",    "cut.sh",     material="鎂合金薄板",quantity=65),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",       pass_threshold=0.94),
        step("node-5","搬運車",    "transfer.sh",destination="表面處理站"),
    ]),
    s("石英玻璃切割後立即 QC，合格搬到光學元件暫存", [
        step("node-1","切割機",    "cut.sh",     material="石英玻璃",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.99),
        step("node-5","搬運車",    "transfer.sh",destination="光學元件暫存"),
    ]),
    s("鈦板 15 片切割後做 QC（99%），合格品送精加工暫存（此批不需 CNC）", [
        step("node-1","切割機",    "cut.sh",     material="鈦板",  quantity=15),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.99),
        step("node-5","搬運車",    "transfer.sh",destination="精加工暫存"),
    ]),
    s("切割完鋁棒後直接品質管制，不進行 CNC，品管通過後搬至出貨暫存", [
        step("node-1","切割機",    "cut.sh",     material="鋁棒",  output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="出貨暫存"),
    ]),
    s("高碳鋼 85 片批次：切割→品質檢測儀→搬運車，目的地熱處理區", [
        step("node-1","切割機",    "cut.sh",     material="高碳鋼",quantity=85),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="熱處理區"),
    ]),
    s("硬碟基板 55 片切割後品質管制，合格品搬到塗層站，不需 CNC 加工", [
        step("node-1","切割機",    "cut.sh",     material="硬碟基板",quantity=55),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.96),
        step("node-5","搬運車",    "transfer.sh",destination="塗層站"),
    ]),
    s("氧化鋁陶瓷板 30 片：切割後品質驗收，通過才搬到燒結爐區", [
        step("node-1","切割機",    "cut.sh",     material="氧化鋁陶瓷板",quantity=30),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",         pass_threshold=0.97),
        step("node-5","搬運車",    "transfer.sh",destination="燒結爐區"),
    ]),
    s("金屬薄膜切割後品質檢測，合格送蒸鍍站，本批不需精密加工", [
        step("node-1","切割機",    "cut.sh",     material="金屬薄膜",output="切割件"),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",     pass_threshold=0.95),
        step("node-5","搬運車",    "transfer.sh",destination="蒸鍍站"),
    ]),
    s("鋼管 40 根切割後品質檢測（門檻 93%），合格品搬到最終出口", [
        step("node-1","切割機",    "cut.sh",     material="鋼管",  quantity=40),
        step("node-3","品質檢測儀","qc_check.sh",input="切割件",   pass_threshold=0.93),
        step("node-5","搬運車",    "transfer.sh",destination="最終出口"),
    ]),

    # ══════════════════════════════════════════════════════════════════════════
    # Q3 EXPLICIT ORDER — 強化「第一步 node-1→第二步 node-2→第三步 node-3」語意
    # ══════════════════════════════════════════════════════════════════════════

    s("矽晶圓三步驟製程：第一步用切割機切割，第二步用 CNC-03 精密加工，第三步用品質檢測儀 QC，輸出 JSON", [
        step("node-1","切割機",    "cut.sh",     material="矽晶圓",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",   output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件", output="JSON"),
    ]),
    s("依序執行：①切割機切割矽晶圓 ②CNC-03 精密加工 ③品質檢測儀 QC 輸出 JSON 結果", [
        step("node-1","切割機",    "cut.sh",     material="矽晶圓",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",   output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件", output="JSON"),
    ]),
    s("step1: node-1 切割機切割矽晶圓；step2: node-2 CNC-03 精加工；step3: node-3 品質檢測輸出 JSON", [
        step("node-1","切割機",    "cut.sh",     material="矽晶圓",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",   output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件", output="JSON"),
    ]),
    s("矽晶圓製程三節點，node-1 先切割，接著 node-2 CNC 加工，最後 node-3 品質檢測產出 JSON", [
        step("node-1","切割機",    "cut.sh",     material="矽晶圓",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",   output="加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="加工件",   output="JSON"),
    ]),
    s("硬碟基板三段製程：切割機（node-1）→ CNC-03（node-2）→ 品質檢測儀（node-3），產出 JSON 報告", [
        step("node-1","切割機",    "cut.sh",     material="硬碟基板",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",     output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件",   output="JSON"),
    ]),
    s("光學鏡片：切割機先切割，CNC-03 精密加工，品質檢測儀最終 QC，產出 JSON", [
        step("node-1","切割機",    "cut.sh",     material="光學鏡片",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",     output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件",   output="JSON"),
    ]),
    s("精密陶瓷件：第一步切割機切割 → 第二步 CNC 精密加工 → 第三步品質檢測，JSON 輸出", [
        step("node-1","切割機",    "cut.sh",     material="精密陶瓷",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",     output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件",   output="JSON"),
    ]),
    s("鈦合金精密件三工序：切割→精密CNC加工→品質檢測，輸出 JSON 格式結果", [
        step("node-1","切割機",    "cut.sh",     material="鈦合金",output="切割件"),
        step("node-2","CNC-03",    "cnc_job.sh", input="切割件",   output="精加工件"),
        step("node-3","品質檢測儀","qc_check.sh",input="精加工件", output="JSON"),
    ]),

    # ══════════════════════════════════════════════════════════════════════════
    # Q6 STRONG SIGNAL — 強化「報告 = 只有 node-4，不執行其他工序」
    # ══════════════════════════════════════════════════════════════════════════

    s("不需要執行任何工序，只需要 report-svc 產生 node-1 到 node-3 的今日 PDF 日報", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("今日日報任務：report-svc 彙整 node-1、node-2、node-3 作業記錄，輸出 PDF", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("只呼叫 node-4，產出 node-1 到 node-3 的作業 PDF，不執行切割或加工", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("報告生成任務（不製造）：node-4 report-svc 彙整 node-1~node-3 今日數據輸出 PDF", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("今天班次結束，請 report-svc 統計 node-1、node-2、node-3 的產量並輸出 PDF 日報", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("單純出報告：彙整切割機（node-1）、CNC-03（node-2）、品質檢測儀（node-3）今日作業 PDF", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("管理者需要 node-1 到 node-3 的日報，用 node-4 report-svc 產生 PDF 即可", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
    ]),
    s("不進行生產作業，只出 PDF 報告：report-svc 來源 node-1,node-2,node-3，今日", [
        step("node-4","report-svc","report.sh",
             source_nodes="node-1,node-2,node-3", output="PDF", date="today"),
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
    print(f"Patch 8: added {added} → total {total}")
