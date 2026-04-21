#!/usr/bin/env bash
# =============================================================
# 03_subweb_start.sh — 註冊為 systemd 服務並啟動
# 執行：sudo bash 03_subweb_start.sh
# =============================================================
set -euo pipefail

SUBWEB_DIR="/opt/hiba/subweb"

echo "[systemd] 建立服務..."
cat > /etc/systemd/system/hiba-subweb.service <<EOF
[Unit]
Description=HiBA-AB Sub-Web Node
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=${SUBWEB_DIR}
ExecStart=/usr/bin/node ${SUBWEB_DIR}/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=${SUBWEB_DIR}/.env
StandardOutput=append:/opt/hiba/logs/subweb.log
StandardError=append:/opt/hiba/logs/subweb-err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hiba-subweb
systemctl restart hiba-subweb

sleep 2
STATUS=$(systemctl is-active hiba-subweb)
if [ "$STATUS" = "active" ]; then
  echo "✓ hiba-subweb 服務已啟動"
  curl -s http://localhost:3000/health | python3 -m json.tool
else
  echo "✗ 啟動失敗，查看日誌："
  journalctl -u hiba-subweb -n 20
fi

echo ""
echo "常用指令："
echo "  systemctl status hiba-subweb    # 查看狀態"
echo "  journalctl -u hiba-subweb -f    # 即時日誌"
echo "  systemctl restart hiba-subweb   # 重啟"
