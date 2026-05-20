#!/usr/bin/env python3
"""
scripts/script_3.py — 環境感測器讀取（溫濕度）
輸入：{ "sensorId": "sensor-01" }  或  {} 讀取所有感測器
輸出：{ "temperature": 24.5, "humidity": 58.2, "renderHint": "chart" }

資料來源：data_sensors.json（與本檔案同目錄）
- 每個感測器有自訂的 normalRange，模擬值在該範圍內隨機生成
- 超過 alertThreshold 時輸出 alert 欄位
"""
import sys, json, os, datetime, random

DATA_FILE = os.path.join(os.path.dirname(__file__), "data_sensors.json")

def load_sensors():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def simulate_reading(sensor: dict) -> dict:
    """根據感測器設定的 normalRange 產生模擬讀值，並判斷是否超過警報閾值"""
    t_range = sensor["normalRange"]["temperature"]
    h_range = sensor["normalRange"]["humidity"]

    temp  = round(random.uniform(*t_range), 1)
    humid = round(random.uniform(*h_range), 1)

    t_alert = sensor.get("alertThreshold", {}).get("temperature", 999)
    h_alert = sensor.get("alertThreshold", {}).get("humidity", 999)

    reading = {
        "sensorId":    sensor["sensorId"],
        "name":        sensor["name"],
        "location":    sensor["location"],
        "type":        sensor["type"],
        "temperature": temp,
        "humidity":    humid,
        "timestamp":   datetime.datetime.now(datetime.timezone.utc)
                           .isoformat().replace("+00:00", "Z"),
    }

    alerts = []
    if temp > t_alert:
        alerts.append({"field": "temperature", "value": temp, "threshold": t_alert, "msg": "溫度超過警報閾值"})
    if humid > h_alert:
        alerts.append({"field": "humidity",    "value": humid, "threshold": h_alert, "msg": "濕度超過警報閾值"})
    if alerts:
        reading["alerts"] = alerts

    return reading

def main():
    params    = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    sensor_id = params.get("sensorId")

    sensors = load_sensors()

    if sensor_id:
        s = next((x for x in sensors if x["sensorId"] == sensor_id), None)
        if s:
            data = simulate_reading(s)
        else:
            # 感測器 ID 不在資料集：回傳通用模擬值
            data = {
                "sensorId":    sensor_id,
                "name":        "（未登錄感測器）",
                "location":    "—",
                "type":        "unknown",
                "temperature": round(random.uniform(20.0, 30.0), 1),
                "humidity":    round(random.uniform(45.0, 75.0), 1),
                "timestamp":   datetime.datetime.now(datetime.timezone.utc)
                                   .isoformat().replace("+00:00", "Z"),
            }
        result = {
            "success":     True,
            "sensors":     [data],
            "temperature": data["temperature"],
            "humidity":    data["humidity"],
            "timestamp":   data["timestamp"],
            "renderHint":  "chart",
            "toolName":    "env.readSensor",
            "domain":      "env"
        }
    else:
        # 讀取資料集中所有感測器
        all_readings = [simulate_reading(s) for s in sensors] if sensors else [
            {
                "sensorId": f"sensor-0{i}",
                "name": f"感測器 {i}",
                "location": "—",
                "type": "DHT22",
                "temperature": round(random.uniform(20.0, 30.0), 1),
                "humidity":    round(random.uniform(45.0, 75.0), 1),
                "timestamp":   datetime.datetime.now(datetime.timezone.utc)
                                   .isoformat().replace("+00:00", "Z"),
            } for i in range(1, 4)
        ]
        result = {
            "success":     True,
            "sensors":     all_readings,
            "temperature": all_readings[0]["temperature"],
            "humidity":    all_readings[0]["humidity"],
            "timestamp":   all_readings[0]["timestamp"],
            "renderHint":  "chart",
            "toolName":    "env.readSensor",
            "domain":      "env"
        }

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
