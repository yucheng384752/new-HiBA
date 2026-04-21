#!/usr/bin/env bash
# =============================================================
# 00_setup.sh — Raspberry Pi 環境初始化
# 執行：sudo bash 00_setup.sh [NODE_ID] [CLAW_URL]
# 範例：sudo bash 00_setup.sh m1 http://192.168.50.100:8080
# =============================================================
set -euo pipefail

NODE_ID="${1:-m1}"
CLAW_URL="${2:-http://192.168.1.100:8080}"
HIBA_ROOT="/opt/hiba"
SUBWEB_DIR="${HIBA_ROOT}/subweb"
SCRIPTS_DIR="${HIBA_ROOT}/scripts"
DATA_DIR="${HIBA_ROOT}/data"

# 動態取得實際使用者（sudo bash 執行時 $SUDO_USER 為原始帳號）
# fallback 順序：$SUDO_USER → $USER → logname → whoami
REAL_USER="${SUDO_USER:-${USER:-}}"
if [ -z "${REAL_USER}" ] || [ "${REAL_USER}" = "root" ]; then
  REAL_USER="$(logname 2>/dev/null || whoami)"
fi

echo "======================================"
echo " HiBA-AB Pi 環境初始化"
echo " NODE_ID   : $NODE_ID"
echo " CLAW_URL  : $CLAW_URL"
echo " REAL_USER : ${REAL_USER}"
echo "======================================"

# ── 1. 系統更新 ───────────────────────────────────────────
echo "[1/8] 系統更新..."
apt-get update -q && apt-get upgrade -y -q

# ── 2. 安裝基礎套件（不含 nodejs/npm，由 NodeSource 統一提供）──
echo "[2/8] 安裝基礎套件..."
apt-get install -y -q \
  curl wget git jq sqlite3 \
  python3 python3-pip python3-venv \
  tpm2-tools

# ── 3. 安裝 Node.js 20 (LTS) via NodeSource ───────────────
# 衝突原因：Raspberry Pi OS 內建的 nodejs/npm 套件與 NodeSource
# 版本互斥。解法：先完整移除系統版，再由 NodeSource 一次安裝
# （NodeSource 的 nodejs 已內含 npm，不需另裝）
echo "[3/8] 安裝 Node.js 20 (NodeSource)..."
# 移除可能造成衝突的系統版套件
apt-get remove -y --purge nodejs npm node-gyp 2>/dev/null || true
apt-get autoremove -y -q 2>/dev/null || true
# 安裝 NodeSource v20（自帶 npm，無衝突）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
echo "Node: $(node --version), npm: $(npm --version)"

# ── 4. 建立目錄結構 ───────────────────────────────────────
echo "[4/8] 建立目錄結構..."
# data/ 為 Deploy File 模式的目標目錄，必須存在
mkdir -p "${SUBWEB_DIR}" "${SCRIPTS_DIR}" "${DATA_DIR}" \
         "${HIBA_ROOT}/tpm" "${HIBA_ROOT}/logs"
chown -R "${REAL_USER}:${REAL_USER}" "${HIBA_ROOT}"
echo "  目錄：subweb/ scripts/ data/ tpm/ logs/ ✓（owner: ${REAL_USER}）"

# ── 5. 部署 sub_web_server.js 並安裝 Node 依賴 ───────────
echo "[5/8] 部署 Sub-Web 伺服器..."
# 若執行目錄有 sub_web_server.js，複製過去；否則跳過（手動複製）
SCRIPT_SRC="$(dirname "$0")/sub_web_server.js"
if [ -f "${SCRIPT_SRC}" ]; then
  cp "${SCRIPT_SRC}" "${SUBWEB_DIR}/sub_web_server.js"
  echo "  sub_web_server.js 已複製至 ${SUBWEB_DIR}"
else
  echo "  ⚠ 找不到 sub_web_server.js，請手動複製至 ${SUBWEB_DIR}"
fi

# package.json（讓 npm install 知道要裝什麼）
cat > "${SUBWEB_DIR}/package.json" <<'PKGJSON'
{
  "name": "hiba-subweb",
  "version": "1.0.0",
  "main": "sub_web_server.js",
  "scripts": { "start": "node sub_web_server.js" },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^9.4.3"
  }
}
PKGJSON

cd "${SUBWEB_DIR}"
npm install --omit=dev --silent
echo "  npm install 完成 ✓"

# ── 6. 寫入環境變數 ───────────────────────────────────────
echo "[6/8] 寫入 .env..."
cat > "${SUBWEB_DIR}/.env" <<EOF
NODE_ID=${NODE_ID}
CLAW_URL=${CLAW_URL}
SCRIPTS_DIR=${SCRIPTS_DIR}
DATA_DIR=${DATA_DIR}
AUDIT_DB=${SUBWEB_DIR}/audit_trail.db
TPM_HANDLE=0x81000001
PORT=3000
LOG_DIR=${HIBA_ROOT}/logs
EOF

# ── 7. 設定 systemd 服務（開機自啟）──────────────────────
echo "[7/8] 設定 systemd 服務..."
cat > /etc/systemd/system/hiba-subweb.service <<EOF
[Unit]
Description=HiBA-AB Sub-Web Server (${NODE_ID})
After=network.target

[Service]
Type=simple
User=${REAL_USER}
WorkingDirectory=${SUBWEB_DIR}
EnvironmentFile=${SUBWEB_DIR}/.env
ExecStart=/usr/bin/node ${SUBWEB_DIR}/sub_web_server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:${HIBA_ROOT}/logs/subweb.log
StandardError=append:${HIBA_ROOT}/logs/subweb-err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hiba-subweb
systemctl start  hiba-subweb
echo "  hiba-subweb.service 已啟動 ✓"

# ── 8. 設定 hostname ──────────────────────────────────────
echo "[8/8] 設定 hostname → hiba-${NODE_ID}..."
hostnamectl set-hostname "hiba-${NODE_ID}"

echo ""
echo "======================================"
echo "✓ 環境初始化完成"
echo ""
echo "  目錄配置："
echo "    Sub-Web  : ${SUBWEB_DIR}"
echo "    Scripts  : ${SCRIPTS_DIR}"
echo "    Data     : ${DATA_DIR}          ← Deploy File 模式目標"
echo "    AuditDB  : ${SUBWEB_DIR}/audit_trail.db"
echo "    Logs     : ${HIBA_ROOT}/logs"
echo ""
echo "  服務狀態："
systemctl is-active hiba-subweb && echo "    hiba-subweb : running ✓" || echo "    hiba-subweb : FAILED ✗"
echo ""
echo "  下一步："
echo "    sudo bash 01_tpm_init.sh"
echo "    # 驗證：curl http://localhost:3000/health"
echo "======================================"
