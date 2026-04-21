#!/usr/bin/env python3
"""
scripts/script_echo.py — Echo 回響 / RTT 測試腳本
最輕量的端對端通道驗證：PC 送時間戳 → Pi 加上 receivedAt 回傳 → PC 計算 RTT

輸入：
  { "message": "hello", "sentAt": "2026-04-13T10:00:00.000Z" }

輸出：
  {
    "success":    true,
    "echo":       "hello",
    "sentAt":     "2026-04-13T10:00:00.000Z",
    "receivedAt": "2026-04-13T10:00:00.123Z",
    "rttMs":      123,          ← sentAt 到 receivedAt 的差值（Pi 端計算）
    "nodeId":     "m1",
    "renderHint": "table"
  }

用途：
  - 驗證 PC → Pi → PC 通道是否正常
  - 量測 HTTP 來回延遲（不含算力）
  - 確認 Pi 系統時間是否同步（比對 sentAt 與 receivedAt）
"""
import sys, json, os, datetime

def main():
    params  = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    message = params.get("message", "ping")
    sent_at = params.get("sentAt", "")

    received_at = datetime.datetime.now(datetime.timezone.utc)

    # 計算 RTT（Pi 端：sentAt 到 receivedAt）
    rtt_ms = None
    if sent_at:
        try:
            # 相容 .000Z 與 +00:00 格式
            sent_dt = datetime.datetime.fromisoformat(sent_at.replace("Z", "+00:00"))
            rtt_ms  = int((received_at - sent_dt).total_seconds() * 1000)
        except Exception:
            rtt_ms = None

    node_id = os.environ.get("NODE_ID", "unknown")

    result = {
        "success":    True,
        "echo":       message,
        "sentAt":     sent_at,
        "receivedAt": received_at.isoformat().replace("+00:00", "Z"),
        "rttMs":      rtt_ms,
        "nodeId":     node_id,
        "renderHint": "table",
        "toolName":   "orchestrator.echoRtt",
        "domain":     "orchestrator"
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
