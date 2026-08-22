#!/usr/bin/env python3
"""Query machine event logs within an inclusive ISO-8601 time range."""

import datetime
import json
import os
import sys


LOG_FILE = os.path.join(
    os.environ.get("LOG_DIR", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "logs"))),
    "machine_events.jsonl",
)


def parse_time(value):
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("time must include Z or a UTC offset")
    return parsed.astimezone(datetime.timezone.utc)


def main():
    params = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    machine_id = params.get("machineId", "")
    start = parse_time(params.get("startTime", ""))
    end = parse_time(params.get("endTime", ""))
    limit = params.get("limit", 100)
    if start > end:
        raise ValueError("startTime must not be later than endTime")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1000:
        raise ValueError("limit must be an integer from 1 to 1000")

    logs = []
    try:
        with open(LOG_FILE, encoding="utf-8") as file:
            for line in file:
                try:
                    event = json.loads(line)
                    timestamp = parse_time(event["timestamp"])
                except (KeyError, ValueError, json.JSONDecodeError):
                    continue
                if event.get("machineId") == machine_id and start <= timestamp <= end:
                    logs.append(event)
    except FileNotFoundError:
        pass

    logs = logs[-limit:]
    print(json.dumps({
        "success": True,
        "machineId": machine_id,
        "startTime": params["startTime"],
        "endTime": params["endTime"],
        "count": len(logs),
        "logs": logs,
        "renderHint": "table",
        "toolName": "machine.queryLog",
        "domain": "machine",
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
