"""Builds training/data/hiba-c6-scenarios.jsonl from the 20 hand-labeled S01-S20
scenarios in the Vault (實作規格/plan_LLM_訓練清單.md §四). These test the A3
resource-decision function (delegate/install/partial/reject) that the 64-row
templated eval set never exercises -- every templated scenario assumes a
single always-online node with the tool already present.

Adaptation from the Vault's spec-draft JSON to the real Core Protocol v1
runtime schema (documented here, not silently done):
- each step gets `version: "1.0.0"` added (the Vault draft predates the
  `version` field being required)
- `_plannerNote` (human-readable annotation in the Vault draft) is dropped --
  not part of the real ExecutionPlan schema, and leaving it in would make
  exact-match impossible for a model that (correctly) never emits it
- node IDs stay node1..node11 (not m1/m2-style) to match the Vault spec's own
  scenario text (S10 "node9 離線，node10 可承接", etc.)
- S18's row uses a *scoped* tool catalog (no man.* tools) to simulate the
  ScopedToolbox permission restriction described in the scenario -- the
  planner never sees man.loginOperator as an option, matching how the real
  runtime would present it to a restricted caller

Run: python training/data/build_c6_scenarios.py
"""

import json
from pathlib import Path

OUT_PATH = Path(__file__).parent / "hiba-c6-scenarios.jsonl"
PROTOCOL_VERSION = "1.0"

string = {"type": "string"}
number = {"type": "number"}
boolean = {"type": "boolean"}


def tool(name, description, properties, required=None, action="read"):
    domain = name.split(".")[0]
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "name": name,
        "version": "1.0.0",
        "description": description,
        "tags": [domain, action],
        "inputSchema": {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False},
        "outputSchema": {"type": "object"},
        "permissions": [] if action == "read" else [f"{domain}.{action}"],
        "timeoutMs": 10_000,
    }


TOOLS = [
    tool("material.verifyFile", "驗證檔案完整性", {"filePath": string}, ["filePath"]),
    tool("material.protectFile", "保護檔案並建立稽核紀錄", {"filePath": string, "keepFile": boolean}, ["filePath"], "write"),
    tool("material.traceLot", "追蹤批次流向", {"lotId": string}, ["lotId"]),
    tool("material.inspectIncoming", "進料檢驗", {"lotId": string, "inspectionResult": string}, ["lotId"], "write"),
    tool("material.fetchBom", "取得產品 BOM 清單", {"productId": string}, ["productId"]),
    tool("machine.queryStatus", "查詢機台狀態", {"machineId": string}, ["machineId"]),
    tool("machine.calculateOee", "計算 OEE", {"machineId": string, "timeRange": string}, ["machineId", "timeRange"]),
    tool("machine.checkCalib", "確認校正狀態", {"machineId": string}, ["machineId"]),
    tool("man.loginOperator", "操作員登入", {"employeeId": string, "passwordHash": string}, ["employeeId"], "write"),
    tool("man.verifyOperatorCert", "驗證操作員技能證照", {"employeeId": string, "skillCode": string}, ["employeeId", "skillCode"]),
    tool("man.sendAlert", "發送通知", {"employeeId": string, "message": string}, ["employeeId", "message"], "write"),
    tool("method.fetchSop", "取得標準作業程序", {"sopCode": string}, ["sopCode"]),
    tool("method.validateParam", "驗證製程參數", {"processId": string, "paramKey": string, "value": string}, ["processId", "paramKey"]),
    tool("method.recordAudit", "記錄稽核結果", {"auditType": string, "result": string, "notes": string}, ["auditType"], "write"),
    tool("method.checkCompliance", "確認合規狀態", {"productId": string}, ["productId"]),
    tool("env.readTemperature", "讀取溫度", {"sensorId": string}, ["sensorId"]),
    tool("env.readHumidity", "讀取濕度", {"sensorId": string}, ["sensorId"]),
    tool("orchestrator.installTool", "安裝工具到節點", {"toolName": string, "version": string}, ["toolName"], "write"),
    tool("orchestrator.getAuditSummary", "取得稽核摘要", {"timeRange": string}, ["timeRange"]),
]
TOOL_BY_NAME = {t["name"]: t for t in TOOLS}


def resource(name):
    return {"name": name, "version": "1.0.0", "type": "tool"}


ALL_TOOL_NAMES = [t["name"] for t in TOOLS]
# node11 is online but has not installed machine.calculateOee (S11 install scenario);
# node9 and node5 are offline (S10 delegate, S12 partial). node15 simply does not
# exist -- omitted from the registry (S13 reject scenario).
NODE_OVERRIDES = {"node9": "offline", "node5": "offline"}
NODE_MISSING_TOOL = {"node11": ["machine.calculateOee"]}


def build_nodes():
    nodes = []
    for i in range(1, 12):
        node_id = f"node{i}"
        status = NODE_OVERRIDES.get(node_id, "online")
        missing = NODE_MISSING_TOOL.get(node_id, [])
        node_tools = [n for n in ALL_TOOL_NAMES if n not in missing]
        nodes.append({
            "protocolVersion": PROTOCOL_VERSION, "nodeId": node_id,
            "agentUrl": f"http://{node_id}:3000" if status == "online" else None,
            "status": status, "canInstall": True,
            "resources": [resource(n) for n in node_tools] if status == "online" else [],
            "registeredAt": None, "lastSeenAt": None,
        })
    return nodes


NODES = build_nodes()
RESOURCES = {n["nodeId"]: n["resources"] for n in NODES}


def context(tools=TOOLS):
    return {"protocolVersion": PROTOCOL_VERSION, "resources": RESOURCES, "nodes": NODES, "tools": tools}


def step(step_id, tool_name, node_id, input_, depends_on=None):
    return {"stepId": step_id, "toolName": tool_name, "nodeId": node_id, "version": "1.0.0",
            "input": input_, "dependsOn": depends_on or []}


def plan(steps, policy="fail-fast", error=None):
    p = {"protocolVersion": PROTOCOL_VERSION, "steps": steps, "supervisorPolicy": policy}
    if error:
        p["error"] = error
    return p


SCENARIOS = [
    ("S01", "驗證 node8 上的模型 model_111_221.xml 完整性", context(),
     plan([step("S1", "material.verifyFile", "node8", {"filePath": "/opt/models/model_111_221.xml"})])),
    ("S02", "查詢 node3 的機台運作狀態", context(),
     plan([step("S1", "machine.queryStatus", "node3", {"machineId": "node3"})])),
    ("S03", "讀取 node6 感測器 T-06 的即時溫度", context(),
     plan([step("S1", "env.readTemperature", "node6", {"sensorId": "T-06"})])),
    ("S04", "先驗證 node8 的模型完整性，確認無誤後再上鏈保護", context(),
     plan([
         step("S1", "material.verifyFile", "node8", {"filePath": "/opt/models/model_111_221.xml"}),
         step("S2", "material.protectFile", "node8", {"filePath": "/opt/models/model_111_221.xml", "keepFile": True}, ["S1"]),
     ])),
    ("S05", "確認員工 E-001 在 node1 的上機資格，需先登入再驗證技能證書", context(),
     plan([
         step("S1", "man.loginOperator", "node1", {"employeeId": "E-001", "passwordHash": "{{HASH}}"}),
         step("S2", "man.verifyOperatorCert", "node1", {"employeeId": "E-001", "skillCode": "CNC-LATHE"}, ["S1"]),
     ])),
    ("S06", "計算 node4 本月的 OEE，然後記錄稽核結果", context(),
     plan([
         step("S1", "machine.calculateOee", "node4", {"machineId": "node4", "timeRange": "2026-05"}),
         step("S2", "method.recordAudit", "node4", {"auditType": "OEE_MONTHLY", "result": "{{S1.output}}", "notes": "月度設備效率稽核"}, ["S1"]),
     ])),
    ("S07", "料號 PN-500 的新批次到貨，執行進料檢驗、查 BOM 確認料件，再驗證 IATF 合規", context(),
     plan([
         step("S1", "material.inspectIncoming", "node2", {"lotId": "LOT-2026-05-001", "inspectionResult": "PENDING"}),
         step("S2", "material.fetchBom", "node2", {"productId": "PN-500"}),
         step("S3", "method.checkCompliance", "node2", {"productId": "PN-500"}, ["S1", "S2"]),
     ])),
    ("S08", "node8 的聯邦學習模型訓練完成，依序執行：完整性驗證、上鏈保護、批次追蹤、最後記錄稽核", context(),
     plan([
         step("S1", "material.verifyFile", "node8", {"filePath": "/opt/models/federated_round42.xml"}),
         step("S2", "material.protectFile", "node8", {"filePath": "/opt/models/federated_round42.xml", "keepFile": True}, ["S1"]),
         step("S3", "material.traceLot", "node8", {"lotId": "FL-ROUND-42"}, ["S2"]),
         step("S4", "method.recordAudit", "node8", {"auditType": "FL_MODEL_PROTECTION", "result": "{{S3.output}}", "notes": "第42輪聯邦模型保護完成"}, ["S3"]),
     ])),
    ("S09", "同時取得 node1、node2、node3 的即時溫度，盡量回傳", context(),
     plan([
         step("S1", "env.readTemperature", "node1", {"sensorId": "T-01"}),
         step("S2", "env.readTemperature", "node2", {"sensorId": "T-02"}),
         step("S3", "env.readTemperature", "node3", {"sensorId": "T-03"}),
     ], policy="partial-success")),
    ("S10", "保護 node9 的模型 model_99.xml", context(),
     plan([step("S1", "material.protectFile", "node10", {"filePath": "/opt/models/model_99.xml", "keepFile": True})])),
    ("S11", "查詢 node11 的 OEE", context(),
     plan([
         step("S1", "orchestrator.installTool", "node11", {"toolName": "machine.calculateOee", "version": "latest"}),
         step("S2", "machine.calculateOee", "node11", {"machineId": "node11", "timeRange": "2026-05"}, ["S1"]),
     ])),
    ("S12", "查詢 node4 到 node6 的機台狀態，能查多少算多少", context(),
     plan([
         step("S1", "machine.queryStatus", "node4", {"machineId": "node4"}),
         step("S2", "machine.queryStatus", "node6", {"machineId": "node6"}),
     ], policy="partial-success")),
    ("S13", "保護 node15 的模型", context(),
     plan([], error="NODE_NOT_FOUND: node15 不在 TrustRegistry 中，無法執行任務")),
    ("S14", "node6 的濕度超標警報觸發，幫我讀取感測器數值、查詢機台狀態，然後通知班長 MGR-002", context(),
     plan([
         step("S1", "env.readHumidity", "node6", {"sensorId": "H-06"}),
         step("S2", "machine.queryStatus", "node6", {"machineId": "node6"}),
         step("S3", "man.sendAlert", "node6", {"employeeId": "MGR-002", "message": "node6 濕度超標警報，請立即確認。濕度：{{S1.output.humidity}}，機台狀態：{{S2.output.status}}"}, ["S1", "S2"]),
     ])),
    ("S15", "node3 準備換模，依序確認操作員資格、取得 SOP、驗證製程參數，全部通過後記錄稽核", context(),
     plan([
         step("S1", "man.verifyOperatorCert", "node3", {"employeeId": "E-003", "skillCode": "MOLD-CHANGE"}),
         step("S2", "method.fetchSop", "node3", {"sopCode": "SOP-MOLD-003"}),
         step("S3", "method.validateParam", "node3", {"processId": "MOLD-CHANGE-003", "paramKey": "clampForce", "value": "{{S2.output.specValue}}"}, ["S2"]),
         step("S4", "method.recordAudit", "node3", {"auditType": "MOLD_CHANGE", "result": "PASS", "notes": "操作員：E-003，SOP：SOP-MOLD-003"}, ["S1", "S3"]),
     ])),
    ("S16", "準備讓 node7 和 node8 進行聯邦學習：確認兩個節點都在線、校正狀態正常、再各自保護現有模型", context(),
     plan([
         step("S1", "machine.queryStatus", "node7", {"machineId": "node7"}),
         step("S2", "machine.queryStatus", "node8", {"machineId": "node8"}),
         step("S3", "machine.checkCalib", "node7", {"machineId": "node7"}, ["S1"]),
         step("S4", "machine.checkCalib", "node8", {"machineId": "node8"}, ["S2"]),
         step("S5", "material.protectFile", "node7", {"filePath": "/opt/models/current_model.xml", "keepFile": True}, ["S3"]),
         step("S6", "material.protectFile", "node8", {"filePath": "/opt/models/current_model.xml", "keepFile": True}, ["S4"]),
     ])),
    ("S17", "幫我看一下 node5 的整體狀況", context(),
     plan([
         step("S1", "machine.queryStatus", "node5", {"machineId": "node5"}),
         step("S2", "env.readTemperature", "node5", {"sensorId": "T-05"}),
         step("S3", "env.readHumidity", "node5", {"sensorId": "H-05"}),
     ], policy="partial-success")),
    # S18: scoped catalog -- TrainingAgent's ScopedToolbox does not include any man.* write tool.
    ("S18", "建立一個新的操作員帳號 E-999", context(tools=[t for t in TOOLS if not t["name"].startswith("man.")]),
     plan([], error="TOOL_NOT_FOUND: 目前可用工具目錄不包含建立操作員帳號所需的工具")),
    ("S19", "驗證 node8 的模型，若有問題請立刻停下，不要繼續保護", context(),
     plan([
         step("S1", "material.verifyFile", "node8", {"filePath": "/opt/models/federated_latest.xml"}),
         step("S2", "material.protectFile", "node8", {"filePath": "/opt/models/federated_latest.xml", "keepFile": True}, ["S1"]),
     ])),
    ("S20", "查詢 node1 到 node5 的機台狀態，有幾個算幾個，最後匯總報告", context(),
     plan([
         step("S1", "machine.queryStatus", "node1", {"machineId": "node1"}),
         step("S2", "machine.queryStatus", "node2", {"machineId": "node2"}),
         step("S3", "machine.queryStatus", "node3", {"machineId": "node3"}),
         step("S4", "machine.queryStatus", "node4", {"machineId": "node4"}),
         step("S5", "machine.queryStatus", "node5", {"machineId": "node5"}),
         step("S6", "orchestrator.getAuditSummary", "node1", {"timeRange": "last-5min"}, ["S1", "S2", "S3", "S4", "S5"]),
     ], policy="partial-success")),
]


def main():
    rows = []
    for scenario_id, instruction, ctx, expected in SCENARIOS:
        rows.append({"scenarioId": scenario_id, "instruction": instruction, "input": json.dumps(ctx), "output": json.dumps(expected)})
    OUT_PATH.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"[build_c6_scenarios] wrote {len(rows)} rows to {OUT_PATH}")


if __name__ == "__main__":
    main()
