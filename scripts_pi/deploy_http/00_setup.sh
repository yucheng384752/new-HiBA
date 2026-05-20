#!/usr/bin/env bash
# =============================================================
# deploy_http/00_setup.sh — HTTP Sub-Web 節點完整安裝腳本
#
# 整合步驟：
#   1. 系統更新與基礎套件
#   2. Node.js 20 (NodeSource，避免衝突)
#   3. 建立 /opt/hiba/ 目錄結構
#   4. 部署 sub_web_server.js + npm install
#   5. 寫入 .env 環境變數
#   6. 設定 systemd 服務 (開機自啟)
#   7. 健康確認 (localhost /health、/scripts)
#   8. 向 Claw 主控端登錄節點
#   9. NTP 時鐘同步
#
# 執行：sudo bash 00_setup.sh [NODE_ID] [CLAW_URL]
# 範例：sudo bash 00_setup.sh m1 http://192.168.50.100:9090
# =============================================================
set -euo pipefail

NODE_ID="${1:-m1}"
CLAW_URL="${2:-http://192.168.1.100:8080}"

HIBA_ROOT="/opt/hiba"
SUBWEB_DIR="${HIBA_ROOT}/subweb"
SCRIPTS_DIR="${HIBA_ROOT}/scripts"
DATA_DIR="${HIBA_ROOT}/data"

# 動態取得實際使用者（sudo 執行時 $SUDO_USER 為原始帳號）
REAL_USER="${SUDO_USER:-${USER:-}}"
if [ -z "${REAL_USER}" ] || [ "${REAL_USER}" = "root" ]; then
  REAL_USER="$(logname 2>/dev/null || whoami)"
fi

echo "======================================"
echo " HiBA-AB HTTP Sub-Web 節點安裝"
echo " NODE_ID   : $NODE_ID"
echo " CLAW_URL  : $CLAW_URL"
echo " REAL_USER : ${REAL_USER}"
echo "======================================"

# ── 1. 系統更新 ───────────────────────────────────────────
echo "[1/9] 系統更新..."
apt-get update -q && apt-get upgrade -y -q

# ── 2. 安裝基礎套件 ───────────────────────────────────────
echo "[2/9] 安裝基礎套件..."
apt-get install -y -q \
  curl wget git jq sqlite3 \
  python3 python3-pip python3-venv \
  tpm2-tools openssl

# ── 3. 安裝 Node.js 20 (NodeSource，無衝突) ───────────────
# 必須先移除 Raspberry Pi OS 內建版本，避免版本互斥
echo "[3/9] 安裝 Node.js 20 (NodeSource)..."
apt-get remove -y --purge nodejs npm node-gyp 2>/dev/null || true
apt-get autoremove -y -q 2>/dev/null || true
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
echo "  Node: $(node --version)  npm: $(npm --version)"

# ── 4. 建立目錄結構 + sudoers ─────────────────────────────
echo "[4/9] 建立目錄結構..."
mkdir -p "${SUBWEB_DIR}" "${SCRIPTS_DIR}" "${DATA_DIR}" \
         "${HIBA_ROOT}/tpm" "${HIBA_ROOT}/logs"
chown -R "${REAL_USER}:${REAL_USER}" "${HIBA_ROOT}"
echo "  subweb/ scripts/ data/ tpm/ logs/ ✓ (owner: ${REAL_USER})"

# sudoers：允許程序自動重啟服務（遠端 deploy 後無需 SSH）
SUDOERS_FILE="/etc/sudoers.d/hiba-subweb"
cat > "${SUDOERS_FILE}" <<EOF
# HiBA-AB: allow ${REAL_USER} to restart hiba-subweb without password
${REAL_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart hiba-subweb
${REAL_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop hiba-subweb
${REAL_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl start hiba-subweb
EOF
chmod 440 "${SUDOERS_FILE}"
echo "  sudoers ✓ (${SUDOERS_FILE})"

# ── 5. 部署 sub_web_server.js + 腳本 + 資料 ──────────────
echo "[5/9] 部署 Sub-Web 伺服器..."
DEPLOY_DIR="$(dirname "$0")"

# sub_web_server.js
if [ -f "${DEPLOY_DIR}/sub_web_server.js" ]; then
  cp "${DEPLOY_DIR}/sub_web_server.js" "${SUBWEB_DIR}/sub_web_server.js"
  echo "  sub_web_server.js ✓"
else
  echo "  ⚠ 找不到 sub_web_server.js，請手動複製至 ${SUBWEB_DIR}"
fi

# package.json
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
echo "  npm install ✓"

# Python 腳本（從 deploy_http/scripts/ 子目錄複製）
SCRIPTS_SRC="${DEPLOY_DIR}/scripts"
if [ -d "${SCRIPTS_SRC}" ]; then
  cp -r "${SCRIPTS_SRC}/." "${SCRIPTS_DIR}/"
  SCRIPT_COUNT=$(ls "${SCRIPTS_DIR}"/*.py 2>/dev/null | wc -l)
  echo "  腳本複製 ✓ (${SCRIPT_COUNT} 個 .py)"
else
  echo "  ⚠ 未找到 scripts/ 子目錄，稍後手動複製 .py 與 manifest.json 至 ${SCRIPTS_DIR}"
fi

# 資料檔案（從 deploy_http/data/ 子目錄複製）
DATA_SRC="${DEPLOY_DIR}/data"
if [ -d "${DATA_SRC}" ]; then
  cp -r "${DATA_SRC}/." "${DATA_DIR}/"
  DATA_COUNT=$(ls "${DATA_DIR}"/*.json 2>/dev/null | wc -l)
  echo "  資料檔案複製 ✓ (${DATA_COUNT} 個 .json)"
else
  echo "  ⚠ 未找到 data/ 子目錄，稍後手動複製 data_*.json 至 ${DATA_DIR}"
fi

# manifest.json 初始化（若不存在，表示 scripts/ 子目錄未帶入）
MANIFEST_PATH="${SCRIPTS_DIR}/manifest.json"
if [ ! -f "${MANIFEST_PATH}" ]; then
  echo "[]" > "${MANIFEST_PATH}"
  echo "  manifest.json 初始化為空陣列（稍後請部署腳本）"
fi

# ── 6. 寫入 .env ──────────────────────────────────────────
echo "[6/9] 寫入 .env..."
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

# ── 7. 設定 systemd 服務 ──────────────────────────────────
echo "[7/9] 設定 systemd 服務..."
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
systemctl restart hiba-subweb   # restart（非 start）確保重讀 .env
sleep 2

if systemctl is-active --quiet hiba-subweb; then
  echo "  hiba-subweb.service running ✓"
else
  echo "  ✗ 服務啟動失敗，查看日誌："
  journalctl -u hiba-subweb -n 20 --no-pager
fi

# ── 8. 健康確認 + 節點登錄 ───────────────────────────────
echo "[8/9] 健康確認..."
sleep 1
HEALTH=$(curl -sf http://localhost:3000/health 2>/dev/null) || true
if [ -n "${HEALTH}" ]; then
  echo "  /health OK ✓"
  echo "${HEALTH}" | python3 -m json.tool 2>/dev/null || echo "  ${HEALTH}"
else
  echo "  ⚠ /health 無回應，稍後確認：curl http://localhost:3000/health"
fi

echo ""
SELF_IP=$(hostname -I | awk '{print $1}')
SELF_URL="http://${SELF_IP}:3000"
echo "  節點 URL：${SELF_URL}"
echo "  ⓘ 節點登錄請至 Claw Dashboard → Add Node 輸入上方 URL"
echo "    （/api/nodes/register 端點未實作，自動登錄已停用）"

# ── 9. NTP 時鐘同步 ───────────────────────────────────────
echo "[9/9] NTP 時鐘同步..."
timedatectl set-ntp true
sleep 2
SYNC_STATUS=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo "unknown")
if [ "${SYNC_STATUS}" = "yes" ]; then
  echo "  NTP 已同步 ✓"
else
  echo "  NTP 啟用中（初次同步可能需數秒至數分鐘）"
fi
timedatectl status | grep -E "Local time|NTP service|synchronized" || true

# ── 完成摘要 ──────────────────────────────────────────────
echo ""
echo "======================================"
echo " ✓ HTTP Sub-Web 安裝完成"
echo ""
echo "  目錄："
echo "    Sub-Web  : ${SUBWEB_DIR}"
echo "    Scripts  : ${SCRIPTS_DIR}"
echo "    Data     : ${DATA_DIR}"
echo "    Logs     : ${HIBA_ROOT}/logs"
echo ""
echo "  服務："
systemctl is-active hiba-subweb && echo "    hiba-subweb : running ✓" || echo "    hiba-subweb : FAILED ✗"
echo ""
echo "  常用指令："
echo "    systemctl status hiba-subweb       # 查看狀態"
echo "    journalctl -u hiba-subweb -f       # 即時日誌"
echo "    curl http://localhost:3000/health  # 健康確認"
echo ""
echo "  下一步（擇一）："
echo "    方法 A（推薦）— ?node= 自動加入，在 Windows 瀏覽器網址列輸入："
echo "    file:///C:/Users/gslab/Desktop/files/scripts_pi/claw-dashboard.html?node=http://${SELF_IP}:3000"
echo ""
echo "    方法 B — 手動加入："
echo "    1. 開啟 claw-dashboard.html"
echo "    2. Add Node 欄位輸入：http://${SELF_IP}:3000"
echo ""
echo "    （選用）sudo bash 01_tpm_init.sh  # TPM 金鑰初始化"
echo "======================================"
