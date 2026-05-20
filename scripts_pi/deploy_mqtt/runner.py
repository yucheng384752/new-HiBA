#!/usr/bin/env python3
"""
runner.py — HiBA-AB MQTT Edge Agent Runner
/opt/agent/runner.py

功能：
  1. 訂閱 MQTT topic: tasks/{NODE_ID}
  2. 接收 JobPayload（含 base64 wasm binary）
  3. 解碼 .wasm 到暫存目錄
  4. 透過 WAMR (iwasm) 在沙箱內執行
  5. 將 JobResult 回傳至 results/{job_id}
  6. 定期發送 heartbeat/{NODE_ID}

環境變數（/etc/agent/env）：
  NODE_ID   - 節點識別碼，對應 MQTT topic 路由
  BROKER    - MQTT broker 位址，e.g. 192.168.50.100
  BROKER_PORT - broker port（預設 1883）
  IWASM_PATH  - iwasm binary 路徑（預設 /usr/local/bin/iwasm）
  WASM_TIMEOUT - 執行超時秒數（預設 30）
"""
import os
import sys
import json
import base64
import tempfile
import subprocess
import threading
import time
import logging

import paho.mqtt.client as mqtt

# ── 設定 ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('runner')

NODE_ID      = os.environ.get('NODE_ID', 'unknown')
BROKER       = os.environ.get('BROKER', 'localhost')
BROKER_PORT  = int(os.environ.get('BROKER_PORT', '1883'))
IWASM_PATH   = os.environ.get('IWASM_PATH', '/usr/local/bin/iwasm')
WASM_TIMEOUT = int(os.environ.get('WASM_TIMEOUT', '30'))

TOPIC_TASKS     = f'tasks/{NODE_ID}'
TOPIC_RESULTS   = 'results/{job_id}'
TOPIC_HEARTBEAT = f'heartbeat/{NODE_ID}'

# ── WASM 執行 ─────────────────────────────────────────────────────────────────

def run_wasm(wasm_b64: str, args: list[str], timeout: int) -> dict:
    """
    解碼 base64 wasm → 暫存檔 → iwasm 執行 → 回傳 stdout/stderr/exit_code
    暫存檔在回傳後自動刪除。
    """
    try:
        wasm_bytes = base64.b64decode(wasm_b64)
    except Exception as e:
        return {'stdout': '', 'stderr': f'base64 decode error: {e}', 'exit_code': -1}

    with tempfile.NamedTemporaryFile(suffix='.wasm', delete=False) as f:
        f.write(wasm_bytes)
        wasm_path = f.name

    try:
        result = subprocess.run(
            [IWASM_PATH, wasm_path] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            'stdout':    result.stdout,
            'stderr':    result.stderr,
            'exit_code': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': f'WASM_TIMEOUT after {timeout}s', 'exit_code': -2}
    except FileNotFoundError:
        return {'stdout': '', 'stderr': f'iwasm not found at {IWASM_PATH}', 'exit_code': -3}
    except Exception as e:
        return {'stdout': '', 'stderr': str(e), 'exit_code': -1}
    finally:
        try:
            os.unlink(wasm_path)
        except OSError:
            pass

# ── MQTT 訊息處理 ─────────────────────────────────────────────────────────────

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode('utf-8'))
    except json.JSONDecodeError as e:
        log.error('JSON decode error: %s', e)
        return

    job_id    = payload.get('job_id', 'unknown')
    issued_at = payload.get('issued_at', '')
    timeout   = int(payload.get('timeout', WASM_TIMEOUT))
    args      = payload.get('args', [])
    wasm_b64  = payload.get('wasm', '')

    log.info('Job received  job_id=%s  timeout=%ds', job_id, timeout)

    if not wasm_b64:
        result = {'stdout': '', 'stderr': 'JobPayload missing wasm field', 'exit_code': -1}
    else:
        result = run_wasm(wasm_b64, args, timeout)

    log.info('Job completed job_id=%s  exit_code=%d', job_id, result['exit_code'])

    import datetime
    job_result = {
        'job_id':       job_id,
        'node_id':      NODE_ID,
        'stdout':       result['stdout'],
        'stderr':       result['stderr'],
        'exit_code':    result['exit_code'],
        'completed_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'issued_at':    issued_at,
    }

    topic = TOPIC_RESULTS.format(job_id=job_id)
    client.publish(topic, json.dumps(job_result), qos=1)
    log.info('Result published → %s', topic)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log.info('Connected to broker %s:%d', BROKER, BROKER_PORT)
        client.subscribe(TOPIC_TASKS, qos=1)
        log.info('Subscribed → %s', TOPIC_TASKS)
    else:
        log.error('Connection failed rc=%d', rc)


def on_disconnect(client, userdata, rc):
    if rc != 0:
        log.warning('Disconnected (rc=%d), will auto-reconnect', rc)

# ── Heartbeat 執行緒 ──────────────────────────────────────────────────────────

def heartbeat_loop(client: mqtt.Client, interval: int = 30):
    import datetime
    while True:
        time.sleep(interval)
        payload = json.dumps({
            'node_id': NODE_ID,
            'ts':      datetime.datetime.utcnow().isoformat() + 'Z',
            'uptime':  time.monotonic(),
        })
        client.publish(TOPIC_HEARTBEAT, payload, qos=0)
        log.debug('Heartbeat sent')

# ── 主程式 ────────────────────────────────────────────────────────────────────

def main():
    log.info('HiBA-AB Edge Agent Runner starting...')
    log.info('NODE_ID=%s  BROKER=%s:%d', NODE_ID, BROKER, BROKER_PORT)
    log.info('WASM runtime: %s  timeout: %ds', IWASM_PATH, WASM_TIMEOUT)

    if not os.path.isfile(IWASM_PATH):
        log.error('iwasm not found at %s — run install steps first', IWASM_PATH)
        sys.exit(1)

    client = mqtt.Client(client_id=f'hiba-runner-{NODE_ID}')
    client.on_connect    = on_connect
    client.on_disconnect = on_disconnect
    client.on_message    = on_message

    client.connect(BROKER, BROKER_PORT, keepalive=60)

    # 心跳背景執行緒
    hb = threading.Thread(target=heartbeat_loop, args=(client,), daemon=True)
    hb.start()

    client.loop_forever()


if __name__ == '__main__':
    main()
