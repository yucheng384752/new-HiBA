#!/usr/bin/env bash
# =============================================================
# deploy_mqtt/00_setup.sh — MQTT + WASM 邊緣節點完整安裝腳本
#
# 整合步驟：
#   1. 系統更新與基礎套件
#   2. Python3 + paho-mqtt（MQTT client）
#   3. 下載 WAMR iwasm runtime（零編譯器原則）
#   4. 建立 /opt/hiba/ 目錄結構
#   5. 部署 runner.py + systemd 服務
#   6. 寫入 /etc/agent/env 環境變數
#   7. 啟動並確認服務
#   8. 發送首次 heartbeat 驗證
#
# 執行：sudo bash 00_setup.sh [NODE_ID] [BROKER_IP] [CLAW_URL]
# 範例：sudo bash 00_setup.sh m1 192.168.50.100 http://192.168.50.100:8080
#
# 與 HTTP 版本的差異：
#   ✗ 不安裝 Node.js / Express / SQLite
#   ✗ 不啟動 sub_web_server.js
#   ✓ 安裝 paho-mqtt + iwasm
#   ✓ 啟動 runner.py（MQTT subscriber + WASM executor）
# =============================================================
set -euo pipefail

NODE_ID="${1:-m1}"
BROKER="${2:-192.168.1.100}"
CLAW_URL="${3:-http://192.168.1.100:8080}"
BROKER_PORT="${BROKER_PORT:-1883}"
WASM_TIMEOUT="${WASM_TIMEOUT:-30}"

HIBA_ROOT="/opt/hiba"
AGENT_DIR="/opt/agent"
AGENT_ENV="/etc/agent/env"

# WAMR 版本鎖定（論文實驗環境固定版本）
WAMR_VERSION="2.1.2"
WAMR_BINARY="iwasm-${WAMR_VERSION}-linux-aarch64"
WAMR_URL="https://github.com/bytecodealliance/wasm-micro-runtime/releases/download/WAMR-${WAMR_VERSION}/${WAMR_BINARY}"
IWASM_PATH="/usr/local/bin/iwasm"

REAL_USER="${SUDO_USER:-${USER:-}}"
if [ -z "${REAL_USER}" ] || [ "${REAL_USER}" = "root" ]; then
  REAL_USER="$(logname 2>/dev/null || whoami)"
fi

echo "======================================"
echo " HiBA-AB MQTT Edge Agent 安裝"
echo " NODE_ID    : $NODE_ID"
echo " BROKER     : $BROKER:$BROKER_PORT"
echo " CLAW_URL   : $CLAW_URL"
echo " REAL_USER  : $REAL_USER"
echo " WAMR VER   : $WAMR_VERSION"
echo "======================================"

# ── 1. 系統更新 ───────────────────────────────────────────
echo "[1/8] 系統更新..."
apt-get update -q && apt-get upgrade -y -q

# ── 2. 安裝基礎套件 + paho-mqtt ───────────────────────────
echo "[2/8] 安裝 Python3 + paho-mqtt..."
apt-get install -y -q \
  curl wget python3 python3-pip \
  tpm2-tools openssl

# paho-mqtt：MQTT client（不需 broker，只需 client library）
python3 -m pip install paho-mqtt --break-system-packages --quiet
python3 -c "import paho.mqtt.client; print('  paho-mqtt', paho.mqtt.__version__, '✓')" 2>/dev/null || \
python3 -c "import paho.mqtt.client; print('  paho-mqtt ✓')"

# ── 3. 下載 WAMR iwasm ────────────────────────────────────
echo "[3/8] 下載 WAMR iwasm (${WAMR_VERSION})..."
if [ -f "${IWASM_PATH}" ]; then
  echo "  iwasm 已存在，跳過下載"
else
  # 嘗試從 GitHub release 下載，失敗時顯示手動指引
  if wget -q --timeout=60 "${WAMR_URL}" -O /tmp/${WAMR_BINARY}; then
    mv /tmp/${WAMR_BINARY} "${IWASM_PATH}"
    chmod +x "${IWASM_PATH}"
    echo "  iwasm ${WAMR_VERSION} 安裝 ✓ ($(${IWASM_PATH} --version 2>&1 | head -1))"
  else
    echo "  ⚠ 自動下載失敗，請手動安裝："
    echo "    wget ${WAMR_URL} -O ${IWASM_PATH}"
    echo "    chmod +x ${IWASM_PATH}"
    echo "  繼續安裝其餘步驟..."
  fi
fi

# ── 4. 建立目錄結構 ───────────────────────────────────────
echo "[4/8] 建立目錄結構..."
mkdir -p "${AGENT_DIR}" "${HIBA_ROOT}/tpm" "${HIBA_ROOT}/logs"
mkdir -p /etc/agent
chown -R "${REAL_USER}:${REAL_USER}" "${HIBA_ROOT}"
echo "  /opt/agent/ /opt/hiba/ /etc/agent/ ✓ (owner: ${REAL_USER})"

# ── 5. 部署 runner.py ─────────────────────────────────────
echo "[5/8] 部署 runner.py..."
RUNNER_SRC="$(dirname "$0")/runner.py"
if [ -f "${RUNNER_SRC}" ]; then
  cp "${RUNNER_SRC}" "${AGENT_DIR}/runner.py"
  chmod 755 "${AGENT_DIR}/runner.py"
  echo "  runner.py ✓"
else
  echo "  ⚠ 找不到 runner.py，請手動複製至${AGENT_DIR}"
fi

# ── 6. 寫入 /etc/agent/env ───────────────────────────────
echo "[6/8] 寫入環境變數..."
cat > "${AGENT_ENV}" <<EOF
NODE_ID=${NODE_ID}
BROKER=${BROKER}
BROKER_PORT=${BROKER_PORT}
CLAW_URL=${CLAW_URL}
IWASM_PATH=${IWASM_PATH}
WASM_TIMEOUT=${WASM_TIMEOUT}
EOF
chmod 640 "${AGENT_ENV}"
echo "  ${AGENT_ENV} ✓"

# ── 7. 設定 systemd 服務 ──────────────────────────────────
echo "[7/8] 設定 systemd 服務..."
SERVICE_SRC="$(dirname "$0")/agent-runner.service"
if [ -f "${SERVICE_SRC}" ]; then
  cp "${SERVICE_SRC}" /etc/systemd/system/agent-runner.service
else
  # 內嵌 service unit（備援方案）
  cat > /etc/systemd/system/agent-runner.service <<SVCEOF
[Unit]
Description=HiBA-AB MQTT Edge Agent Runner (${NODE_ID})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${AGENT_ENV}
ExecStart=/usr/bin/python3 ${AGENT_DIR}/runner.py
WorkingDirectory=${AGENT_DIR}
Restart=always
RestartSec=5
StandardOutput=append:${HIBA_ROOT}/logs/agent-runner.log
StandardError=append:${HIBA_ROOT}/logs/agent-runner-err.log
MemoryMax=256M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
SVCEOF
fi

systemctl daemon-reload
systemctl enable agent-runner
systemctl start  agent-runner
sleep 2

if systemctl is-active --quiet agent-runner; then
  echo "  agent-runner.service running ✓"
else
  echo "  ✗ 服務啟動失敗，查看日誌："
  journalctl -u agent-runner -n 20 --no-pager
fi

# ── 8. 首次 heartbeat 驗證 ────────────────────────────────
echo "[8/8] 驗證 MQTT 連線..."
python3 -c "
import paho.mqtt.client as mqtt, json, time, sys, os

broker   = os.environ.get('BROKER', '${BROKER}')
port     = int(os.environ.get('BROKER_PORT', '${BROKER_PORT}'))
node_id  = '${NODE_ID}'
ok       = False

def on_connect(c, u, f, rc):
    global ok
    if rc == 0:
        ok = True
        print(f'  broker 連線成功 ({broker}:{port}) ✓')
        c.publish(f'heartbeat/{node_id}', json.dumps({'node_id': node_id, 'test': True}))
        c.disconnect()
    else:
        print(f'  broker 連線失敗 rc={rc}')
        c.disconnect()

c = mqtt.Client()
c.on_connect = on_connect
try:
    c.connect(broker, port, keepalive=5)
    c.loop_start()
    time.sleep(3)
    c.loop_stop()
except Exception as e:
    print(f'  ⚠ 無法連線 broker: {e}')
    print(f'  請確認 Mosquitto 已在 {broker}:{port} 啟動')
    sys.exit(0)  # 非致命，繼續完成安裝
" 2>/dev/null || echo "  ⚠ heartbeat 驗證跳過（Python 執行錯誤）"

# ── 完成摘要 ──────────────────────────────────────────────
echo ""
echo "======================================"
echo " ✓ MQTT Edge Agent 安裝完成"
echo ""
echo "  服務："
systemctl is-active agent-runner && echo "    agent-runner : running ✓" || echo "    agent-runner : FAILED ✗"
echo ""
echo "  訂閱 topic   : tasks/${NODE_ID}"
echo "  發布 topic   : results/{job_id}"
echo "  Heartbeat    : heartbeat/${NODE_ID} (每 30s)"
echo ""
echo "  常用指令："
echo "    systemctl status agent-runner             # 查看狀態"
echo "    journalctl -u agent-runner -f             # 即時日誌"
echo "    tail -f ${HIBA_ROOT}/logs/agent-runner.log  # 日誌檔"
echo ""
echo "  下一步（選用）："
echo "    sudo bash 01_tpm_init.sh                  # TPM 金鑰初始化"
echo "======================================"
