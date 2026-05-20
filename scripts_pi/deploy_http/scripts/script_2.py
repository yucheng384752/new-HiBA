#!/usr/bin/env python3
"""
scripts/script_2.py — 機台狀態查詢
輸入：{ "machineId": "CNC-01" }
輸出：{ "status": "running", "oee": 87.5, "alarms": [], "renderHint": "status" }

資料來源：data_machines.json（與本檔案同目錄）
"""
import sys, json, os, datetime, random

DATA_FILE = os.path.join(os.path.dirname(__file__), "data_machines.json")

def load_machines():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def pick_status(weights: dict) -> str:
    """依機台設定的機率權重隨機選取狀態"""
    keys   = list(weights.keys())
    probs  = [weights[k] for k in keys]
    r = random.random()
    cumulative = 0.0
    for k, p in zip(keys, probs):
        cumulative += p
        if r <= cumulative:
            return k
    return keys[-1]

def main():
    params     = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    machine_id = params.get("machineId", "")

    machines = load_machines()
    machine  = next((m for m in machines if m["machineId"] == machine_id), None)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    if machine:
        status = pick_status(machine["statusWeights"])
        oee    = round(random.uniform(*machine["oeeRange"]), 1)

        alarms = []
        if status == "error" and machine.get("alarmCodes"):
            alarm_def = random.choice(machine["alarmCodes"])
            alarms = [{
                "code":    alarm_def["code"],
                "message": alarm_def["message"],
                "ts":      now
            }]

        result = {
            "success":   True,
            "machineId": machine["machineId"],
            "name":      machine["name"],
            "type":      machine["type"],
            "line":      machine["line"],
            "status":    status,
            "oee":       oee,
            "alarms":    alarms,
            "queriedAt": now,
            "renderHint": "status",
            "toolName":  "machine.queryStatus",
            "domain":    "machine"
        }
    else:
        # 機台 ID 不在資料集：回傳通用模擬值
        statuses = ["running", "running", "running", "idle", "error"]
        status   = random.choice(statuses)
        result = {
            "success":   True,
            "machineId": machine_id or "UNKNOWN",
            "name":      "（未登錄機台）",
            "type":      "—",
            "line":      "—",
            "status":    status,
            "oee":       round(random.uniform(75.0, 95.0), 1),
            "alarms":    [] if status != "error" else [
                {"code": "E-999", "message": "未知錯誤", "ts": now}
            ],
            "queriedAt": now,
            "renderHint": "status",
            "toolName":  "machine.queryStatus",
            "domain":    "machine"
        }

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
