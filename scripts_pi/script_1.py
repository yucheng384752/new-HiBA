#!/usr/bin/env python3
"""
scripts/script_1.py — 工單執行腳本
Sub-Web 透過 POST /execute { scriptName: "script_1" } 呼叫

輸入 (sys.argv[1])：
  { "orderId": "WO-2026-001", "quantity": 100 }

輸出 (stdout JSON)：
  { "success": true, "orderId": "...", "processed": 100, "renderHint": "table" }

資料來源：data_orders.json（與本檔案同目錄）
"""
import sys, json, os, datetime

DATA_FILE = os.path.join(os.path.dirname(__file__), "data_orders.json")

def load_orders():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        return []

def main():
    params   = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    order_id = params.get("orderId", "")
    quantity = params.get("quantity", 0)

    orders = load_orders()
    order  = next((o for o in orders if o["orderId"] == order_id), None)

    if order:
        # 以資料集裡的工單資料回傳，quantity 可覆寫或沿用原始值
        qty_to_process = quantity if quantity > 0 else order["quantity"]
        result = {
            "success":    True,
            "orderId":    order["orderId"],
            "product":    order["product"],
            "material":   order["material"],
            "quantity":   order["quantity"],
            "processed":  qty_to_process,
            "unit":       order["unit"],
            "priority":   order["priority"],
            "assignedLine": order["assignedLine"],
            "orderStatus":  order["status"],
            "completedAt":  datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
            "renderHint":   "table",
            "toolName":     "machine.executeOrder",
            "domain":       "machine"
        }
    else:
        # orderId 不在資料集中：仍執行，但標記為臨時工單
        result = {
            "success":    True,
            "orderId":    order_id or "TEMP",
            "product":    "（未登錄工單）",
            "material":   "—",
            "quantity":   quantity,
            "processed":  quantity,
            "unit":       "pcs",
            "priority":   "normal",
            "assignedLine": "—",
            "orderStatus":  "ad_hoc",
            "completedAt":  datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
            "renderHint":   "table",
            "toolName":     "machine.executeOrder",
            "domain":       "machine"
        }

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
